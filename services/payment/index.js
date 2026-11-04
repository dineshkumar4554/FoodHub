'use strict';
// Payment Service: processes payments through pluggable strategies. Idempotent per order (no double charging).
const config = require('../../shared/config');
const { createApp, HttpError } = require('../../shared/http');
const { Repository } = require('../../shared/repository');
const { subscribe, requireInternal } = require('../../shared/events');
const { createOutbox } = require('../../shared/outbox');
const { createLogger } = require('../../shared/logger');
const { createStrategies } = require('./strategies');

const log = createLogger('payment-service');
const app = createApp('payment-service');
const payments = new Repository('payments');
const wallets = new Repository('wallets');
const strategies = createStrategies({ wallets });
const outbox = createOutbox('payment-service');

app.post('/payments', requireInternal, async (req, res) => {
  const { orderId, userId, amount, method, details = {} } = req.body;
  if (!orderId || !userId || !(amount > 0)) throw new HttpError(400, 'invalid_payment_request');
  const existing = payments.find((p) => p.orderId === orderId); // idempotency: same order -> same result
  if (existing) return res.json(existing.status === 'SUCCEEDED' ? 201 : 402, existing);

  const strategy = strategies[method];
  if (!strategy) throw new HttpError(400, 'unsupported_payment_method');
  const invalid = strategy.validate(details);
  if (invalid) throw new HttpError(400, 'invalid_payment_details', invalid);

  const result = await strategy.charge({ userId, amount, details });
  const id = Repository.newId('pay');
  const payment = payments.set(id, {
    id, orderId, userId, amount, method, status: result.ok ? 'SUCCEEDED' : 'FAILED',
    reason: result.reason || null, instrument: result.masked || null, createdAt: new Date().toISOString(),
  });

  if (result.ok) {
    await outbox.emit('payment.confirmed', { orderId, paymentId: payment.id, userId, amount, method });
    log.info('payment succeeded', { orderId, paymentId: payment.id, method });
    return res.json(201, payment);
  }
  await outbox.emit('payment.failed', { orderId, userId, reason: result.reason });
  log.warn('payment failed', { orderId, reason: result.reason });
  res.json(402, payment);
});

async function refund(paymentId) {
  const p = payments.get(paymentId);
  if (!p || p.status !== 'SUCCEEDED') return null; // idempotent: refund only once
  await strategies[p.method].refund({ userId: p.userId, amount: p.amount });
  p.status = 'REFUNDED'; payments.set(p.id, p);
  await outbox.emit('payment.refunded', { orderId: p.orderId, paymentId: p.id, userId: p.userId, amount: p.amount });
  log.info('payment refunded', { paymentId: p.id });
  return p;
}

app.post('/payments/:id/refund', requireInternal, async (req, res) => {
  if (!payments.get(req.params.id)) throw new HttpError(404, 'payment_not_found');
  res.json(200, (await refund(req.params.id)) || payments.get(req.params.id));
});

// Saga compensation step: a cancelled order triggers the refund.
subscribe(app, 'payment-service', config.urls.payment, {
  'order.cancelled': async (data) => { if (data.paymentId) await refund(data.paymentId); },
});

if (require.main === module) {
  app.listen(config.ports.payment).then(() => log.info(`listening on ${config.ports.payment}`));
}
module.exports = { app };
