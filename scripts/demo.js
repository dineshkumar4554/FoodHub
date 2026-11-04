'use strict';
// End-to-end demo of the full order journey through the API gateway (use during the viva / live demonstration).
const { request } = require('../shared/http');
const { sleep } = require('../shared/retry');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const stamp = Date.now();
const step = (n, t) => console.log(`\n\x1b[1m[${n}] ${t}\x1b[0m`);
const api = (path, { token, ...opts } = {}) =>
  request(`${BASE}/api${path}`, { ...opts, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
const show = (label, r) => console.log(`  ${label}: HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 220));

async function waitForGateway() {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await request(`${BASE}/health`, { timeout: 1000 }); if (r.status === 200) return; } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('gateway not healthy - is `npm start` running?');
}

(async () => {
  await waitForGateway();
  step(1, 'Register customer, restaurant owner, delivery agent');
  const accounts = {};
  for (const [key, role] of [['customer', 'customer'], ['restaurant', 'restaurant'], ['agent', 'agent']]) {
    const email = `${key}${stamp}@foodhub.test`;
    await api('/auth/register', { method: 'POST', body: { name: `Demo ${key}`, email, password: 'Passw0rd!23', role } });
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'Passw0rd!23' } });
    accounts[key] = login.body.token;
    console.log(`  ${key} logged in (token ${login.body.token.slice(0, 16)}...)`);
  }

  step(2, 'Agent goes online; customer browses restaurants & menu (public, cached)');
  show('agent online', await api('/deliveries/agents/online', { method: 'POST', token: accounts.agent }));
  show('restaurants', await api('/restaurants'));
  show('menu r1', await api('/restaurants/r1/menu'));

  step(3, 'Unauthenticated order is rejected at the gateway (security)');
  show('no token', await api('/orders', { method: 'POST', body: {} }));

  step(4, 'Place order (Saga: price -> pay -> confirm -> publish order.placed)');
  const placed = await api('/orders', {
    method: 'POST', token: accounts.customer, headers: { 'x-idempotency-key': `demo-${stamp}` },
    body: { restaurantId: 'r1', items: [{ menuItemId: 'm1', qty: 2 }, { menuItemId: 'm3', qty: 3 }], paymentMethod: 'card',
      paymentDetails: { number: '4242 4242 4242 4242', expiry: '12/30', cvv: '123' } },
  });
  show('order', placed);
  const orderId = placed.body.id;

  step(5, 'Declined card -> compensating transition to PAYMENT_FAILED');
  show('declined', await api('/orders', { method: 'POST', token: accounts.customer,
    body: { restaurantId: 'r2', items: [{ menuItemId: 'm4', qty: 1 }], paymentMethod: 'card', paymentDetails: { number: '4000 0000 0000 0002', expiry: '12/30', cvv: '123' } } }));

  await sleep(500); // allow async events (delivery assignment, notifications) to propagate
  step(6, 'Restaurant prepares; agent picks up and delivers (events update the order)');
  show('PREPARING', await api(`/orders/${orderId}/status`, { method: 'PATCH', token: accounts.restaurant, body: { status: 'PREPARING' } }));
  show('READY', await api(`/orders/${orderId}/status`, { method: 'PATCH', token: accounts.restaurant, body: { status: 'READY' } }));
  await sleep(500); // READY event propagates to the delivery service
  show('pickup', await api(`/deliveries/${orderId}/pickup`, { method: 'POST', token: accounts.agent }));
  show('complete', await api(`/deliveries/${orderId}/complete`, { method: 'POST', token: accounts.agent }));

  await sleep(500);
  step(7, 'Final order state + notifications received by the customer');
  const final = await api(`/orders/${orderId}`, { token: accounts.customer });
  console.log('  status:', final.body.status, '| history:', final.body.history.map((h) => h.status).join(' -> '));
  const notes = await api('/notifications', { token: accounts.customer });
  notes.body.forEach((n) => console.log(`  🔔 ${n.message}`));

  step(8, 'Customer cancels a second order -> refund via Saga compensation');
  const second = await api('/orders', { method: 'POST', token: accounts.customer,
    body: { restaurantId: 'r1', items: [{ menuItemId: 'm2', qty: 1 }], paymentMethod: 'wallet' } });
  show('order 2', second);
  show('cancel', await api(`/orders/${second.body.id}/cancel`, { method: 'POST', token: accounts.customer, body: {} }));
  await sleep(500);
  const notes2 = await api('/notifications', { token: accounts.customer });
  console.log('  latest notification:', notes2.body[notes2.body.length - 1].message);

  step(9, 'Platform health (service status + circuit breaker states)');
  show('health', await request(`${BASE}/health`));
  console.log('\n✅ demo complete');
})().catch((e) => { console.error('demo failed:', e.message); process.exit(1); });
