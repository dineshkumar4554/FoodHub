'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry with exponential backoff (used for event publishing & subscription registration).
async function retry(fn, { attempts = 4, baseMs = 100 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(i); } catch (err) { lastErr = err; if (i < attempts - 1) await sleep(baseMs * 2 ** i); }
  }
  throw lastErr;
}
module.exports = { retry, sleep };
