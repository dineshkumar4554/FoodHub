'use strict';
// API Gateway: single public entry point. Authentication, rate limiting, routing, circuit breaking, header hardening.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const config = require('../../shared/config');
const { request, agent } = require('../../shared/http');
const { verifyToken } = require('../../shared/auth');
const { CircuitBreaker } = require('../../shared/circuitBreaker');
const { RateLimiter } = require('../../shared/rateLimiter');
const { createLogger } = require('../../shared/logger');

const log = createLogger('api-gateway');
const limiter = new RateLimiter({ capacity: config.RATE_LIMIT_CAPACITY, refillPerSec: config.RATE_LIMIT_REFILL_PER_SEC });

const routes = [
  { prefix: '/api/auth', upstream: 'user', isPublic: () => true },
  { prefix: '/api/restaurants', upstream: 'restaurant', isPublic: (req) => req.method === 'GET' },
  { prefix: '/api/orders', upstream: 'order' },
  { prefix: '/api/deliveries', upstream: 'delivery' },
  { prefix: '/api/notifications', upstream: 'notification' },
];
const breakers = Object.fromEntries(routes.map((r) => [r.upstream, new CircuitBreaker({ name: r.upstream, failureThreshold: 5, resetTimeoutMs: 8000 })]));

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'cache-control': 'no-store', 'content-security-policy': "default-src 'none'",
};
// ---- Static web UI (frontend) --------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const UI_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  // scripts only from our own origin (no inline JS) -> strong XSS mitigation for the UI
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' }); // path-traversal guard
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-cache', ...UI_HEADERS });
    res.end(data);
  });
}

function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...SECURITY_HEADERS, ...extra });
  res.end(data);
}

async function health(res) {
  const names = Object.keys(config.urls).filter((k) => k !== 'bus').concat('bus');
  const results = await Promise.all(names.map(async (n) => {
    try { const r = await request(`${config.urls[n]}/health`, { timeout: 1000 }); return [n, r.status === 200 ? 'UP' : 'DEGRADED']; }
    catch { return [n, 'DOWN']; }
  }));
  const services = Object.fromEntries(results);
  const allUp = Object.values(services).every((s) => s === 'UP');
  send(res, allUp ? 200 : 503, { status: allUp ? 'UP' : 'DEGRADED', services, circuits: Object.fromEntries(Object.entries(breakers).map(([k, b]) => [k, b.state])) });
}

function proxy(req, res, route, user, requestId) {
  const breaker = breakers[route.upstream];
  if (!breaker.canRequest()) return send(res, 503, { error: 'service_unavailable', circuit: 'OPEN', service: route.upstream }, { 'retry-after': '8' });
  const target = new URL(config.urls[route.upstream]);
  const headers = { ...req.headers, host: target.host, 'x-request-id': requestId };
  // never trust identity headers coming from the outside world
  for (const h of ['x-user-id', 'x-user-role', 'x-user-name', 'x-internal-key']) delete headers[h];
  if (user) Object.assign(headers, { 'x-user-id': user.sub, 'x-user-role': user.role, 'x-user-name': user.name });
  const upstreamReq = http.request({
    hostname: target.hostname, port: target.port, agent, method: req.method, headers,
    path: req.url.replace(/^\/api/, ''), timeout: 6000,
  }, (up) => {
    if (up.statusCode >= 500) breaker.onFailure(); else breaker.onSuccess();
    res.writeHead(up.statusCode, { ...up.headers, ...SECURITY_HEADERS, 'x-request-id': requestId });
    up.pipe(res);
  });
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('timeout')));
  upstreamReq.on('error', () => {
    breaker.onFailure();
    if (!res.headersSent) send(res, 502, { error: 'bad_gateway', service: route.upstream });
  });
  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.on('finish', () => log.info('request', { id: requestId, method: req.method, url: req.url.split('?')[0], status: res.statusCode, ms: Date.now() - started }));

  const pathName = req.url.split('?')[0];
  if (pathName === '/health') return health(res);

  const ip = req.socket.remoteAddress;
  if (!limiter.allow(ip)) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '1' });

  if (req.method === 'GET' && !pathName.startsWith('/api')) return serveStatic(req, res, pathName);

  const route = routes.find((r) => pathName === r.prefix || pathName.startsWith(`${r.prefix}/`));
  if (!route) return send(res, 404, { error: 'not_found' });

  let user = null;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) user = verifyToken(auth.slice(7), config.JWT_SECRET);
  const isPublic = route.isPublic && route.isPublic(req);
  if (!user && !isPublic) return send(res, 401, { error: 'unauthenticated', message: 'valid Bearer token required' }, { 'www-authenticate': 'Bearer' });
  proxy(req, res, route, user, requestId);
});

if (require.main === module) {
  server.listen(config.ports.gateway, () => log.info(`listening on ${config.ports.gateway}`));
}
module.exports = { server, routes };
