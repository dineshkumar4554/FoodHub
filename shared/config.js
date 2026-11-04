'use strict';
// Central configuration (12-factor style: everything overridable through env vars).
const env = process.env;

const config = {
  JWT_SECRET: env.JWT_SECRET || 'dev-secret-change-me',
  INTERNAL_KEY: env.INTERNAL_KEY || 'dev-internal-key',
  TOKEN_TTL_SECONDS: Number(env.TOKEN_TTL_SECONDS || 3600),
  CACHE_TTL_MS: Number(env.CACHE_TTL_MS ?? 30000),
  RATE_LIMIT_CAPACITY: Number(env.RATE_LIMIT_CAPACITY || 120),
  RATE_LIMIT_REFILL_PER_SEC: Number(env.RATE_LIMIT_REFILL_PER_SEC || 60),
  PERSIST: env.FOODHUB_PERSIST !== '0',
  DATA_DIR: env.DATA_DIR || 'data',
  ports: {
    gateway: Number(env.GATEWAY_PORT || 3000),
    bus: 4000, user: 4001, restaurant: 4002, order: 4003,
    payment: 4004, delivery: 4005, notification: 4006,
  },
  urls: {
    bus: env.BUS_URL || 'http://localhost:4000',
    user: env.USER_URL || 'http://localhost:4001',
    restaurant: env.RESTAURANT_URL || 'http://localhost:4002',
    order: env.ORDER_URL || 'http://localhost:4003',
    payment: env.PAYMENT_URL || 'http://localhost:4004',
    delivery: env.DELIVERY_URL || 'http://localhost:4005',
    notification: env.NOTIFICATION_URL || 'http://localhost:4006',
  },
};

if (env.NODE_ENV === 'production' &&
    (config.JWT_SECRET === 'dev-secret-change-me' || config.INTERNAL_KEY === 'dev-internal-key')) {
  throw new Error('Refusing to start in production with default JWT_SECRET / INTERNAL_KEY');
}
module.exports = config;
