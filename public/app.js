const state = { orders: [], dashboard: null, filter: null }
const labels = {
  draft: '임시 등록', ready: '접수 완료', cancelled: '취소',
  normal: '일반', special: '특',
  unconfirmed: '미확인', pending: '입금 대기', paid: '입금 완료', refund_needed: '환불 필요',
  not_ready: '준비 전', preparing: '포장 준비', tracking_entered: '송장 등록', shipped: '발송 완료',
}

const form = document.querySelector('#order-form')
const itemList = document.querySelector('#item-list')
const notice = document.querySelector('#notice')
const priceByGrade = { normal: 22000, special: 27000 }
const shippingFeeInput = document.querySelector('[name="shippingFee"]')
const editDialog = document.querySelector('#edit-dialog')
const editForm = document.querySelector('#edit-form')
const editItemList = document.querySelector('#edit-item-list')
const editShippingFeeInput = editForm.querySelector('[name="shippingFee"]')
const helpDialog = document.querySelector('#help-dialog')
let editingOrder = null

function showNotice(message, isError = false) {
  notice.textContent = message
  notice.classList.toggle('error', isError)
}

function createShippingFeeController(container, input) {
  let edited = false
  input.addEventListener('input', () => { edited = true })
  return {
    update() {
      if (edited) return
      const boxCount = [...container.querySelectorAll('[name="quantity"]')]
        .reduce((total, quantity) => total + Math.max(0, Number(quantity.value) || 0), 0)
      input.value = boxCount === 0 ? 0 : Math.ceil(boxCount / 2) * 6000
    },
    reset() { edited = false },
    markEdited() { edited = true },
  }
}

const newOrderShipping = createShippingFeeController(itemList, shippingFeeInput)
const editOrderShipping = createShippingFeeController(editItemList, editShippingFeeInput)

function addItem(item = {}, container = itemList, shipping = newOrderShipping) {
  const fragment = document.querySelector('#item-template').content.cloneNode(true)
  const row = fragment.querySelector('.item-row')
  const grade = item.grade || 'normal'
  row.querySelector('[name="grade"]').value = grade
  row.querySelector('[name="quantity"]').value = item.quantity ?? 1
  row.querySelector('[name="unitPrice"]').value = item.unitPrice ?? priceByGrade[grade]
  row.querySelector('[name="grade"]').addEventListener('change', (event) => {
    row.querySelector('[name="unitPrice"]').value = priceByGrade[event.target.value]
  })
  row.querySelector('[name="quantity"]').addEventListener('input', () => shipping.update())
  row.querySelector('.remove-item').addEventListener('click', () => {
    row.remove()
    shipping.update()
  })
  container.append(row)
  shipping.update()
}

function formatMoney(value) { return `${Number(value || 0).toLocaleString('ko-KR')}원` }

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]))
}

function formatPhone(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 3) return digits
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
}

function itemsFrom(container) {
  return [...container.querySelectorAll('.item-row')].map((row) => ({
    grade: row.querySelector('[name="grade"]').value,
    quantity: Number(row.querySelector('[name="quantity"]').value),
    unitPrice: Number(row.querySelector('[name="unitPrice"]').value),
  })).filter((item) => item.quantity > 0)
}

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options })
  if (response.status === 204) return null
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '처리하지 못했습니다.')
  return data
}

function orderMatchesFilter(order) {
  if (!state.filter) return true
  if (state.filter === 'needsReview') return order.recordStatus === 'draft' || order.needsReview
  if (state.filter === 'paymentDue') return order.recordStatus === 'ready' && order.paymentStatus !== 'paid'
  if (state.filter === 'readyToShip') return order.recordStatus === 'ready' && order.paymentStatus === 'paid' && order.shippingStatus !== 'shipped'
  if (state.filter === 'shippedToday') return state.dashboard.shippedToday.some((shipped) => shipped.id === order.id)
  return true
}

function actionButton(label, callback, style = 'secondary') {
  const button = document.createElement('button')
  button.className = `button ${style}`
  button.textContent = label
  button.addEventListener('click', callback)
  return button
}

function statusLabel(order) {
  if (order.recordStatus === 'cancelled') return labels.cancelled
  if (order.shippingStatus !== 'not_ready') return labels[order.shippingStatus]
  if (order.paymentStatus === 'paid') return labels.paid
  return labels[order.recordStatus]
}

