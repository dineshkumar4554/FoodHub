'use strict';
// Repository pattern: services depend on this interface, not on a concrete database.
// Default implementation = in-memory Map with JSON snapshot persistence (swap for PostgreSQL/MongoDB in production).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

class Repository {
  constructor(name, { persist = config.PERSIST, dir = config.DATA_DIR } = {}) {
    this.name = name; this.persist = persist; this.map = new Map();
    this.file = path.join(dir, `${name}.json`); this.timer = null;
    if (persist) {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        try { for (const [k, v] of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.map.set(k, v); }
        catch { /* corrupt snapshot -> start empty */ }
      }
    }
  }
  static newId(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
  get(id) { return this.map.get(id); }
  set(id, value) { this.map.set(id, value); this.schedule(); return value; }
  delete(id) { this.map.delete(id); this.schedule(); }
  all() { return [...this.map.values()]; }
  find(pred) { return this.all().find(pred); }
  filter(pred) { return this.all().filter(pred); }
  schedule() {
    if (!this.persist || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      fs.writeFile(this.file, JSON.stringify([...this.map.entries()]), () => {});
    }, 100);
    this.timer.unref();
  }
}
module.exports = { Repository };
