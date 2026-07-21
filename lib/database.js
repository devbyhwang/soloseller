import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {
  calculateTotals,
  canTransition,
  dateInSeoul,
  normalizePhone,
  validateOrder,
} from './orders.js'

function now() {
  return new Date().toISOString()
}

function createSchema(db) {
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_status TEXT NOT NULL DEFAULT 'draft',
      payment_status TEXT NOT NULL DEFAULT 'unconfirmed',
      shipping_status TEXT NOT NULL DEFAULT 'not_ready',
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      normalized_phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      shipping_fee INTEGER NOT NULL DEFAULT 0,
      product_total INTEGER NOT NULL DEFAULT 0,
      grand_total INTEGER NOT NULL DEFAULT 0,
      tracking_number TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      needs_review INTEGER NOT NULL DEFAULT 0,
      review_note TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      shipped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      grade TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      from_value TEXT NOT NULL DEFAULT '',
      to_value TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS orders_state_index ON orders(record_status, payment_status, shipping_status);
    CREATE INDEX IF NOT EXISTS orders_updated_index ON orders(updated_at DESC);
  `)

  const columns = new Set(db.prepare('PRAGMA table_info(orders)').all().map((column) => column.name))
  if (!columns.has('needs_review')) db.exec("ALTER TABLE orders ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0")
  if (!columns.has('review_note')) db.exec("ALTER TABLE orders ADD COLUMN review_note TEXT NOT NULL DEFAULT ''")
}

function withItems(db, order) {
  if (!order) return null
  const items = db.prepare('SELECT grade, quantity, unit_price AS unitPrice FROM order_items WHERE order_id = ? ORDER BY id').all(order.id)
  return {
    ...order,
    recordStatus: order.record_status,
    paymentStatus: order.payment_status,
    shippingStatus: order.shipping_status,
    customerName: order.customer_name,
    trackingNumber: order.tracking_number,
    needsReview: Boolean(order.needs_review),
    reviewNote: order.review_note,
    shippingFee: order.shipping_fee,
    productTotal: order.product_total,
    grandTotal: order.grand_total,
    items,
  }
}

function writeHistory(db, orderId, fieldName, fromValue, toValue, reason = '') {
  db.prepare(`INSERT INTO order_history (order_id, field_name, from_value, to_value, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(orderId, fieldName, String(fromValue ?? ''), String(toValue ?? ''), reason, now())
}

function createBackupWriter(db, filename) {
  if (filename === ':memory:') return async () => {}

  const backupDirectory = path.join(path.dirname(filename), 'backups')
  let queue = Promise.resolve()

  return function writeBackup() {
    queue = queue.catch(() => {}).then(async () => {
      fs.mkdirSync(backupDirectory, { recursive: true })
      const day = dateInSeoul()
      const destination = path.join(backupDirectory, `peach-orders-${day}.db`)
      await db.backup(destination)

      const snapshots = fs.readdirSync(backupDirectory)
        .filter((file) => /^peach-orders-\d{4}-\d{2}-\d{2}\.db$/.test(file))
        .sort()
        .reverse()
      for (const staleSnapshot of snapshots.slice(14)) {
        fs.unlinkSync(path.join(backupDirectory, staleSnapshot))
      }
    })
    return queue
  }
}

export function createStore(filename = path.join(process.cwd(), 'data', 'peach-orders.db')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
  const db = new Database(filename)
  db.pragma('foreign_keys = ON')
  createSchema(db)
  const writeBackup = createBackupWriter(db, filename)
  const backupAfterMutation = async () => {
    try {
      await writeBackup()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`주문 데이터 백업에 실패했습니다: ${message}`)
    }
  }

  const getRaw = db.prepare('SELECT * FROM orders WHERE id = ?')
  const getOrder = (id) => withItems(db, getRaw.get(id))

  const createOrder = db.transaction((payload) => {
    const items = Array.isArray(payload.items) ? payload.items : []
    const registerNow = payload.registerNow === true
    const errors = validateOrder({ ...payload, items }, { requireComplete: registerNow })
    if (errors.length) throw new Error(errors.join(' '))
    const { productTotal, shippingFee, grandTotal } = calculateTotals(items, payload.shippingFee)
    const timestamp = now()
    const result = db.prepare(`INSERT INTO orders (
      record_status, customer_name, phone, normalized_phone, address, shipping_fee, product_total, grand_total, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        registerNow ? 'ready' : 'draft',
        payload.customerName?.trim() || '',
        payload.phone?.trim() || '',
        normalizePhone(payload.phone),
        payload.address?.trim() || '',
        shippingFee,
        productTotal,
        grandTotal,
        payload.notes?.trim() || '',
        timestamp,
        timestamp,
      )
    const orderId = Number(result.lastInsertRowid)
    const insertItem = db.prepare('INSERT INTO order_items (order_id, grade, quantity, unit_price) VALUES (?, ?, ?, ?)')
    for (const item of items) {
      insertItem.run(orderId, item.grade, Number(item.quantity), Number(item.unitPrice))
    }
    writeHistory(db, orderId, 'record_status', '', registerNow ? 'ready' : 'draft', registerNow ? '주문 등록' : '임시 등록')
    return getOrder(orderId)
  })

  const updateOrder = db.transaction((id, payload, version) => {
    const existing = getOrder(id)
    if (!existing) throw new Error('주문을 찾을 수 없습니다.')
    if (existing.version !== version) throw new Error('다른 창에서 주문이 수정되었습니다. 새로고침 후 다시 시도해 주세요.')

    const items = Array.isArray(payload.items) ? payload.items : existing.items
    const errors = validateOrder({
      customerName: payload.customerName ?? existing.customerName,
      phone: payload.phone ?? existing.phone,
      address: payload.address ?? existing.address,
      items,
    }, { requireComplete: existing.recordStatus === 'ready' })
    if (errors.length) throw new Error(errors.join(' '))
    const totals = calculateTotals(items, payload.shippingFee ?? existing.shippingFee)
    const timestamp = now()
    const needsReview = typeof payload.needsReview === 'boolean' ? Number(payload.needsReview) : Number(existing.needsReview)
    const reviewNote = payload.reviewNote?.trim() ?? existing.reviewNote
    db.prepare(`UPDATE orders SET customer_name = ?, phone = ?, normalized_phone = ?, address = ?, shipping_fee = ?,
      product_total = ?, grand_total = ?, notes = ?, needs_review = ?, review_note = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(
        payload.customerName?.trim() ?? existing.customerName,
        payload.phone?.trim() ?? existing.phone,
        normalizePhone(payload.phone ?? existing.phone),
        payload.address?.trim() ?? existing.address,
        totals.shippingFee,
        totals.productTotal,
        totals.grandTotal,
        payload.notes?.trim() ?? existing.notes,
        needsReview,
        reviewNote,
        timestamp,
        id,
      )
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id)
    const insertItem = db.prepare('INSERT INTO order_items (order_id, grade, quantity, unit_price) VALUES (?, ?, ?, ?)')
    for (const item of items) insertItem.run(id, item.grade, Number(item.quantity), Number(item.unitPrice))
    if (existing.needsReview !== Boolean(needsReview) || existing.reviewNote !== reviewNote) {
      writeHistory(db, id, 'needs_review', existing.needsReview ? 'checked' : 'unchecked', needsReview ? 'checked' : 'unchecked', reviewNote || '확인할 사항 변경')
    }
    writeHistory(db, id, 'order', 'saved', 'saved', '주문 정보 수정')
    return getOrder(id)
  })

  const transitionOrder = db.transaction((id, transition, version, trackingNumber = '') => {
    const order = getOrder(id)
    if (!order) throw new Error('주문을 찾을 수 없습니다.')
    if (order.version !== version) throw new Error('다른 창에서 주문이 수정되었습니다. 새로고침 후 다시 시도해 주세요.')
    const transitionCheck = canTransition(order, transition, trackingNumber)
    if (!transitionCheck.ok) throw new Error(transitionCheck.message)
    if (transition === 'ready') {
      const errors = validateOrder(order, { requireComplete: true })
      if (errors.length) throw new Error(errors.join(' '))
      db.prepare(`UPDATE orders SET record_status = 'ready', updated_at = ?, version = version + 1 WHERE id = ?`).run(now(), id)
      writeHistory(db, id, 'record_status', 'draft', 'ready', '필수 정보 확인')
    }
    if (transition === 'paid') {
      db.prepare(`UPDATE orders SET payment_status = 'paid', paid_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now(), now(), id)
      writeHistory(db, id, 'payment_status', order.paymentStatus, 'paid', '입금 확인')
    }
    if (transition === 'prepare') {
      db.prepare(`UPDATE orders SET shipping_status = 'preparing', updated_at = ?, version = version + 1 WHERE id = ?`).run(now(), id)
      writeHistory(db, id, 'shipping_status', order.shippingStatus, 'preparing', '포장 준비')
    }
    if (transition === 'tracking') {
      db.prepare(`UPDATE orders SET shipping_status = 'tracking_entered', tracking_number = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(trackingNumber.trim(), now(), id)
      writeHistory(db, id, 'shipping_status', order.shippingStatus, 'tracking_entered', '운송장 등록')
    }
    if (transition === 'shipped') {
      db.prepare(`UPDATE orders SET shipping_status = 'shipped', shipped_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now(), now(), id)
      writeHistory(db, id, 'shipping_status', order.shippingStatus, 'shipped', '발송 완료')
    }
    if (transition === 'cancel') {
      db.prepare(`UPDATE orders SET record_status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?`).run(now(), id)
      writeHistory(db, id, 'record_status', order.recordStatus, 'cancelled', '주문 취소')
    }
    return getOrder(id)
  })

  return {
    async createOrder(payload) {
      const order = createOrder(payload)
      await backupAfterMutation()
      return order
    },
    async updateOrder(id, payload, version) {
      const order = updateOrder(id, payload, version)
      await backupAfterMutation()
      return order
    },
    async transitionOrder(id, transition, version, trackingNumber = '') {
      const order = transitionOrder(id, transition, version, trackingNumber)
      await backupAfterMutation()
      return order
    },
    getOrder,
    listOrders() {
      return db.prepare('SELECT * FROM orders ORDER BY updated_at DESC').all().map((order) => withItems(db, order))
    },
    dashboard() {
      const orders = this.listOrders().filter((order) => order.recordStatus !== 'cancelled')
      return {
        needsReview: orders.filter((order) => order.recordStatus === 'draft' || order.needsReview),
        paymentDue: orders.filter((order) => order.recordStatus === 'ready' && order.paymentStatus !== 'paid'),
        readyToShip: orders.filter((order) => order.recordStatus === 'ready' && order.paymentStatus === 'paid' && order.shippingStatus !== 'shipped'),
        shippedToday: orders.filter((order) => order.shippingStatus === 'shipped' && order.shipped_at && dateInSeoul(order.shipped_at) === dateInSeoul()),
      }
    },
    async deleteOrder(id) {
      const result = db.prepare('DELETE FROM orders WHERE id = ?').run(id)
      if (result.changes === 0) throw new Error('주문을 찾을 수 없습니다.')
      await backupAfterMutation()
    },
    history(id) {
      return db.prepare('SELECT field_name, from_value, to_value, reason, created_at FROM order_history WHERE order_id = ? ORDER BY id DESC').all(id)
    },
    close() {
      db.close()
    },
  }
}
