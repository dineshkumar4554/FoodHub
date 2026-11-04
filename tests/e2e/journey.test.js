'use strict';
// Black-box end-to-end tests: boots all 8 services as real processes and drives them through the public gateway.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAll } = require('../../scripts/start-all');
const { request } = require('../../shared/http');
const { sleep } = require('../../shared/retry');

const GW = 'http://localhost:3100';
let stop; const tokens = {};
const api = (path, { token, headers, ...o } = {}) =>
  request(`${GW}/api${path}`, { ...o, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const CARD = { number: '4242 4242 4242 4242', expiry: '12/30', cvv: '123' };
const order = (token, extra = {}) => api('/orders', { method: 'POST', token, body: { restaurantId: 'r1', items: [{ menuItemId: 'm1', qty: 1 }], paymentMethod: 'card', paymentDetails: CARD, ...extra } });

before(async () => {
  stop = startAll({ GATEWAY_PORT: '3100', FOODHUB_PERSIST: '0', LOG_LEVEL: 'silent', RATE_LIMIT_CAPACITY: '100000', RATE_LIMIT_REFILL_PER_SEC: '100000' });
  for (let i = 0; i < 60; i += 1) { try { if ((await request(`${GW}/health`, { timeout: 800 })).status === 200) break; } catch { /* wait */ } await sleep(300); }
  const stamp = Date.now();
  for (const role of ['customer', 'restaurant', 'agent']) {
    for (const who of role === 'customer' ? ['customer', 'other'] : [role]) {
      const email = `${who}${stamp}@t.test`;
      await api('/auth/register', { method: 'POST', body: { name: who, email, password: 'Passw0rd!23', role } });
      tokens[who] = (await api('/auth/login', { method: 'POST', body: { email, password: 'Passw0rd!23' } })).body.token;
    }
  }
  await api('/deliveries/agents/online', { method: 'POST', token: tokens.agent });
});
after(() => stop && stop());

test('gateway health reports every service UP', async () => {
  const r = await request(`${GW}/health`); assert.equal(r.status, 200); assert.equal(r.body.status, 'UP');
});
test('security: protected routes need a token; forged identity headers are ignored', async () => {
  assert.equal((await api('/orders')).status, 401);
  assert.equal((await api('/orders', { token: 'bad.token.here' })).status, 401);
  const spoof = await api('/orders', { method: 'POST', headers: { 'x-user-id': 'admin', 'x-user-role': 'customer' }, body: {} });
  assert.equal(spoof.status, 401);
});
test('registration validates input and login does not leak which field was wrong', async () => {
  assert.equal((await api('/auth/register', { method: 'POST', body: { name: 'x', email: 'bad', password: 'Passw0rd!23' } })).status, 400);
  assert.equal((await api('/auth/register', { method: 'POST', body: { name: 'x', email: 'a@b.co', password: 'short' } })).status, 400);
  assert.equal((await api('/auth/register', { method: 'POST', body: { name: 'x', email: 'a@b.co', password: 'Passw0rd!23', role: 'admin' } })).status, 400);
  assert.equal((await api('/auth/login', { method: 'POST', body: { email: 'nobody@t.test', password: 'whatever12' } })).status, 401);
});
test('full journey: order -> agent assigned -> prepared -> delivered, with notifications', async () => {
  const placed = await order(tokens.customer);
  assert.equal(placed.status, 201); assert.equal(placed.body.status, 'CONFIRMED');
  const id = placed.body.id; await sleep(600);
  assert.equal((await api(`/orders/${id}/status`, { method: 'PATCH', token: tokens.restaurant, body: { status: 'PREPARING' } })).status, 200);
  assert.equal((await api(`/orders/${id}/status`, { method: 'PATCH', token: tokens.restaurant, body: { status: 'READY' } })).status, 200);
  await sleep(500);
  assert.equal((await api(`/deliveries/${id}/pickup`, { method: 'POST', token: tokens.agent })).status, 200);
  assert.equal((await api(`/deliveries/${id}/complete`, { method: 'POST', token: tokens.agent })).status, 200);
  await sleep(600);
  const final = await api(`/orders/${id}`, { token: tokens.customer });
  assert.equal(final.body.status, 'DELIVERED');
  const notes = (await api('/notifications', { token: tokens.customer })).body.map((n) => n.message).join(' | ');
  assert.match(notes, /confirmed/); assert.match(notes, /delivered/);
});
test('agent cannot pick up an order the restaurant has not marked READY', async () => {
  const placed = await order(tokens.customer); await sleep(600);
  const r = await api(`/deliveries/${placed.body.id}/pickup`, { method: 'POST', token: tokens.agent });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'order_not_ready');
});
test('saga: declined payment leaves the order PAYMENT_FAILED (compensation)', async () => {
  const r = await order(tokens.customer, { paymentDetails: { ...CARD, number: '4000 0000 0000 0002' } });
  assert.equal(r.status, 402); assert.equal(r.body.order.status, 'PAYMENT_FAILED');
});
test('saga: cancelling a paid order triggers an asynchronous refund', async () => {
  const placed = await order(tokens.customer, { paymentMethod: 'wallet', paymentDetails: {} });
  assert.equal(placed.status, 201);
  assert.equal((await api(`/orders/${placed.body.id}/cancel`, { method: 'POST', token: tokens.customer, body: {} })).body.status, 'CANCELLED');
  await sleep(700);
  const notes = (await api('/notifications', { token: tokens.customer })).body.map((n) => n.message).join(' | ');
  assert.match(notes, new RegExp(`Refund .* ${placed.body.id}`));
});
test('idempotency key prevents duplicate orders / double charging', async () => {
  const h = { 'x-idempotency-key': 'k-1' };
  const a = await api('/orders', { method: 'POST', token: tokens.customer, headers: h, body: { restaurantId: 'r1', items: [{ menuItemId: 'm3', qty: 1 }], paymentMethod: 'upi', paymentDetails: { vpa: 'alice@bank' } } });
  const b = await api('/orders', { method: 'POST', token: tokens.customer, headers: h, body: { restaurantId: 'r1', items: [{ menuItemId: 'm3', qty: 1 }], paymentMethod: 'upi', paymentDetails: { vpa: 'alice@bank' } } });
  assert.equal(a.body.id, b.body.id);
});
test('authorization (RBAC + ownership)', async () => {
  const mine = await order(tokens.customer);
  assert.equal((await api(`/orders/${mine.body.id}`, { token: tokens.other })).status, 403);
  assert.equal((await api(`/orders/${mine.body.id}/status`, { method: 'PATCH', token: tokens.customer, body: { status: 'READY' } })).status, 403);
  assert.equal((await api('/orders', { method: 'POST', token: tokens.restaurant, body: { restaurantId: 'r1', items: [] } })).status, 403);
  assert.equal((await api('/restaurants/r1/menu', { method: 'POST', token: tokens.customer, body: { name: 'x', price: 1 } })).status, 403);
});
test('prices come from the server: unknown/unavailable items and invalid states are rejected', async () => {
  assert.equal((await order(tokens.customer, { items: [{ menuItemId: 'm7', qty: 1 }], restaurantId: 'r3' })).status, 422);
  const o = await order(tokens.customer);
  assert.equal((await api(`/orders/${o.body.id}/status`, { method: 'PATCH', token: tokens.restaurant, body: { status: 'READY' } })).status, 409);
});
test('web UI is served by the gateway with a strict CSP; path traversal is blocked', async () => {
  const page = await request(`${GW}/`);
  assert.equal(page.status, 200); assert.match(page.body, /FoodHub/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await request(`${GW}/app.js`)).status, 200);
  assert.equal((await request(`${GW}/style.css`)).status, 200);
  for (const bad of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/services/gateway/index.js']) {
    assert.notEqual((await request(`${GW}${bad}`)).status, 200, bad);
  }
});
test('internal endpoints are not reachable through the gateway', async () => {
  assert.equal((await api('/payments', { method: 'POST', token: tokens.customer, body: {} })).status, 404);
  assert.equal((await api('/menu-items/lookup', { method: 'POST', token: tokens.customer, body: {} })).status, 404);
});
