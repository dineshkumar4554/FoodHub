'use strict';
// Token-bucket rate limiter (per key). Protects the platform from abusive clients / bursts.
class RateLimiter {
  constructor({ capacity = 120, refillPerSec = 60, now = Date.now } = {}) {
    Object.assign(this, { capacity, refillPerSec, now });
    this.buckets = new Map();
    const t = setInterval(() => this.sweep(), 60000); t.unref();
  }
  allow(key) {
    const t = this.now();
    const b = this.buckets.get(key) || { tokens: this.capacity, last: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.last) / 1000) * this.refillPerSec);
    b.last = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }
  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.last > 120000) this.buckets.delete(k);
  }
}
module.exports = { RateLimiter };
