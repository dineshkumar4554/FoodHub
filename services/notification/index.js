'use strict';
// Notification Service: a pure subscriber (Observer). Order flow never waits for, or fails because of, notifications.
const config = require('../../shared/config');
const { createApp } = require('../../shared/http');
const { Repository } = require('../../shared/repository');
const { subscribe, requireRole } = require('../../shared/events');
const { createLogger } = require('../../shared/logger');

const log = createLogger('notification-service');
const app = createApp('notification-service');
const inbox = new Repository('notifications');

// Channels share one interface -> new channel (WhatsApp, ...) is a new object in this list.
const channels = [
  { name: 'push', send: (n) => log.info('push sent', { userId: n.userId, message: n.message }) },
  { name: 'email', send: (n) => log.info('email sent', { userId: n.userId, subject: n.topic }) },
];

const templates = {
  'order.placed': (d) => `Order ${d.orderId} confirmed at ${d.restaurantName} (total ₹${d.total}).`,
  'order.status_changed': (d) => `Your order ${d.orderId} is now ${d.status}.`,
  'order.cancelled': (d) => `Order ${d.orderId} was cancelled. Any payment will be refunded.`,
  'payment.failed': (d) => `Payment for order ${d.orderId} failed (${d.reason}).`,
  'payment.refunded': (d) => `Refund of ₹${d.amount} for order ${d.orderId} processed.`,
  'delivery.assigned': (d) => `${d.agentName || 'A delivery partner'} is assigned to order ${d.orderId}. ETA ${d.etaMinutes} min.`,
  'delivery.picked_up': (d) => `Order ${d.orderId} is out for delivery.`,
  'delivery.delivered': (d) => `Order ${d.orderId} delivered. Enjoy your meal!`,
};

const handlers = {};
for (const [topic, tpl] of Object.entries(templates)) {
  handlers[topic] = async (data) => {
    if (!data.userId) return;
    const n = { id: Repository.newId('ntf'), userId: data.userId, topic, message: tpl(data), channels: channels.map((c) => c.name), at: new Date().toISOString() };
    inbox.set(n.id, n);
    channels.forEach((c) => c.send(n));
  };
}
subscribe(app, 'notification-service', config.urls.notification, handlers);

app.get('/notifications', requireRole('customer', 'restaurant', 'agent', 'admin'), (req, res) => {
  const list = inbox.filter((n) => req.user.role === 'admin' || n.userId === req.user.id);
  res.json(200, list.sort((a, b) => a.at.localeCompare(b.at)));
});

if (require.main === module) {
  app.listen(config.ports.notification).then(() => log.info(`listening on ${config.ports.notification}`));
}
module.exports = { app };
