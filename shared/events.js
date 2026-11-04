'use strict';
// Event-driven integration helpers (publish / subscribe through the Event Bus service).
const crypto = require('crypto');
const config = require('./config');
const { request } = require('./http');
const { retry } = require('./retry');
const { createLogger } = require('./logger');

async function sendEvent(event) {
  const res = await request(`${config.urls.bus}/publish`, { method: 'POST', body: event });
  if (res.status >= 300) throw new Error(`bus responded ${res.status}`);
}

async function publish(source, topic, data) {
  const event = { id: crypto.randomUUID(), topic, source, ts: new Date().toISOString(), data };
  await retry(() => sendEvent(event), { attempts: 4, baseMs: 100 });
  return event;
}

// Registers an HTTP callback for each topic on the bus. Re-registers periodically so a bus restart is self-healing.
// Handlers are idempotent: duplicate deliveries (bus retries) are ignored by event id.
function subscribe(app, service, selfUrl, handlers) {
  const log = createLogger(service);
  const seen = new Set();
  for (const [topic, handler] of Object.entries(handlers)) {
    app.post(`/events/${topic}`, async (req, res) => {
      const event = req.body;
      if (event.id && seen.has(event.id)) return res.json(200, { duplicate: true });
      if (event.id) { seen.add(event.id); if (seen.size > 5000) seen.delete(seen.values().next().value); }
      try { await handler(event.data, event); res.json(200, { ok: true }); }
      catch (err) { log.error('event handler failed', { topic, error: err.message }); seen.delete(event.id); res.json(500, { error: 'handler_failed' }); }
    });
  }
  const register = async () => {
    for (const topic of Object.keys(handlers)) {
      await request(`${config.urls.bus}/subscribe`, {
        method: 'POST', body: { service, topic, url: `${selfUrl}/events/${topic}` },
      }).catch(() => {});
    }
  };
  retry(async () => { const r = await request(`${config.urls.bus}/health`); if (r.status !== 200) throw new Error('bus down'); },
    { attempts: 20, baseMs: 250 }).catch(() => {}).then(register);
  setInterval(register, 10000).unref();
}

// Defence in depth: internal-only endpoints require a shared key even inside the private network.
function requireInternal(req, res) {
  if (req.headers['x-internal-key'] !== config.INTERNAL_KEY) res.json(403, { error: 'forbidden', message: 'internal endpoint' });
}
function requireRole(...roles) {
  return (req, res) => {
    if (!req.user) return res.json(401, { error: 'unauthenticated' });
    if (!roles.includes(req.user.role)) res.json(403, { error: 'forbidden', message: `requires role: ${roles.join('/')}` });
  };
}
module.exports = { publish, sendEvent, subscribe, requireInternal, requireRole };
