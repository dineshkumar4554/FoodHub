'use strict';
// Event Bus: lightweight publish/subscribe broker (Observer pattern at system level).
// At-least-once delivery with exponential-backoff retries and a dead-letter list.
const config = require('../../shared/config');
const { createApp, HttpError, request } = require('../../shared/http');
const { retry } = require('../../shared/retry');
const { createLogger } = require('../../shared/logger');

const log = createLogger('event-bus');
const app = createApp('event-bus');
const subscriptions = new Map(); // `${topic}|${service}` -> url
const recent = []; const deadLetters = [];
const stats = { published: 0, delivered: 0, retried: 0, dead: 0 };

app.post('/subscribe', (req, res) => {
  const { service, topic, url } = req.body;
  if (!service || !topic || !url) throw new HttpError(400, 'invalid_subscription');
  subscriptions.set(`${topic}|${service}`, url);
  res.json(200, { subscribed: true });
});

async function deliver(url, event) {
  try {
    await retry(async (i) => {
      if (i > 0) stats.retried += 1;
      const r = await request(url, { method: 'POST', body: event, timeout: 2000 });
      if (r.status >= 500) throw new Error(`subscriber responded ${r.status}`);
    }, { attempts: 5, baseMs: 100 });
    stats.delivered += 1;
  } catch (err) {
    stats.dead += 1; deadLetters.push({ event, url, error: err.message, at: new Date().toISOString() });
    if (deadLetters.length > 200) deadLetters.shift();
    log.warn('moved to dead-letter', { topic: event.topic, url, error: err.message });
  }
}

app.post('/publish', (req, res) => {
  const event = req.body;
  if (!event.topic || !event.id) throw new HttpError(400, 'invalid_event');
  stats.published += 1; recent.push({ id: event.id, topic: event.topic, ts: event.ts, source: event.source });
  if (recent.length > 100) recent.shift();
  const targets = [...subscriptions.entries()].filter(([k]) => k.startsWith(`${event.topic}|`)).map(([, url]) => url);
  targets.forEach((url) => { deliver(url, event); }); // asynchronous fan-out
  res.json(202, { accepted: true, subscribers: targets.length });
});

app.get('/stats', (req, res) => res.json(200, { ...stats, subscriptions: subscriptions.size, deadLetters: deadLetters.length }));
app.get('/events', (req, res) => res.json(200, recent));
app.get('/dead-letters', (req, res) => res.json(200, deadLetters));

if (require.main === module) {
  app.listen(config.ports.bus).then(() => log.info(`listening on ${config.ports.bus}`));
}
module.exports = { app };
