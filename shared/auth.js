'use strict';
// Stateless signed tokens (HS256 JWT-compatible) + password hashing with scrypt.
const crypto = require('crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function signToken(payload, secret, ttlSeconds = 3600, now = Date.now) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now() / 1000);
  const body = b64(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }));
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

function verifyToken(token, secret, now = Date.now) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'));
  const stored = Buffer.from(hash);
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

module.exports = { signToken, verifyToken, hashPassword, verifyPassword };
