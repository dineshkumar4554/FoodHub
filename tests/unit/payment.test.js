'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { luhn, createStrategies } = require('../../services/payment/strategies');
const { Repository } = require('../../shared/repository');

const wallets = new Repository('test-wallets', { persist: false });
const s = createStrategies({ wallets, now: () => new Date('2026-10-29') });

test('Luhn check accepts valid and rejects invalid card numbers', () => {
  assert.ok(luhn('4242 4242 4242 4242')); assert.ok(!luhn('4242 4242 4242 4241')); assert.ok(!luhn('abcd'));
});
test('card strategy validates number, expiry and cvv', () => {
  assert.equal(s.card.validate({ number: '4242424242424242', expiry: '12/30', cvv: '123' }), null);
  assert.equal(s.card.validate({ number: '1234', expiry: '12/30', cvv: '123' }), 'invalid_card_number');
  assert.equal(s.card.validate({ number: '4242424242424242', expiry: '01/20', cvv: '123' }), 'card_expired');
  assert.equal(s.card.validate({ number: '4242424242424242', expiry: '12/30', cvv: '1' }), 'invalid_cvv');
});
test('card charge masks the PAN and simulates issuer decline', async () => {
  const ok = await s.card.charge({ details: { number: '4242 4242 4242 4242' } });
  assert.deepEqual(ok, { ok: true, masked: '**** 4242' });
  assert.equal((await s.card.charge({ details: { number: '4000 0000 0000 0002' } })).reason, 'card_declined');
});
test('UPI strategy validates VPA format', async () => {
  assert.equal(s.upi.validate({ vpa: 'alice@bank' }), null); assert.equal(s.upi.validate({ vpa: 'nope' }), 'invalid_vpa');
  assert.equal((await s.upi.charge({ details: { vpa: 'fail@bank' } })).ok, false);
});
test('wallet strategy debits, rejects insufficient balance and refunds', async () => {
  assert.equal((await s.wallet.charge({ userId: 'u1', amount: 400 })).ok, true);
  assert.equal(s.wallet.balanceOf('u1'), 600);
  assert.equal((await s.wallet.charge({ userId: 'u1', amount: 700 })).reason, 'insufficient_wallet_balance');
  await s.wallet.refund({ userId: 'u1', amount: 400 });
  assert.equal(s.wallet.balanceOf('u1'), 1000);
});
