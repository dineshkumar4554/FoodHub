'use strict';
// Delivery Service: reacts to order events (Observer), assigns the least-loaded online agent, tracks delivery status.
const config = require('../../shared/config');
const { createApp, HttpError } = require('../../shared/http');
const { Repository } = require('../../shared/repository');
const { subscribe, requireRole } = require('../../shared/events');
const { createOutbox } = require('../../shared/outbox');
const { createLogger } = require('../../shared/logger');

const log = createLogger('delivery-service');
const app = createApp('delivery-service');
const agents = new Repository('agents');
const deliveries = new Repository('deliveries');
const outbox = createOutbox('delivery-service');
const ACTIVE = ['ASSIGNED', 'PICKED_UP'];

const load = (agentId) => deliveries.filter((d) => d.agentId === agentId && ACTIVE.includes(d.status)).length;

async function tryAssign(delivery) {
  const candidates = agents.filter((a) => a.online);
  if (!candidates.length) return false;
  const agent = candidates.sort((a, b) => load(a.id) - load(b.id))[0]; // least-loaded strategy
  delivery.agentId = agent.id; delivery.status = 'ASSIGNED';
  delivery.etaMinutes = delivery.priority ? 20 : 35;
  deliveries.set(delivery.orderId, delivery);
  await outbox.emit('delivery.assigned', { orderId: delivery.orderId, userId: delivery.userId, agentId: agent.id, agentName: agent.name, etaMinutes: delivery.etaMinutes });
  log.info('agent assigned', { orderId: delivery.orderId, agentId: agent.id });
  return true;
}

async function drainPending() {
  for (const d of deliveries.filter((x) => x.status === 'PENDING_ASSIGNMENT')) await tryAssign(d);
}

subscribe(app, 'delivery-service', config.urls.delivery, {
  'order.placed': async (d) => {
    if (deliveries.get(d.orderId)) return;
    const delivery = deliveries.set(d.orderId, { orderId: d.orderId, userId: d.userId, priority: !!d.priority, status: 'PENDING_ASSIGNMENT', orderStatus: 'CONFIRMED', agentId: null, createdAt: new Date().toISOString() });
    await tryAssign(delivery);
  },
  // keep a local copy of the order's progress so pickup can be validated without a synchronous call
  'order.status_changed': (d) => {
    const del = deliveries.get(d.orderId);
    if (del) { del.orderStatus = d.status; deliveries.set(del.orderId, del); }
  },
  'order.cancelled': (d) => {
    const del = deliveries.get(d.orderId);
    if (del && ACTIVE.concat('PENDING_ASSIGNMENT').includes(del.status)) { del.status = 'CANCELLED'; deliveries.set(del.orderId, del); }
  },
});

app.post('/deliveries/agents/online', requireRole('agent'), async (req, res) => {
  const agent = agents.set(req.user.id, { id: req.user.id, name: req.user.name || req.user.id, online: true });
  await drainPending();
  res.json(200, agent);
});

app.get('/deliveries', requireRole('agent', 'admin'), (req, res) => {
  const list = deliveries.filter((d) => req.user.role === 'admin' || d.agentId === req.user.id);
  res.json(200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/deliveries/:orderId', requireRole('customer', 'agent', 'restaurant', 'admin'), (req, res) => {
  const d = deliveries.get(req.params.orderId);
  if (!d) throw new HttpError(404, 'delivery_not_found');
  if (req.user.role === 'customer' && d.userId !== req.user.id) throw new HttpError(403, 'forbidden');
  res.json(200, d);
});

function ownDelivery(req, expected) {
  const d = deliveries.get(req.params.orderId);
  if (!d) throw new HttpError(404, 'delivery_not_found');
  if (d.agentId !== req.user.id) throw new HttpError(403, 'forbidden', 'delivery is assigned to another agent');
  if (d.status !== expected) throw new HttpError(409, 'invalid_state', `delivery is ${d.status}`);
  return d;
}

app.post('/deliveries/:orderId/pickup', requireRole('agent'), async (req, res) => {
  const d = ownDelivery(req, 'ASSIGNED');
  if (d.orderStatus !== 'READY') throw new HttpError(409, 'order_not_ready', 'the restaurant has not marked this order READY yet');
  d.status = 'PICKED_UP'; deliveries.set(d.orderId, d);
  await outbox.emit('delivery.picked_up', { orderId: d.orderId, userId: d.userId, agentId: d.agentId });
  res.json(200, d);
});

app.post('/deliveries/:orderId/complete', requireRole('agent'), async (req, res) => {
  const d = ownDelivery(req, 'PICKED_UP');
  d.status = 'DELIVERED'; deliveries.set(d.orderId, d);
  await outbox.emit('delivery.delivered', { orderId: d.orderId, userId: d.userId, agentId: d.agentId });
  res.json(200, d);
});

if (require.main === module) {
  app.listen(config.ports.delivery).then(() => log.info(`listening on ${config.ports.delivery}`));
}
module.exports = { app };
