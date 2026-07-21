import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/database.js'
import { calculateTotals, canTransition, dateInSeoul, normalizePhone, validateOrder } from '../lib/orders.js'

test('전화번호는 숫자만 남긴다', () => {
  assert.equal(normalizePhone('010-1234-5678'), '01012345678')
})

test('임시 주문은 빈 필드를 허용하지만 접수 완료 전환은 필수 필드를 요구한다', () => {
  assert.deepEqual(validateOrder({}, { requireComplete: false }), [])
  assert.equal(validateOrder({ items: [] }, { requireComplete: true }).length > 0, true)
})

test('주문 등록은 필수 정보가 없으면 임시 주문도 만들지 않는다', async () => {
  const store = createStore(':memory:')
  await assert.rejects(() => store.createOrder({ registerNow: true, items: [] }), /주문자 이름/)
  assert.equal(store.listOrders().length, 0)
  store.close()
})

test('오늘 발송은 한국 시간을 기준으로 계산한다', () => {
  assert.equal(dateInSeoul('2026-07-21T15:30:00.000Z'), '2026-07-22')
})

test('택배비는 상자 두 개당 6,000원으로 계산한다', () => {
  assert.equal(calculateTotals([{ quantity: 1, unitPrice: 22000 }]).shippingFee, 6000)
  assert.equal(calculateTotals([{ quantity: 2, unitPrice: 22000 }]).shippingFee, 6000)
  assert.equal(calculateTotals([{ quantity: 3, unitPrice: 22000 }]).shippingFee, 12000)
  assert.equal(calculateTotals([{ quantity: 4, unitPrice: 22000 }]).shippingFee, 12000)
  assert.equal(calculateTotals([{ quantity: 3, unitPrice: 22000 }], 9000).shippingFee, 9000)
})

test('입금 완료 전에는 포장 준비로 바꿀 수 없다', () => {
  const result = canTransition({ recordStatus: 'ready', paymentStatus: 'unconfirmed', shippingStatus: 'not_ready' }, 'prepare')
  assert.equal(result.ok, false)
})

test('발송 완료 주문은 포장 준비로 되돌릴 수 없다', () => {
  const result = canTransition({ recordStatus: 'ready', paymentStatus: 'paid', shippingStatus: 'shipped' }, 'prepare')
  assert.equal(result.ok, false)
})

test('임시 저장 및 확인 필요 체크 주문은 확인할 사항에 표시된다', async () => {
  const store = createStore(':memory:')
  const draft = await store.createOrder({ items: [] })
  assert.equal(store.dashboard().needsReview.length, 1)

  const complete = await store.createOrder({
    customerName: '이복순', phone: '010-1234-5678', address: '경기 성남시',
    items: [{ grade: 'normal', quantity: 1, unitPrice: 22000 }],
  })
  const ready = await store.transitionOrder(complete.id, 'ready', complete.version)
  const marked = await store.updateOrder(ready.id, { needsReview: true, reviewNote: '특 2상자 추가' }, ready.version)
  assert.equal(marked.needsReview, true)
  assert.equal(marked.reviewNote, '특 2상자 추가')
  assert.deepEqual(store.dashboard().needsReview.map((order) => order.id).sort(), [draft.id, marked.id].sort())
  store.close()
})

test('접수 완료 전 주문 정보와 상품 수량을 수정할 수 있다', async () => {
  const store = createStore(':memory:')
  const order = await store.createOrder({
    registerNow: true,
    customerName: '이복순', phone: '010-1234-5678', address: '경기 성남시',
    items: [{ grade: 'normal', quantity: 1, unitPrice: 22000 }],
  })
  const updated = await store.updateOrder(order.id, {
    customerName: '이복순', phone: '010-1234-5678', address: '경기 용인시', notes: '특 3상자', shippingFee: 9000,
    items: [{ grade: 'special', quantity: 3, unitPrice: 27000 }],
  }, order.version)
  assert.equal(updated.address, '경기 용인시')
  assert.deepEqual(updated.items, [{ grade: 'special', quantity: 3, unitPrice: 27000 }])
  assert.equal(updated.grandTotal, 90000)
  store.close()
})

test('주문은 임시 등록부터 발송 완료까지 상태 전환을 기록한다', async () => {
  const store = createStore(':memory:')
  const order = await store.createOrder({
    customerName: '김민지', phone: '010-1234-5678', address: '경기 성남시', shippingFee: 4000,
    items: [{ grade: 'special', quantity: 2, unitPrice: 25000 }],
  })
  const ready = await store.transitionOrder(order.id, 'ready', order.version)
  const paid = await store.transitionOrder(ready.id, 'paid', ready.version)
  const preparing = await store.transitionOrder(paid.id, 'prepare', paid.version)
  const tracked = await store.transitionOrder(preparing.id, 'tracking', preparing.version, '1234-5678')
  const shipped = await store.transitionOrder(tracked.id, 'shipped', tracked.version)
  assert.equal(shipped.shippingStatus, 'shipped')
  assert.equal(shipped.grandTotal, 54000)
  assert.equal(store.history(order.id).length, 6)
  store.close()
})

test('오래된 버전으로 저장하면 충돌 오류를 낸다', async () => {
  const store = createStore(':memory:')
  const order = await store.createOrder({ items: [] })
  await store.updateOrder(order.id, { items: [], shippingFee: 0 }, order.version)
  await assert.rejects(() => store.updateOrder(order.id, { items: [], shippingFee: 0 }, order.version), /다른 창/)
  store.close()
})

test('로컬 주문 변경은 하루 단위 자동 백업을 만든다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peach-ledger-test-'))
  const store = createStore(path.join(directory, 'orders.db'))
  await store.createOrder({ items: [] })
  const backups = fs.readdirSync(path.join(directory, 'backups'))
  assert.equal(backups.some((file) => /^peach-orders-\d{4}-\d{2}-\d{2}\.db$/.test(file)), true)
  store.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('백업 실패 후에도 저장된 주문은 성공으로 처리한다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peach-ledger-test-'))
  const backupTarget = path.join(directory, 'backups', `peach-orders-${dateInSeoul()}.db`)
  fs.mkdirSync(backupTarget, { recursive: true })
  const store = createStore(path.join(directory, 'orders.db'))
  const originalConsoleError = console.error
  const errors = []
  console.error = (message) => errors.push(message)

  try {
    await store.createOrder({ items: [] })
    assert.equal(store.listOrders().length, 1)
    assert.match(errors[0], /주문 데이터 백업에 실패했습니다/)
  } finally {
    console.error = originalConsoleError
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
