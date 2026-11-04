'use strict';
// Tiny load generator (no dependencies). Usage: node scripts/loadtest.js [requests=2000] [concurrency=50]
const { request } = require('../shared/http');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TOTAL = Number(process.argv[2] || 2000);
const CONC = Number(process.argv[3] || 50);

async function run(label, fn) {
  const lat = []; let ok = 0; let errors = 0; let next = 0;
  const t0 = process.hrtime.bigint();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < TOTAL) {
      next += 1; const s = process.hrtime.bigint();
      try { const r = await fn(); if (r.status < 400) ok += 1; else errors += 1; } catch { errors += 1; }
      lat.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
  }));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
  const result = { label, requests: TOTAL, concurrency: CONC, ok, errors, rps: Math.round(TOTAL / secs), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };
  console.log(JSON.stringify(result));
  return result;
}

(async () => {
  const stamp = Date.now(); const email = `load${stamp}@foodhub.test`;
  await request(`${BASE}/api/auth/register`, { method: 'POST', body: { name: 'Load', email, password: 'Passw0rd!23' } });
  const { body } = await request(`${BASE}/api/auth/login`, { method: 'POST', body: { email, password: 'Passw0rd!23' } });
  const auth = { authorization: `Bearer ${body.token}` };
  const order = () => request(`${BASE}/api/orders`, { method: 'POST', headers: auth, timeout: 8000,
    body: { restaurantId: 'r1', items: [{ menuItemId: 'm1', qty: 1 }], paymentMethod: 'upi', paymentDetails: { vpa: 'load@bank' } } });

  await run('GET /api/restaurants (cached read)', () => request(`${BASE}/api/restaurants`));
  await run('GET /api/restaurants/r1/menu (cached read)', () => request(`${BASE}/api/restaurants/r1/menu`));
  await run('POST /api/orders (full saga: price+pay+confirm+event)', order);
  const stats = await request('http://localhost:4002/stats').catch(() => null);
  if (stats) console.log('restaurant cache stats:', JSON.stringify(stats.body));
})();
