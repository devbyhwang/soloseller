import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from './lib/database.js'
import { escapeCsv } from './lib/orders.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const store = createStore(process.env.DATABASE_PATH)
const app = express()
const port = Number(process.env.PORT || 3000)

app.use(express.json())
app.use(express.static(path.join(dirname, 'public')))

app.get('/api/dashboard', (_request, response) => response.json(store.dashboard()))
app.get('/api/orders', (_request, response) => response.json(store.listOrders()))
app.get('/api/orders/:id', (request, response) => {
  const order = store.getOrder(Number(request.params.id))
  if (!order) return response.status(404).json({ error: '주문을 찾을 수 없습니다.' })
  return response.json({ ...order, history: store.history(order.id) })
})
app.post('/api/orders', async (request, response) => response.status(201).json(await store.createOrder(request.body)))
app.patch('/api/orders/:id', async (request, response) => response.json(await store.updateOrder(Number(request.params.id), request.body, Number(request.body.version))))
app.post('/api/orders/:id/transitions', async (request, response) => {
  const { transition, version, trackingNumber } = request.body
  return response.json(await store.transitionOrder(Number(request.params.id), transition, Number(version), trackingNumber))
})
app.delete('/api/orders/:id', async (request, response) => {
  await store.deleteOrder(Number(request.params.id))
  return response.status(204).end()
})
app.get('/api/export.csv', (_request, response) => {
  const rows = store.listOrders()
  const header = ['주문번호', '주문자', '전화번호', '주소', '상품', '상품금액', '택배비', '총액', '확인 필요', '확인 내용', '주문상태', '입금상태', '배송상태', '운송장번호', '등록시각']
  const lines = rows.map((order) => [
    order.id,
    order.customerName,
    order.phone,
    order.address,
    order.items.map((item) => `${item.grade === 'special' ? '특' : '일반'} ${item.quantity}상자`).join(' / '),
    order.productTotal,
    order.shippingFee,
    order.grandTotal,
    order.needsReview ? '예' : '아니오',
    order.reviewNote,
    order.recordStatus,
    order.paymentStatus,
    order.shippingStatus,
    order.trackingNumber,
    order.created_at,
  ].map(escapeCsv).join(','))
  response.setHeader('Content-Type', 'text/csv; charset=utf-8')
  response.setHeader('Content-Disposition', 'attachment; filename="peach-orders.csv"')
  response.send(`\uFEFF${[header.map(escapeCsv).join(','), ...lines].join('\n')}`)
})

app.use((error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.'
  const status = message.includes('찾을 수') ? 404 : message.includes('다른 창') ? 409 : 400
  response.status(status).json({ error: message })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`복숭아 주문대장이 http://127.0.0.1:${port} 에서 실행 중입니다.`)
})
