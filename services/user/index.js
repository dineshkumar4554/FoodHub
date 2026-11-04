'use strict';
// User Service: registration, authentication (scrypt + signed tokens), profile.
const config = require('../../shared/config');
const { createApp, HttpError } = require('../../shared/http');
const { Repository } = require('../../shared/repository');
const { signToken, hashPassword, verifyPassword } = require('../../shared/auth');
const { createLogger } = require('../../shared/logger');

const log = createLogger('user-service');
const app = createApp('user-service');
const users = new Repository('users');
const ROLES = ['customer', 'restaurant', 'agent']; // admin accounts cannot be self-registered
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicView = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

app.post('/auth/register', (req, res) => {
  const { name, email, password, role = 'customer' } = req.body;
  if (!name || typeof name !== 'string' || name.length > 80) throw new HttpError(400, 'invalid_name');
  if (!EMAIL_RE.test(email || '')) throw new HttpError(400, 'invalid_email');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'weak_password', 'password must be at least 8 characters');
  if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
  if (users.find((u) => u.email === email.toLowerCase())) throw new HttpError(409, 'email_taken');
  const { salt, hash } = hashPassword(password);
  const id = Repository.newId('usr');
  const user = users.set(id, { id, name, email: email.toLowerCase(), role, salt, hash });
  log.info('user registered', { id, role });
  res.json(201, publicView(user));
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find((u) => u.email === String(email || '').toLowerCase());
  // same error for unknown user / wrong password -> no user enumeration
  if (!user || !verifyPassword(String(password || ''), user.salt, user.hash)) throw new HttpError(401, 'invalid_credentials');
  const token = signToken({ sub: user.id, role: user.role, name: user.name }, config.JWT_SECRET, config.TOKEN_TTL_SECONDS);
  res.json(200, { token, expiresIn: config.TOKEN_TTL_SECONDS, user: publicView(user) });
});

app.get('/auth/me', (req, res) => {
  if (!req.user) throw new HttpError(401, 'unauthenticated');
  const user = users.get(req.user.id);
  if (!user) throw new HttpError(404, 'user_not_found');
  res.json(200, publicView(user));
});

if (require.main === module) {
  app.listen(config.ports.user).then(() => log.info(`listening on ${config.ports.user}`));
}
module.exports = { app };