async function updateReview(order, needsReview, reviewNote = order.reviewNote) {
  try {
    await request(`/api/orders/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ version: order.version, needsReview, reviewNote }),
    })
    showNotice(needsReview ? '확인할 사항에 추가했습니다.' : '확인할 사항에서 지웠습니다.')
    await load()
  } catch (error) {
    showNotice(error.message, true)
  }
}

function renderReviewControl(order, container, details) {
  const toggle = document.createElement('label')
  toggle.className = 'review-toggle'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = order.needsReview || order.recordStatus === 'draft'
  checkbox.disabled = order.recordStatus === 'draft'
  checkbox.addEventListener('change', async () => {
    if (!checkbox.checked) return updateReview(order, false, '')
    const reviewNote = window.prompt('확인할 내용을 적어 주세요. 예: 특 2상자 추가', order.reviewNote || '')
    if (reviewNote === null) {
      checkbox.checked = false
      return
    }
    await updateReview(order, true, reviewNote)
  })
  toggle.append(document.createTextNode('확인 필요'), checkbox)
  container.append(toggle)

  if (order.recordStatus === 'draft') {
    const automatic = document.createElement('span')
    automatic.className = 'review-automatic'
    automatic.textContent = '주문 정보 입력 필요'
    details.append(automatic)
  }

  if (order.needsReview) {
    const note = document.createElement('span')
    note.className = 'review-note'
    note.textContent = order.reviewNote || '확인 내용 미입력'
    details.append(note)
    const edit = document.createElement('button')
    edit.className = 'text-button'
    edit.type = 'button'
    edit.textContent = '내용 수정'
    edit.addEventListener('click', async () => {
      const reviewNote = window.prompt('확인할 내용을 수정해 주세요.', order.reviewNote || '')
      if (reviewNote !== null) await updateReview(order, true, reviewNote)
    })
    details.append(edit)
  }
}

function openEditDialog(order) {
  editingOrder = order
  editForm.querySelector('[name="customerName"]').value = order.customerName
  editForm.querySelector('[name="phone"]').value = order.phone
  editForm.querySelector('[name="address"]').value = order.address
  editForm.querySelector('[name="notes"]').value = order.notes
  editItemList.replaceChildren()
  editOrderShipping.reset()
  for (const item of order.items) addItem(item, editItemList, editOrderShipping)
  const defaultShippingFee = Number(editShippingFeeInput.value)
  editShippingFeeInput.value = order.shippingFee
  if (Number(order.shippingFee) !== defaultShippingFee) editOrderShipping.markEdited()
  editDialog.showModal()
}

function renderOrders() {
  const list = document.querySelector('#order-list')
  list.replaceChildren()
  const orders = state.orders.filter(orderMatchesFilter)
  if (!orders.length) {
    list.innerHTML = '<p class="empty">이 목록에 주문이 없습니다.</p>'
    return
  }
  for (const order of orders) {
    const card = document.querySelector('#order-template').content.cloneNode(true)
    card.querySelector('.order-number').textContent = `#${order.id}`
    card.querySelector('.customer-name').textContent = order.customerName || '이름 미입력'
    const status = card.querySelector('.order-status')
    status.textContent = statusLabel(order)
    status.classList.add(order.recordStatus)
    card.querySelector('.order-items').textContent = order.items.length ? order.items.map((item) => `${labels[item.grade]} ${item.quantity}상자`).join(' · ') : '상품 미입력'
    card.querySelector('.order-address').textContent = order.address || '주소 미입력'
    card.querySelector('.order-meta').textContent = `총 ${formatMoney(order.grandTotal)} · ${labels[order.paymentStatus]}${order.trackingNumber ? ` · 송장 ${order.trackingNumber}` : ''}`
    renderReviewControl(order, card.querySelector('.order-review'), card.querySelector('.order-review-details'))
    const actions = card.querySelector('.order-actions')
    if (order.recordStatus === 'draft') actions.append(actionButton('주문 등록', () => transition(order, 'ready')))
    if (order.recordStatus === 'ready' && order.paymentStatus !== 'paid') actions.append(actionButton('입금 완료', () => transition(order, 'paid')))
    if (order.recordStatus === 'ready' && order.paymentStatus === 'paid' && order.shippingStatus === 'not_ready') actions.append(actionButton('포장 준비', () => transition(order, 'prepare')))
    if (order.shippingStatus === 'preparing') actions.append(actionButton('운송장 입력', async () => {
      const trackingNumber = window.prompt('운송장 번호를 입력해 주세요.')
      if (trackingNumber) await transition(order, 'tracking', trackingNumber)
    }))
    if (order.shippingStatus === 'tracking_entered') actions.append(actionButton('발송 완료', () => transition(order, 'shipped')))
    if (order.recordStatus !== 'cancelled' && order.shippingStatus === 'not_ready') actions.append(actionButton('수정', () => openEditDialog(order), 'secondary'))
    if (order.recordStatus !== 'cancelled' && order.shippingStatus !== 'shipped') actions.append(actionButton('취소', async () => {
      if (window.confirm(`주문 #${order.id}을 취소할까요?`)) await transition(order, 'cancel')
    }, 'danger'))
    actions.append(actionButton('인쇄', () => printOrder(order), 'secondary'))
    actions.append(actionButton('삭제', async () => {
      if (window.confirm(`주문 #${order.id}을 삭제할까요?`)) {
        await request(`/api/orders/${order.id}`, { method: 'DELETE' })
        await load()
      }
    }, 'text'))
    list.append(card)
  }
}

async function transition(order, transitionName, trackingNumber = '') {
  try {
    await request(`/api/orders/${order.id}/transitions`, { method: 'POST', body: JSON.stringify({ transition: transitionName, version: order.version, trackingNumber }) })
    showNotice('상태를 변경했습니다.')
    await load()
  } catch (error) { showNotice(error.message, true) }
}

function printOrder(order) {
  const itemText = order.items.map((item) => `${labels[item.grade]} ${item.quantity}상자`).join(' / ')
  const popup = window.open('', '_blank', 'width=640,height=480')
  if (!popup) return showNotice('인쇄 창을 열 수 없습니다. 팝업 차단을 확인해 주세요.', true)
  popup.document.write(`<title>포장 확인표 #${order.id}</title><style>body{font-family:system-ui;padding:36px;color:#222}h1{font-size:28px}p{font-size:20px;border-bottom:1px solid #aaa;padding:14px 0}</style><h1>포장 확인표 #${order.id}</h1><p>주문자: ${escapeHtml(order.customerName || '미입력')}</p><p>상품: ${escapeHtml(itemText || '미입력')}</p><p>송장: ${escapeHtml(order.trackingNumber || '미입력')}</p>`)
  popup.document.close()
  popup.focus()
  popup.print()
}

function renderDashboard() {
  const dashboard = state.dashboard
  document.querySelector('#needsReview').textContent = dashboard.needsReview.length
  document.querySelector('#paymentDue').textContent = dashboard.paymentDue.length
  document.querySelector('#readyToShip').textContent = dashboard.readyToShip.length
  document.querySelector('#shippedToday').textContent = dashboard.shippedToday.length
  document.querySelector('#list-title').textContent = state.filter ? ({ needsReview: '확인할 사항', paymentDue: '입금 확인 필요 주문', readyToShip: '오늘 발송 필요 주문', shippedToday: '오늘 발송 완료 주문' }[state.filter]) : '전체 주문'
}

async function load() {
  try {
    const [orders, dashboard] = await Promise.all([request('/api/orders'), request('/api/dashboard')])
    state.orders = orders
    state.dashboard = dashboard
    renderDashboard()
    renderOrders()
  } catch (error) { showNotice(error.message, true) }
}

document.querySelector('#add-item').addEventListener('click', () => addItem())
document.querySelector('[name="phone"]').addEventListener('input', (event) => {
  event.target.value = formatPhone(event.target.value)
})
editForm.querySelector('[name="phone"]').addEventListener('input', (event) => {
  event.target.value = formatPhone(event.target.value)
})
document.querySelector('#show-all').addEventListener('click', () => { state.filter = null; renderDashboard(); renderOrders() })
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; renderDashboard(); renderOrders() }))
document.querySelector('#add-edit-item').addEventListener('click', () => addItem({}, editItemList, editOrderShipping))
document.querySelector('#close-edit').addEventListener('click', () => editDialog.close())
document.querySelector('#cancel-edit').addEventListener('click', () => editDialog.close())
document.querySelector('#show-help').addEventListener('click', () => helpDialog.showModal())
document.querySelector('#close-help').addEventListener('click', () => helpDialog.close())
document.querySelector('#help-done').addEventListener('click', () => helpDialog.close())
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const mode = event.submitter.dataset.mode
  const fields = new FormData(form)
  const items = itemsFrom(itemList)
  try {
    await request('/api/orders', { method: 'POST', body: JSON.stringify({
      customerName: fields.get('customerName'), phone: fields.get('phone'), address: fields.get('address'), shippingFee: fields.get('shippingFee'), notes: fields.get('notes'), items,
      registerNow: mode === 'ready',
    }) })
    showNotice(mode === 'ready' ? '주문을 등록했습니다.' : '임시 주문으로 저장했습니다.')
    await load()
    form.reset(); itemList.replaceChildren(); newOrderShipping.reset(); addItem()
  } catch (error) { showNotice(error.message, true) }
})

editForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!editingOrder) return
  const fields = new FormData(editForm)
  try {
    await request(`/api/orders/${editingOrder.id}`, { method: 'PATCH', body: JSON.stringify({
      version: editingOrder.version,
      customerName: fields.get('customerName'),
      phone: fields.get('phone'),
      address: fields.get('address'),
      shippingFee: fields.get('shippingFee'),
      notes: fields.get('notes'),
      items: itemsFrom(editItemList),
    }) })
    editDialog.close()
    showNotice('주문 정보를 수정했습니다.')
    await load()
  } catch (error) { showNotice(error.message, true) }
})

addItem()
load()
