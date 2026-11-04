'use strict';
// State pattern (table-driven finite-state machine): an order can only move along legal transitions.
const { HttpError } = require('../../shared/http');

const TRANSITIONS = {
  PENDING_PAYMENT: ['CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY'],
  READY: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [], CANCELLED: [], PAYMENT_FAILED: [],
};

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function transition(order, to, reason) {
  if (!canTransition(order.status, to)) throw new HttpError(409, 'invalid_transition', `cannot move order from ${order.status} to ${to}`);
  order.status = to;
  order.history.push({ status: to, at: new Date().toISOString(), ...(reason ? { reason } : {}) });
  return order;
}
module.exports = { TRANSITIONS, canTransition, transition };
