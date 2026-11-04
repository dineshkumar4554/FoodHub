'use strict';
// Strategy pattern: each payment method is an interchangeable algorithm behind one interface:
//   validate(details) -> error string | null
//   charge({ userId, amount, details }) -> { ok, masked? , reason? }
//   refund({ userId, amount }) -> void
// Adding a new method (e.g. NetBanking) = adding one class; PaymentService is untouched (Open/Closed Principle).

function luhn(number) {
  const digits = String(number).replace(/\s+/g, '');
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

class CardStrategy {
  constructor(now = () => new Date()) { this.now = now; }
  validate({ number, expiry, cvv } = {}) {
    if (!luhn(number || '')) return 'invalid_card_number';
    const m = /^(\d{2})\/(\d{2})$/.exec(expiry || '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return 'invalid_expiry';
    const n = this.now();
    const expYear = 2000 + Number(m[2]);
    if (expYear < n.getFullYear() || (expYear === n.getFullYear() && Number(m[1]) < n.getMonth() + 1)) return 'card_expired';
    if (!/^\d{3,4}$/.test(String(cvv || ''))) return 'invalid_cvv';
    return null;
  }
  async charge({ details }) {
    const digits = details.number.replace(/\s+/g, '');
    if (digits.endsWith('0002')) return { ok: false, reason: 'card_declined' }; // simulated issuer decline
    return { ok: true, masked: `**** ${digits.slice(-4)}` }; // full PAN / CVV are never stored
  }
  async refund() { /* gateway refund simulated */ }
}

class UpiStrategy {
  validate({ vpa } = {}) { return /^[\w.-]{2,}@[a-z]{2,}$/i.test(vpa || '') ? null : 'invalid_vpa'; }
  async charge({ details }) {
    if (details.vpa.toLowerCase().startsWith('fail')) return { ok: false, reason: 'upi_declined' };
    return { ok: true, masked: details.vpa.replace(/^(.{2}).*(@.*)$/, '$1***$2') };
  }
  async refund() { /* gateway refund simulated */ }
}

class WalletStrategy {
  constructor(wallets, initialBalance = 1000) { this.wallets = wallets; this.initialBalance = initialBalance; }
  balanceOf(userId) { return (this.wallets.get(userId) || { balance: this.initialBalance }).balance; }
  validate() { return null; }
  async charge({ userId, amount }) {
    const balance = this.balanceOf(userId);
    if (balance < amount) return { ok: false, reason: 'insufficient_wallet_balance' };
    this.wallets.set(userId, { balance: Number((balance - amount).toFixed(2)) });
    return { ok: true, masked: 'wallet' };
  }
  async refund({ userId, amount }) {
    this.wallets.set(userId, { balance: Number((this.balanceOf(userId) + amount).toFixed(2)) });
  }
}

function createStrategies({ wallets, now } = {}) {
  return { card: new CardStrategy(now), upi: new UpiStrategy(), wallet: new WalletStrategy(wallets) };
}
module.exports = { luhn, CardStrategy, UpiStrategy, WalletStrategy, createStrategies };
