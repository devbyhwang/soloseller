export const recordStatuses = ['draft', 'ready', 'cancelled']
export const paymentStatuses = ['unconfirmed', 'pending', 'paid', 'refund_needed']
export const shippingStatuses = ['not_ready', 'preparing', 'tracking_entered', 'shipped']

export function normalizePhone(value = '') {
  return value.replace(/\D/g, '')
}

export function dateInSeoul(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value))
  const part = (type) => parts.find((item) => item.type === type).value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function calculateTotals(items = [], customShippingFee) {
  const productTotal = items.reduce(
    (total, item) => total + Number(item.quantity || 0) * Number(item.unitPrice || 0),
    0,
  )
  const boxCount = items.reduce((total, item) => total + Math.max(0, Number(item.quantity) || 0), 0)
  const defaultShippingFee = boxCount === 0 ? 0 : Math.ceil(boxCount / 2) * 6000
  const hasCustomShippingFee = customShippingFee !== undefined && customShippingFee !== null && customShippingFee !== ''
  const shippingFee = hasCustomShippingFee ? Math.max(0, Number(customShippingFee) || 0) : defaultShippingFee
  return {
    productTotal,
    shippingFee,
    grandTotal: productTotal + shippingFee,
  }
}

export function validateOrder(order, { requireComplete = false } = {}) {
  const errors = []
  const items = Array.isArray(order.items) ? order.items : []

  if (!requireComplete) return errors

  if (!order.customerName?.trim()) errors.push('주문자 이름을 입력해 주세요.')
  if (normalizePhone(order.phone).length < 9) errors.push('전화번호를 확인해 주세요.')
  if (!order.address?.trim()) errors.push('배송지 주소를 입력해 주세요.')
  if (items.length === 0) errors.push('상품을 하나 이상 추가해 주세요.')

  for (const item of items) {
    if (!['normal', 'special'].includes(item.grade)) errors.push('등급을 선택해 주세요.')
    if (Number(item.quantity) <= 0) errors.push('수량은 1 이상이어야 합니다.')
    if (Number(item.unitPrice) < 0) errors.push('단가는 0 이상이어야 합니다.')
  }

  return errors
}

export function canTransition(order, transition, trackingNumber = '') {
  if (transition === 'ready') {
    return { ok: order.recordStatus === 'draft', message: '임시 등록 주문만 접수 완료로 바꿀 수 있습니다.' }
  }
  if (transition === 'paid') {
    return { ok: order.recordStatus === 'ready', message: '접수 완료 주문만 입금 완료로 바꿀 수 있습니다.' }
  }
  if (transition === 'prepare') {
    return {
      ok: order.recordStatus === 'ready' && order.paymentStatus === 'paid' && order.shippingStatus === 'not_ready',
      message: '접수 완료이고 입금 완료인 주문만 포장 준비로 바꿀 수 있습니다.',
    }
  }
  if (transition === 'tracking') {
    return {
      ok: order.shippingStatus === 'preparing' && trackingNumber.trim().length > 0,
      message: '포장 준비 상태에서 운송장 번호를 입력해 주세요.',
    }
  }
  if (transition === 'shipped') {
    return {
      ok: order.shippingStatus === 'tracking_entered',
      message: '운송장 등록 후 발송 완료로 바꿀 수 있습니다.',
    }
  }
  if (transition === 'cancel') {
    return {
      ok: order.shippingStatus !== 'shipped',
      message: '발송 완료 주문은 취소할 수 없습니다.',
    }
  }
  return { ok: false, message: '알 수 없는 상태 변경입니다.' }
}

export function escapeCsv(value = '') {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
