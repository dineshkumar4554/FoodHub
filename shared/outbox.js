'use strict';
// Transactional-outbox style publisher: the event is persisted BEFORE it is sent, then removed once the bus
// acknowledges it. If the bus is down the event stays queued and is re-sent -> events are never silently lost.
// Delivery is at-least-once; subscribers de-duplicate by event id.
const crypto = require('crypto');
const { Repository } = require('./repository');
const { sendEvent } = require('./events');

function createOutbox(source, { intervalMs = 2000 } = {}) {
  const repo = new Repository(`${source}-outbox`);
  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      for (const e of repo.all()) {
        try { await sendEvent(e); repo.delete(e.id); } catch { break; } // bus still down -> retry next tick
      }
    } finally { flushing = false; }
  }
  async function emit(topic, data) {
    const event = { id: crypto.randomUUID(), topic, source, ts: new Date().toISOString(), data };
    repo.set(event.id, event);
    try { await sendEvent(event); repo.delete(event.id); } catch { /* stays in outbox */ }
    return event;
  }
  setInterval(flush, intervalMs).unref();
  return { emit, flush, pending: () => repo.all().length };
}
module.exports = { createOutbox };
