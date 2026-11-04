'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signToken, verifyToken, hashPassword, verifyPassword } = require('../../shared/auth');
const { CircuitBreaker, CircuitOpenError } = require('../../shared/circuitBreaker');
const { RateLimiter } = require('../../shared/rateLimiter');
const { TTLCache } = require('../../shared/cache');
const { retry } = require('../../shared/retry');
const { mask } = require('../../shared/logger');

test('token round-trip returns the payload', () => {
  const t = signToken({ sub: 'u1', role: 'customer' }, 's3cret', 60);
  const p = verifyToken(t, 's3cret');
  assert.equal(p.sub, 'u1'); assert.equal(p.role, 'customer');
});
test('tampered / wrong-secret / expired tokens are rejected', () => {
  const t = signToken({ sub: 'u1', role: 'customer' }, 's3cret', 60);
  const [h, , sig] = t.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'u1', role: 'admin', exp: 9999999999 })).toString('base64url')}.${sig}`;
  assert.equal(verifyToken(forged, 's3cret'), null);
  assert.equal(verifyToken(t, 'other'), null);
  const past = signToken({ sub: 'u1' }, 's3cret', 10, () => Date.now() - 60000);
  assert.equal(verifyToken(past, 's3cret'), null);
  assert.equal(verifyToken('garbage', 's3cret'), null);
});
test('passwords are salted + hashed and verifiable', () => {
  const a = hashPassword('Passw0rd!23'); const b = hashPassword('Passw0rd!23');
  assert.notEqual(a.hash, b.hash);
  assert.ok(verifyPassword('Passw0rd!23', a.salt, a.hash));
  assert.ok(!verifyPassword('wrong-password', a.salt, a.hash));
});

test('circuit breaker opens after threshold, half-opens after cool-down, closes on success', async () => {
  let now = 0; const cb = new CircuitBreaker({ name: 'x', failureThreshold: 2, resetTimeoutMs: 1000, now: () => now });
  const fail = () => Promise.reject(new Error('boom'));
  await assert.rejects(cb.exec(fail)); await assert.rejects(cb.exec(fail));
  assert.equal(cb.state, 'OPEN');
  await assert.rejects(cb.exec(async () => 'ok'), CircuitOpenError);   // fails fast, fn not called
  now = 1500;
  assert.equal(await cb.exec(async () => 'ok'), 'ok');                   // trial request succeeds
  assert.equal(cb.state, 'CLOSED');
});
test('half-open failure re-opens the circuit immediately', async () => {
  let now = 0; const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => now });
  await assert.rejects(cb.exec(() => Promise.reject(new Error('x'))));
  now = 200;
  await assert.rejects(cb.exec(() => Promise.reject(new Error('x'))));
  assert.equal(cb.state, 'OPEN');
});

test('token bucket allows a burst then throttles, and refills over time', () => {
  let now = 0; const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allow('ip')), [true, true, true, false]);
  assert.ok(rl.allow('other-ip'));
  now = 2000; assert.ok(rl.allow('ip'));
});

test('cache honours TTL and tracks hit/miss stats', () => {
  let now = 0; const c = new TTLCache({ ttlMs: 100, now: () => now });
  assert.equal(c.get('k'), undefined); c.set('k', 1);
  assert.equal(c.get('k'), 1); now = 150; assert.equal(c.get('k'), undefined);
  assert.deepEqual([c.stats().hits, c.stats().misses], [1, 2]);
});

test('retry retries with backoff then succeeds / finally throws', async () => {
  let n = 0;
  assert.equal(await retry(async () => { n += 1; if (n < 3) throw new Error('x'); return 'ok'; }, { attempts: 4, baseMs: 1 }), 'ok');
  await assert.rejects(retry(async () => { throw new Error('always'); }, { attempts: 2, baseMs: 1 }), /always/);
});

test('logger masks sensitive fields', () => {
  const m = mask({ user: 'a', password: 'p', nested: { cvv: '123', ok: 1 } });
  assert.equal(m.password, '***'); assert.equal(m.nested.cvv, '***'); assert.equal(m.nested.ok, 1);
});
