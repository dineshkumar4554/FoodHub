'use strict';
// Order Service: orchestrates the order Saga (price -> pay -> confirm | compensate) and owns the order lifecycle.
const config = require('../../shared/config');
const { createApp, request, HttpError } = require('../../shared/http');
const { Repository } = require('../../shared/repository');
const { CircuitBreaker } = require('../../shared/circuitBreaker');
const { subscribe, requireRole } = require('../../shared/events');
const { createOutbox } = require('../../shared/outbox');
const { createLogger } = require('../../shared/logger');
const OrderFactory = require('./orderFactory');
const { transition, canTransition } = require('./orderState');

const log = createLogger('order-service');
const app = createApp('order-service');
const orders = new Repository('orders');
const idempotency = new Repository('order-idempotency');
const outbox = createOutbox('order-service');
const internal = { 'x-internal-key': config.INTERNAL_KEY };

const restaurantBreaker = new CircuitBreaker({ name: 'restaurant-service', failureThreshold: 3, resetTimeoutMs: 5000 });
const paymentBreaker = new CircuitBreaker({ name: 'payment-service', failureThreshold: 3, resetTimeoutMs: 5000 });

// Remote call guarded by a circuit breaker; 5xx / network errors count as failures, 4xx are business answers.
function call(breaker, url, opts) {
  return breaker.exec(async () => {
    const r = await request(url, opts);
    if (r.status >= 500) throw new Error(`upstream ${r.status}`);
    return r;
  });
}

app.post('/orders', requireRole('customer'), async (req, res) => {
  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey) {
    const prior = idempotency.get(`${req.user.id}:${idemKey}`);
    if (prior && orders.get(prior.orderId)) return res.json(200, orders.get(prior.orderId));
  }
  const { restaurantId, items, paymentMethod, paymentDetails = {}, type = 'standard' } = req.body;
  if (!restaurantId || !Array.isArray(items)) throw new HttpError(400, 'invalid_order_request');

  // Step 1 - price the cart from the authoritative catalogue
  let lookup;
  try {
    lookup = await call(restaurantBreaker, `${config.urls.restaurant}/menu-items/lookup`, {
      method: 'POST', headers: internal, body: { restaurantId, ids: items.map((i) => i.menuItemId) },
    });
  } catch { throw new HttpError(503, 'restaurant_service_unavailable'); }
  if (lookup.status === 404) throw new HttpError(404, 'restaurant_not_found');

  const order = OrderFactory.create(type, { userId: req.user.id, restaurantId, cart: items, menuItems: lookup.body.items });
  order.restaurantName = lookup.body.restaurant.name;
  order.history.push({ status: order.status, at: order.createdAt });
  orders.set(order.id, order);
  if (idemKey) idempotency.set(`${req.user.id}:${idemKey}`, { orderId: order.id });

  // Step 2 - charge. Failure => compensating transition (nothing else was done, so nothing to undo).
  let pay;
  try {
    pay = await call(paymentBreaker, `${config.urls.payment}/payments`, {
      method: 'POST', headers: internal, timeout: 4000,
      body: { orderId: order.id, userId: order.userId, amount: order.total, method: paymentMethod, details: paymentDetails },
    });
  } catch {
    transition(order, 'PAYMENT_FAILED', 'payment_service_unavailable'); orders.set(order.id, order);
    return res.json(503, { error: 'payment_unavailable', order });
  }
  if (pay.status !== 201) {
    const reason = pay.body.reason || pay.body.message || pay.body.error || 'payment_rejected';
    transition(order, 'PAYMENT_FAILED', reason); orders.set(order.id, order);
    return res.json(402, { error: 'payment_failed', reason, order });
  }

  // Step 3 - confirm and announce (event is persisted in the outbox first -> never lost)
  order.paymentId = pay.body.id;
  transition(order, 'CONFIRMED'); orders.set(order.id, order);
  await outbox.emit('order.placed', { orderId: order.id, userId: order.userId, restaurantId, restaurantName: order.restaurantName, total: order.total, priority: order.priority });
  log.info('order confirmed', { orderId: order.id, total: order.total });
  res.json(201, order);
});

function loadOwned(req) {
  const order = orders.get(req.params.id);
  if (!order) throw new HttpError(404, 'order_not_found');
  const privileged = ['restaurant', 'admin'].includes(req.user.role);
  if (!privileged && order.userId !== req.user.id) throw new HttpError(403, 'forbidden');
  return order;
}

app.get('/orders/:id', requireRole('customer', 'restaurant', 'admin', 'agent'), (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) throw new HttpError(404, 'order_not_found');
  if (req.user.role === 'customer' && order.userId !== req.user.id) throw new HttpError(403, 'forbidden');
  res.json(200, order);
});

app.get('/orders', requireRole('customer', 'restaurant', 'admin'), (req, res) => {
  const privileged = ['restaurant', 'admin'].includes(req.user.role);
  let list = orders.filter((o) => privileged || o.userId === req.user.id);
  if (privileged && req.query.restaurantId) list = list.filter((o) => o.restaurantId === req.query.restaurantId);
  res.json(200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/orders/:id/cancel', requireRole('customer', 'admin'), async (req, res) => {
  const order = loadOwned(req);
  transition(order, 'CANCELLED', req.body.reason || 'customer_request'); orders.set(order.id, order);
  await outbox.emit('order.cancelled', { orderId: order.id, userId: order.userId, paymentId: order.paymentId }); // Saga compensation -> refund
  res.json(200, order);
});

app.patch('/orders/:id/status', requireRole('restaurant', 'admin'), async (req, res) => {
  const { status } = req.body;
  if (!['PREPARING', 'READY'].includes(status)) throw new HttpError(400, 'invalid_status', 'restaurants may set PREPARING or READY');
  const order = orders.get(req.params.id);
  if (!order) throw new HttpError(404, 'order_not_found');
  transition(order, status); orders.set(order.id, order);
  await outbox.emit('order.status_changed', { orderId: order.id, userId: order.userId, status });
  res.json(200, order);
});

// Reactions to events from other services (idempotent: illegal / repeated transitions are ignored).
function advance(orderId, to) {
  const order = orders.get(orderId);
  if (order && canTransition(order.status, to)) { transition(order, to); orders.set(order.id, order); }
  return order;
}
subscribe(app, 'order-service', config.urls.order, {
  'delivery.assigned': (d) => { const o = orders.get(d.orderId); if (o) { o.agentId = d.agentId; orders.set(o.id, o); } },
  'delivery.picked_up': (d) => { advance(d.orderId, 'OUT_FOR_DELIVERY'); },
  'delivery.delivered': (d) => { advance(d.orderId, 'DELIVERED'); },
});

if (require.main === module) {
  app.listen(config.ports.order).then(() => log.info(`listening on ${config.ports.order}`));
}
module.exports = { app };
