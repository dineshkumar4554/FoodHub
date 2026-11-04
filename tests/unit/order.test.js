'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OrderFactory = require('../../services/order/orderFactory');
const { transition, canTransition } = require('../../services/order/orderState');

const menu = [
  { id: 'm1', name: 'Paneer', price: 220, available: true },
  { id: 'm3', name: 'Naan', price: 45, available: true },
  { id: 'm7', name: 'Manchurian', price: 170, available: false },
];
const base = { userId: 'u1', restaurantId: 'r1', menuItems: menu };

test('factory prices the order server-side: subtotal + 5% tax + delivery fee', () => {
  const o = OrderFactory.create('standard', { ...base, cart: [{ menuItemId: 'm1', qty: 2 }, { menuItemId: 'm3', qty: 3 }] });
  assert.equal(o.subtotal, 575); assert.equal(o.tax, 28.75); assert.equal(o.deliveryFee, 0); assert.equal(o.total, 603.75);
  assert.equal(o.status, 'PENDING_PAYMENT');
});
test('small orders pay a delivery fee; express costs more and is prioritised', () => {
  const std = OrderFactory.create('standard', { ...base, cart: [{ menuItemId: 'm3', qty: 1 }] });
  assert.equal(std.deliveryFee, 30);
  const exp = OrderFactory.create('express', { ...base, cart: [{ menuItemId: 'm3', qty: 1 }] });
  assert.equal(exp.deliveryFee, 60); assert.equal(exp.priority, true);
});
test('factory merges duplicate lines and rejects bad input', () => {
  const o = OrderFactory.create('standard', { ...base, cart: [{ menuItemId: 'm3', qty: 1 }, { menuItemId: 'm3', qty: 2 }] });
  assert.equal(o.items.length, 1); assert.equal(o.items[0].qty, 3);
  assert.throws(() => OrderFactory.create('standard', { ...base, cart: [] }), { code: 'invalid_cart' });
  assert.throws(() => OrderFactory.create('standard', { ...base, cart: [{ menuItemId: 'm1', qty: 0 }] }), { code: 'invalid_quantity' });
  assert.throws(() => OrderFactory.create('standard', { ...base, cart: [{ menuItemId: 'zz', qty: 1 }] }), { code: 'unknown_item' });
  assert.throws(() => OrderFactory.create('standard', { ...base, cart: [{ menuItemId: 'm7', qty: 1 }] }), { code: 'item_unavailable' });
  assert.throws(() => OrderFactory.create('drone', { ...base, cart: [{ menuItemId: 'm1', qty: 1 }] }), { code: 'invalid_order_type' });
});
test('state machine allows only legal transitions', () => {
  assert.ok(canTransition('PENDING_PAYMENT', 'CONFIRMED')); assert.ok(!canTransition('DELIVERED', 'CANCELLED'));
  const o = { status: 'CONFIRMED', history: [] };
  transition(o, 'PREPARING'); assert.equal(o.status, 'PREPARING'); assert.equal(o.history.length, 1);
  assert.throws(() => transition(o, 'CANCELLED'), { code: 'invalid_transition' });
});
