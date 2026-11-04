'use strict';
// Structured (JSON-lines) logger with masking of sensitive fields.
const SENSITIVE = /(password|secret|token|cvv|card|number|authorization)/i;

function mask(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '***' : mask(v, depth + 1);
  }
  return out;
}

function createLogger(service) {
  const quiet = process.env.LOG_LEVEL === 'silent';
  const log = (level, msg, meta) => {
    if (quiet) return;
    const line = { ts: new Date().toISOString(), level, service, msg, ...(meta ? { meta: mask(meta) } : {}) };
    (level === 'error' ? console.error : console.log)(JSON.stringify(line));
  };
  return {
    info: (m, meta) => log('info', m, meta),
    warn: (m, meta) => log('warn', m, meta),
    error: (m, meta) => log('error', m, meta),
  };
}
module.exports = { createLogger, mask };
