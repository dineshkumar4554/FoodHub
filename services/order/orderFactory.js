'use strict';
// Factory Method pattern: one entry point builds a fully-validated, server-priced Order for each order type.
// Prices ALWAYS come from the catalogue (menuItems), never from the client.
const { HttpError } = require('../../shared/http');
const { Repository } = require('../../shared/repository');

const TAX_RATE = 0.05;
const round2 = (n) => Math.round(n * 100) / 100;

const creators = {
  standard: ({ subtotal }) => ({ deliveryFee: subtotal >= 500 ? 0 : 30, priority: false }),
  express: () => ({ deliveryFee: 60, priority: true }),
};

function normaliseCart(cart) {
  if (!Array.isArray(cart) || cart.length === 0 || cart.length > 30) throw new HttpError(400, 'invalid_cart', 'cart must have 1-30 lines');
  const merged = new Map();
  for (const line of cart) {
    const qty = Number(line.qty);
    if (!line.menuItemId || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'invalid_quantity', 'qty must be an integer 1-20');
    merged.set(line.menuItemId, (merged.get(line.menuItemId) || 0) + qty);
  }
  return merged;
}

function create(type = 'standard', { userId, restaurantId, cart, menuItems }) {
  const pricing = creators[type];
  if (!pricing) throw new HttpError(400, 'invalid_order_type');
  const lines = [];
  for (const [menuItemId, qty] of normaliseCart(cart)) {
    const item = menuItems.find((m) => m.id === menuItemId);
    if (!item) throw new HttpError(422, 'unknown_item', `menu item ${menuItemId} not found`);
    if (!item.available) throw new HttpError(422, 'item_unavailable', `${item.name} is currently unavailable`);
    lines.push({ menuItemId, name: item.name, price: item.price, qty });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const { deliveryFee, priority } = pricing({ subtotal });
  const tax = round2(subtotal * TAX_RATE);
  return {
    id: Repository.newId('ord'), userId, restaurantId, type, priority, items: lines,
    subtotal, tax, deliveryFee, total: round2(subtotal + tax + deliveryFee),
    status: 'PENDING_PAYMENT', paymentId: null, agentId: null,
    createdAt: new Date().toISOString(), history: [],
  };
}
module.exports = { create, TAX_RATE, creators };
