'use strict';
// Cache-aside helper with TTL (performance tactic for read-heavy catalogue data).
class TTLCache {
  constructor({ ttlMs = 30000, now = Date.now } = {}) {
    Object.assign(this, { ttlMs, now }); this.map = new Map(); this.hits = 0; this.misses = 0;
  }
  get(key) {
    const e = this.map.get(key);
    if (e && e.exp > this.now()) { this.hits += 1; return e.value; }
    this.map.delete(key); this.misses += 1; return undefined;
  }
  set(key, value) { if (this.ttlMs > 0) this.map.set(key, { value, exp: this.now() + this.ttlMs }); }
  clear() { this.map.clear(); }
  stats() { return { hits: this.hits, misses: this.misses, size: this.map.size, ttlMs: this.ttlMs }; }
}
module.exports = { TTLCache };
