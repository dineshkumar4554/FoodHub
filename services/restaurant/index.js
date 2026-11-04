'use strict';
// Restaurant Service: catalogue of restaurants & menus (read-heavy -> cache-aside with TTL).
const config = require('../../shared/config');
const { createApp, HttpError } = require('../../shared/http');
const { Repository } = require('../../shared/repository');
const { TTLCache } = require('../../shared/cache');
const { requireRole, requireInternal } = require('../../shared/events');
const { createLogger } = require('../../shared/logger');

const log = createLogger('restaurant-service');
const app = createApp('restaurant-service');
const restaurants = new Repository('restaurants');
const cache = new TTLCache({ ttlMs: config.CACHE_TTL_MS });

if (restaurants.all().length === 0) {
  const seed = [
    { id: 'r1', name: 'Spice Garden', cuisine: 'Indian', rating: 4.5, menu: [
      { id: 'm1', name: 'Paneer Butter Masala', price: 220, available: true },
      { id: 'm2', name: 'Chicken Biryani', price: 260, available: true },
      { id: 'm3', name: 'Garlic Naan', price: 45, available: true } ] },
    { id: 'r2', name: 'Pizza Palace', cuisine: 'Italian', rating: 4.2, menu: [
      { id: 'm4', name: 'Margherita Pizza', price: 299, available: true },
      { id: 'm5', name: 'Pasta Alfredo', price: 249, available: true } ] },
    { id: 'r3', name: 'Dragon Wok', cuisine: 'Chinese', rating: 4.0, menu: [
      { id: 'm6', name: 'Veg Hakka Noodles', price: 180, available: true },
      { id: 'm7', name: 'Manchurian', price: 170, available: false } ] },
  ];
  seed.forEach((r) => restaurants.set(r.id, r));
}

const summary = (r) => ({ id: r.id, name: r.name, cuisine: r.cuisine, rating: r.rating });

app.get('/restaurants', (req, res) => {
  const key = `list:${req.query.cuisine || ''}`;
  let data = cache.get(key);
  if (!data) {
    data = restaurants.filter((r) => !req.query.cuisine || r.cuisine.toLowerCase() === req.query.cuisine.toLowerCase()).map(summary);
    cache.set(key, data);
  }
  res.json(200, data);
});

app.get('/restaurants/:id/menu', (req, res) => {
  const key = `menu:${req.params.id}`;
  let data = cache.get(key);
  if (!data) {
    const r = restaurants.get(req.params.id);
    if (!r) throw new HttpError(404, 'restaurant_not_found');
    data = { restaurant: summary(r), menu: r.menu };
    cache.set(key, data);
  }
  res.json(200, data);
});

app.post('/restaurants/:id/menu', requireRole('restaurant', 'admin'), (req, res) => {
  const r = restaurants.get(req.params.id);
  if (!r) throw new HttpError(404, 'restaurant_not_found');
  const { name, price } = req.body;
  if (!name || !(price > 0)) throw new HttpError(400, 'invalid_menu_item');
  const item = { id: Repository.newId('m'), name, price: Number(price), available: true };
  r.menu.push(item); restaurants.set(r.id, r);
  cache.clear(); // invalidate on write
  res.json(201, item);
});

// Internal: bulk lookup used by the Order Service to price carts server-side (never trust client prices).
app.post('/menu-items/lookup', requireInternal, (req, res) => {
  const { restaurantId, ids } = req.body;
  const r = restaurants.get(restaurantId);
  if (!r) throw new HttpError(404, 'restaurant_not_found');
  res.json(200, { restaurant: summary(r), items: r.menu.filter((m) => (ids || []).includes(m.id)) });
});

app.get('/stats', (req, res) => res.json(200, cache.stats()));

if (require.main === module) {
  app.listen(config.ports.restaurant).then(() => log.info(`listening on ${config.ports.restaurant}`));
}
module.exports = { app };
