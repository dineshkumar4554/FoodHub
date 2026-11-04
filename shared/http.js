'use strict';
// Minimal HTTP micro-framework (router + JSON body parsing + client) with zero dependencies.
const http = require('http');
const { URL } = require('url');

const MAX_BODY_BYTES = 100 * 1024;
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new HttpError(400, 'invalid_json')); }
    });
    req.on('error', reject);
  });
}

function createApp(name = 'app') {
  const routes = [];
  const add = (method) => (path, ...handlers) => {
    const keys = [];
    const source = path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handlers });
  };

  const app = {
    name,
    get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE'),
    async handle(req, res) {
      res.json = (status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
        res.end(data);
      };
      try {
        const url = new URL(req.url, 'http://internal');
        req.query = Object.fromEntries(url.searchParams);
        req.path = url.pathname;
        const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!route) return res.json(404, { error: 'not_found' });
        const m = url.pathname.match(route.re);
        req.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        req.body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
        req.user = req.headers['x-user-id']
          ? { id: req.headers['x-user-id'], role: req.headers['x-user-role'], name: req.headers['x-user-name'] }
          : null;
        for (const h of route.handlers) {
          await h(req, res);
          if (res.writableEnded) return;
        }
      } catch (err) {
        if (err instanceof HttpError) return res.json(err.status, { error: err.code, message: err.message });
        console.error(`[${name}] unhandled`, err);
        if (!res.writableEnded) res.json(500, { error: 'internal_error' });
      }
    },
    listen(port) {
      return new Promise((resolve) => {
        const server = http.createServer((q, s) => app.handle(q, s));
        server.listen(port, () => resolve(server));
      });
    },
  };
  app.get('/health', (req, res) => res.json(200, { status: 'UP', service: name }));
  return app;
}

function request(url, { method = 'GET', headers = {}, body, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data = text; try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { createApp, request, HttpError, agent };
