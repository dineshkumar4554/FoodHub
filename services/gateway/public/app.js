'use strict';
// FoodHub web UI — a dependency-free single-page app that talks ONLY to the API gateway (/api/*).
// Security notes: all dynamic text is escaped (XSS), no inline event handlers (strict CSP: script-src 'self'),
// the bearer token lives in sessionStorage and is dropped on any 401.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => '₹' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: round2(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  const EMOJI = { indian: '🍛', italian: '🍕', chinese: '🥡' };
  const STATUS = { PENDING_PAYMENT: 'Awaiting payment', CONFIRMED: 'Confirmed', PREPARING: 'Preparing', READY: 'Ready for pickup', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', PAYMENT_FAILED: 'Payment failed' };
  const FLOW = ['CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  const ACTIVE = ['CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];
  const NAV = {
    customer: [['restaurants', 'Restaurants'], ['orders', 'My orders'], ['notifications', 'Notifications'], ['status', 'System status']],
    restaurant: [['incoming', 'Incoming orders'], ['menu', 'Menu manager'], ['notifications', 'Notifications'], ['status', 'System status']],
    agent: [['deliveries', 'My deliveries'], ['notifications', 'Notifications'], ['status', 'System status']],
  };
  const HOME = { customer: 'restaurants', restaurant: 'incoming', agent: 'deliveries' };

  const saved = (() => { try { return JSON.parse(sessionStorage.getItem('foodhub.session') || 'null'); } catch { return null; } })();
  const state = {
    token: saved && saved.token, user: saved && saved.user, view: '', authTab: 'login',
    restaurants: [], cuisine: '', selected: null, menu: [],
    cart: { restaurantId: null, restaurantName: '', items: {} }, orders: [], deliveries: {},
    notes: [], notesSeen: 0, managed: 'r1', managedMenu: [], agentOnline: false,
  };
  let poll = null; let tick = 0;

  // ---------------------------------------------------------------- API
  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(path.startsWith('/health') ? path : `/api${path}`, {
      method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    if (!res) return { ok: false, status: 0, data: { error: 'network_error', message: 'Cannot reach the server' } };
    let data = null; try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && state.token) logout('Session expired — please sign in again');
    return { ok: res.ok, status: res.status, data };
  }
  const errText = (r) => (r.data && (r.data.message || r.data.error)) || `Request failed (${r.status})`;

  function toast(msg, type = '') {
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4200);
  }

  // ---------------------------------------------------------------- session
  function saveSession() { sessionStorage.setItem('foodhub.session', JSON.stringify({ token: state.token, user: state.user })); }
  function logout(message) {
    clearInterval(poll); sessionStorage.removeItem('foodhub.session');
    Object.assign(state, { token: null, user: null, cart: { restaurantId: null, restaurantName: '', items: {} }, orders: [], notes: [], notesSeen: 0, selected: null, view: '' });
    render(); if (message) toast(message, 'error');
  }
  async function signIn(email, password) {
    const r = await api('/auth/login', { method: 'POST', body: { email, password } });
    if (!r.ok) return r;
    state.token = r.data.token; state.user = r.data.user; saveSession();
    state.view = HOME[state.user.role]; render();
    toast(`Welcome, ${state.user.name}!`, 'success');
    return r;
  }

  // ---------------------------------------------------------------- auth screen
  function renderAuth() {
    clearInterval(poll);
    const reg = state.authTab === 'register';
    $('#app').innerHTML = `
      <div class="auth-wrap">
        <section class="auth-hero">
          <h1>🍔 FoodHub</h1>
          <p class="tag">Order. Cook. Deliver. — powered by event-driven microservices.</p>
          <ul>
            <li>Browse restaurants and order in a few taps</li>
            <li>Pay by card, UPI or wallet — safely processed</li>
            <li>Track every step: confirmed → preparing → delivered</li>
            <li>Restaurant and delivery-agent consoles included</li>
          </ul>
        </section>
        <section class="auth-form"><div class="auth-card card">
          <div class="tabs"><button data-action="authTab" data-tab="login" class="${reg ? '' : 'active'}">Sign in</button><button data-action="authTab" data-tab="register" class="${reg ? 'active' : ''}">Create account</button></div>
          <form data-form="${reg ? 'register' : 'login'}" autocomplete="on">
            ${reg ? '<label>Full name</label><input name="name" required maxlength="80" placeholder="Your name">' : ''}
            <label>Email</label><input name="email" type="email" required placeholder="you@example.com" autocomplete="username">
            <label>Password</label><input name="password" type="password" required minlength="${reg ? 8 : 1}" placeholder="${reg ? 'At least 8 characters' : 'Your password'}" autocomplete="${reg ? 'new-password' : 'current-password'}">
            ${reg ? '<label>I am a…</label><select name="role"><option value="customer">Customer (order food)</option><option value="restaurant">Restaurant owner</option><option value="agent">Delivery agent</option></select>' : ''}
            <div class="error-text" id="auth-error"></div>
            <button class="btn block" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
          </form>
          <div class="demo-box"><p>Quick demo accounts (created automatically):</p>
            <div class="row"><button class="btn secondary small" data-action="demo" data-role="customer">🧑 Customer</button><button class="btn secondary small" data-action="demo" data-role="restaurant">🏪 Restaurant</button><button class="btn secondary small" data-action="demo" data-role="agent">🛵 Agent</button></div>
          </div>
        </div></section>
      </div>`;
  }

  // ---------------------------------------------------------------- shell
  function render() {
    if (!state.user) return renderAuth();
    const role = state.user.role; const nav = NAV[role];
    if (!nav.some(([v]) => v === state.view)) state.view = HOME[role];
    $('#app').innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <div class="logo">🍔 FoodHub <small>${esc(role)}</small></div>
        <nav class="nav">${nav.map(([v, l]) => `<button data-action="nav" data-view="${v}" class="${state.view === v ? 'active' : ''}">${l}</button>`).join('')}</nav>
        <div class="tools">
          <button class="chip-btn" data-action="nav" data-view="notifications" title="Notifications">🔔<span class="badge-dot" id="bell" hidden></span></button>
          ${role === 'customer' ? '<button class="chip-btn" data-action="openCart">🛒 Cart<span class="badge-dot" id="cart-count" hidden></span></button>' : ''}
          <div class="user-chip"><b>${esc(state.user.name)}</b><span>${esc(role)}</span></div>
          <button class="chip-btn" data-action="logout">Sign out</button>
        </div>
      </div></header>
      <main id="view"></main>
      ${role === 'customer' ? cartShell() : ''}`;
    updateBadges(); showView();
    clearInterval(poll); tick = 0; poll = setInterval(onTick, 3000);
  }

  function showView() {
    const v = state.view;
    ({ restaurants: viewRestaurants, orders: viewOrders, notifications: viewNotes, status: viewStatus, incoming: viewIncoming, menu: viewMenuManager, deliveries: viewDeliveries }[v] || (() => {}))();
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  }
  function go(view) { state.view = view; if (view === 'notifications') state.notesSeen = state.notes.length; updateBadges(); showView(); }

  function onTick() {
    tick += 1;
    if (state.view === 'orders') loadOrders();
    if (state.view === 'incoming') loadIncoming();
    if (state.view === 'deliveries') loadDeliveries();
    if (state.view === 'status') loadStatus();
    if (tick % 2 === 0) loadNotes();
  }

  function updateBadges() {
    const unseen = Math.max(0, state.notes.length - state.notesSeen);
    const bell = $('#bell'); if (bell) { bell.hidden = unseen === 0; bell.textContent = unseen; }
    const count = Object.values(state.cart.items).reduce((s, l) => s + l.qty, 0);
    const cc = $('#cart-count'); if (cc) { cc.hidden = count === 0; cc.textContent = count; }
  }
  async function loadNotes() {
    const r = await api('/notifications'); if (!r.ok) return;
    state.notes = r.data; if (state.view === 'notifications') { state.notesSeen = state.notes.length; renderNotes(); }
    updateBadges();
  }
  const title = (h, p) => `<div class="page-title"><h2>${h}</h2>${p ? `<p>${p}</p>` : ''}</div>`;

  // ---------------------------------------------------------------- customer: restaurants & menu
  async function viewRestaurants() {
    $('#view').innerHTML = title('Hungry? 😋', 'Pick a restaurant to see the menu') + '<div id="rest-area"><div class="empty">Loading…</div></div>';
    if (!state.restaurants.length) {
      const r = await api('/restaurants'); if (r.ok) state.restaurants = r.data; else return toast(errText(r), 'error');
    }
    state.selected ? renderMenu() : renderRestaurantList();
  }
  function renderRestaurantList() {
    const cuisines = ['', ...new Set(state.restaurants.map((r) => r.cuisine))];
    const list = state.restaurants.filter((r) => !state.cuisine || r.cuisine === state.cuisine);
    $('#rest-area').innerHTML = `
      <div class="chips">${cuisines.map((c) => `<button class="chip ${state.cuisine === c ? 'active' : ''}" data-action="cuisine" data-cuisine="${esc(c)}">${c ? esc(c) : 'All'}</button>`).join('')}</div>
      <div class="grid">${list.map((r) => `
        <article class="card rest-card" data-action="openMenu" data-id="${esc(r.id)}">
          <div class="rest-hero">${EMOJI[r.cuisine.toLowerCase()] || '🍽️'}</div>
          <div class="rest-body"><h3>${esc(r.name)}</h3><div class="meta"><span class="rating">★ ${esc(r.rating)}</span><span>${esc(r.cuisine)}</span></div></div>
        </article>`).join('') || '<div class="empty">No restaurants found.</div>'}</div>`;
  }
  async function openMenu(id) {
    const r = await api(`/restaurants/${encodeURIComponent(id)}/menu`);
    if (!r.ok) return toast(errText(r), 'error');
    state.selected = r.data.restaurant; state.menu = r.data.menu; renderMenu();
  }
  function renderMenu() {
    const rs = state.selected;
    $('#rest-area').innerHTML = `
      <button class="back-link" data-action="backToList">← All restaurants</button>
      <div class="card"><div class="row spread"><div><h2>${EMOJI[rs.cuisine.toLowerCase()] || '🍽️'} ${esc(rs.name)}</h2><div class="meta"><span class="rating">★ ${esc(rs.rating)}</span><span>${esc(rs.cuisine)}</span></div></div>
        <button class="btn" data-action="openCart">View cart</button></div>
        <div style="margin-top:8px">${state.menu.map((m) => {
          const line = state.cart.restaurantId === rs.id && state.cart.items[m.id];
          return `<div class="menu-item ${m.available ? '' : 'off'}"><div><h4>${esc(m.name)}</h4><span class="price">${money(m.price)}</span>${m.available ? '' : ' · <em>Unavailable</em>'}</div>
            ${!m.available ? '' : line ? `<div class="qty"><button data-action="qty" data-id="${esc(m.id)}" data-d="-1">−</button><span>${line.qty}</span><button data-action="qty" data-id="${esc(m.id)}" data-d="1">+</button></div>` : `<button class="btn small" data-action="add" data-id="${esc(m.id)}">Add</button>`}</div>`;
        }).join('')}</div></div>`;
  }
  function addItem(id, delta = 1) {
    const rs = state.selected; const m = state.menu.find((x) => x.id === id); if (!m) return;
    if (state.cart.restaurantId && state.cart.restaurantId !== rs.id && Object.keys(state.cart.items).length) {
      if (!window.confirm(`Your cart has items from ${state.cart.restaurantName}. Start a new cart for ${rs.name}?`)) return;
      state.cart.items = {};
    }
    state.cart.restaurantId = rs.id; state.cart.restaurantName = rs.name;
    const line = state.cart.items[id] || { name: m.name, price: m.price, qty: 0 };
    line.qty += delta;
    if (line.qty <= 0) delete state.cart.items[id]; else state.cart.items[id] = line;
    if (!Object.keys(state.cart.items).length) { state.cart.restaurantId = null; state.cart.restaurantName = ''; }
    updateBadges(); if (state.view === 'restaurants' && state.selected) renderMenu(); renderCartLines();
  }

  // ---------------------------------------------------------------- cart drawer
  function cartShell() {
    return `<div class="overlay" id="overlay" data-action="closeCart"></div>
      <aside class="drawer" id="cart" aria-label="Cart">
        <div class="drawer-head"><h3>🛒 Your cart</h3><button class="btn secondary small" data-action="closeCart">Close</button></div>
        <div class="drawer-body">
          <div id="cart-lines"></div>
          <div id="cart-form">
            <label>Delivery speed</label>
            <select id="order-type" data-change="totals"><option value="standard">Standard (free above ₹500, else ₹30)</option><option value="express">Express — priority (₹60)</option></select>
            <div class="totals" id="cart-totals"></div>
            <label>Payment method</label>
            <select id="pay-method" data-change="method"><option value="card">💳 Card</option><option value="upi">📲 UPI</option><option value="wallet">👛 Wallet (starts at ₹1000)</option></select>
            <div id="pay-card"><label>Card number</label><input id="card-number" inputmode="numeric" value="4242 4242 4242 4242" autocomplete="off">
              <div class="field-row"><div><label>Expiry (MM/YY)</label><input id="card-exp" value="12/30" autocomplete="off"></div><div><label>CVV</label><input id="card-cvv" value="123" autocomplete="off"></div></div>
              <p class="hint">Test cards: <b>4242 4242 4242 4242</b> succeeds · <b>4000 0000 0000 0002</b> is declined.</p></div>
            <div id="pay-upi" hidden><label>UPI ID</label><input id="upi-vpa" value="demo@bank" autocomplete="off"><p class="hint">Test: <b>demo@bank</b> succeeds · <b>fail@bank</b> is declined.</p></div>
            <div id="pay-wallet" hidden><p class="hint">Your wallet balance is checked on the server. Insufficient balance → payment fails.</p></div>
            <div class="pay-error" id="pay-error" hidden></div>
            <button class="btn block green" id="place-btn" data-action="placeOrder" style="margin-top:14px">Place order</button>
            <p class="hint">Prices are recalculated on the server from the live menu — the totals above are an estimate.</p>
          </div>
        </div>
      </aside>`;
  }
  function openCart() { $('#cart').classList.add('open'); $('#overlay').classList.add('open'); renderCartLines(); }
  function closeCart() { const c = $('#cart'); if (c) { c.classList.remove('open'); $('#overlay').classList.remove('open'); } }
  function estimate() {
    const subtotal = round2(Object.values(state.cart.items).reduce((s, l) => s + l.price * l.qty, 0));
    const type = ($('#order-type') || {}).value || 'standard';
    const fee = type === 'express' ? 60 : subtotal >= 500 ? 0 : 30;
    const tax = round2(subtotal * 0.05);
    return { subtotal, fee, tax, total: round2(subtotal + tax + fee) };
  }
  function renderCartLines() {
    const lines = $('#cart-lines'); if (!lines) return;
    const entries = Object.entries(state.cart.items);
    $('#cart-form').hidden = entries.length === 0;
    lines.innerHTML = entries.length
      ? `<p class="muted" style="margin:10px 0 0">From <b>${esc(state.cart.restaurantName)}</b></p>` + entries.map(([id, l]) => `
        <div class="cart-line"><div><b>${esc(l.name)}</b><div class="muted">${money(l.price)} each</div></div>
        <div class="row"><div class="qty"><button data-action="cartQty" data-id="${esc(id)}" data-d="-1">−</button><span>${l.qty}</span><button data-action="cartQty" data-id="${esc(id)}" data-d="1">+</button></div><b>${money(l.price * l.qty)}</b></div></div>`).join('')
      : '<div class="empty"><span class="big">🛒</span>Your cart is empty.<br>Add something tasty!</div>';
    const e = estimate();
    $('#cart-totals').innerHTML = `<div><span>Subtotal</span><span>${money(e.subtotal)}</span></div><div><span>GST (5%)</span><span>${money(e.tax)}</span></div><div><span>Delivery</span><span>${e.fee ? money(e.fee) : 'FREE'}</span></div><div class="grand"><span>Estimated total</span><span>${money(e.total)}</span></div>`;
  }
  function cartQty(id, d) {
    const line = state.cart.items[id]; if (!line) return;
    line.qty += d; if (line.qty <= 0) delete state.cart.items[id];
    if (!Object.keys(state.cart.items).length) { state.cart.restaurantId = null; state.cart.restaurantName = ''; }
    updateBadges(); renderCartLines(); if (state.view === 'restaurants' && state.selected) renderMenu();
  }
  async function placeOrder() {
    const items = Object.entries(state.cart.items).map(([menuItemId, l]) => ({ menuItemId, qty: l.qty }));
    if (!items.length) return;
    const method = $('#pay-method').value; let paymentDetails = {};
    if (method === 'card') paymentDetails = { number: $('#card-number').value, expiry: $('#card-exp').value, cvv: $('#card-cvv').value };
    if (method === 'upi') paymentDetails = { vpa: $('#upi-vpa').value.trim() };
    const btn = $('#place-btn'); const errBox = $('#pay-error'); errBox.hidden = true; btn.disabled = true; btn.textContent = 'Processing payment…';
    const r = await api('/orders', { method: 'POST', headers: { 'x-idempotency-key': uid() }, body: { restaurantId: state.cart.restaurantId, items, paymentMethod: method, paymentDetails, type: $('#order-type').value } });
    btn.disabled = false; btn.textContent = 'Place order';
    if (r.status === 201) {
      state.cart = { restaurantId: null, restaurantName: '', items: {} }; state.selected = null;
      closeCart(); updateBadges(); toast(`Order ${r.data.id} confirmed — total ${money(r.data.total)} 🎉`, 'success'); go('orders'); render();
      return;
    }
    errBox.hidden = false;
    errBox.textContent = r.data && r.data.error === 'payment_failed' ? `Payment failed: ${String(r.data.reason).replace(/_/g, ' ')}. Your order was not placed.` : errText(r);
  }

  // ---------------------------------------------------------------- customer: orders
  function viewOrders() {
    $('#view').innerHTML = title('My orders', 'Live status — updates automatically') + '<div id="orders-list"><div class="empty">Loading…</div></div>';
    loadOrders();
  }
  async function loadOrders() {
    const r = await api('/orders'); if (!r.ok || state.view !== 'orders') return;
    state.orders = r.data;
    await Promise.all(r.data.filter((o) => ACTIVE.includes(o.status)).map(async (o) => {
      const d = await api(`/deliveries/${encodeURIComponent(o.id)}`); if (d.ok) state.deliveries[o.id] = d.data;
    }));
    if (state.view === 'orders') renderOrders();
  }
  const itemsLine = (o) => o.items.map((i) => `${i.qty} × ${esc(i.name)}`).join(', ');
  function timeline(o) {
    if (['CANCELLED', 'PAYMENT_FAILED'].includes(o.status)) return '';
    const idx = FLOW.indexOf(o.status);
    return `<div class="steps">${FLOW.map((s, i) => `<div class="step ${i < idx || o.status === 'DELIVERED' ? 'done' : i === idx ? 'now' : ''}">${esc(STATUS[s])}</div>`).join('')}</div>`;
  }
  function renderOrders() {
    const box = $('#orders-list'); if (!box) return;
    if (!state.orders.length) { box.innerHTML = '<div class="card empty"><span class="big">🧾</span>No orders yet. Pick a restaurant and place your first order!</div>'; return; }
    box.innerHTML = state.orders.map((o) => {
      const d = state.deliveries[o.id];
      const dl = d && ACTIVE.includes(o.status) ? (d.agentId ? `🛵 Delivery partner assigned · ETA about ${d.etaMinutes} min` : '🕐 Finding a delivery partner…') : '';
      return `<article class="card order-card"><div class="order-top"><div><h3>${esc(o.restaurantName || o.restaurantId)}</h3><div class="muted" style="font-size:.82rem">${esc(o.id)} · ${when(o.createdAt)}${o.priority ? ' · ⚡ Express' : ''}</div></div><span class="status s-${o.status}">${esc(STATUS[o.status] || o.status)}</span></div>
        <div class="items-line">${itemsLine(o)}</div>${timeline(o)}${dl ? `<div class="delivery-line">${dl}</div>` : ''}
        <div class="order-foot"><span class="price-tag">${money(o.total)} <span class="muted" style="font-weight:500;font-size:.8rem">(incl. ${money(o.tax)} GST, ${o.deliveryFee ? money(o.deliveryFee) : 'free'} delivery)</span></span>
        ${o.status === 'CONFIRMED' ? `<button class="btn danger small" data-action="cancel" data-id="${esc(o.id)}">Cancel order</button>` : ''}</div></article>`;
    }).join('');
  }
  async function cancelOrder(id) {
    if (!window.confirm('Cancel this order? Your payment will be refunded.')) return;
    const r = await api(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
    r.ok ? toast('Order cancelled — refund on its way', 'success') : toast(errText(r), 'error'); loadOrders();
  }

  // ---------------------------------------------------------------- notifications & status
  function viewNotes() {
    $('#view').innerHTML = title('Notifications', 'Delivered by the notification service from platform events') + '<div class="card" id="notes-list"></div>';
    state.notesSeen = state.notes.length; renderNotes(); loadNotes();
  }
  function renderNotes() {
    const box = $('#notes-list'); if (!box) return;
    const icon = (t) => (t.startsWith('payment') ? '💳' : t.startsWith('delivery') ? '🛵' : t.includes('cancel') ? '❌' : '📦');
    box.innerHTML = state.notes.length ? [...state.notes].reverse().map((n) => `<div class="note"><span class="ic">${icon(n.topic)}</span><div>${esc(n.message)}<time>${when(n.at)} · via ${esc(n.channels.join(' + '))}</time></div></div>`).join('') : '<div class="empty"><span class="big">🔔</span>Nothing yet. Place an order to see notifications.</div>';
  }
  function viewStatus() {
    $('#view').innerHTML = title('System status', 'Live health of every microservice and circuit breaker (served by the API gateway)') + '<div class="card" id="status-box"><div class="empty">Checking…</div></div>';
    loadStatus();
  }
  async function loadStatus() {
    const r = await api('/health'); if (state.view !== 'status' || !r.data) return;
    const d = r.data; const box = $('#status-box'); if (!box) return;
    box.innerHTML = `<div class="row spread" style="margin-bottom:12px"><h3>Overall</h3><span class="pill ${d.status === 'UP' ? 'UP' : 'DEGRADED'}">${esc(d.status)}</span></div>
      <h4 style="margin:8px 0">Services</h4><div class="svc-grid">${Object.entries(d.services || {}).map(([k, v]) => `<div class="svc"><b>${esc(k)}</b><span class="pill ${esc(v)}">${esc(v)}</span></div>`).join('')}</div>
      <h4 style="margin:18px 0 8px">Circuit breakers (gateway → service)</h4><div class="svc-grid">${Object.entries(d.circuits || {}).map(([k, v]) => `<div class="svc"><b>${esc(k)}</b><span class="pill ${esc(v)}">${esc(v)}</span></div>`).join('')}</div>
      <p class="hint" style="margin-top:14px">Architecture: API Gateway → User · Restaurant · Order · Delivery · Notification; Order ↔ Payment; async events over the Event Bus.</p>`;
  }

  // ---------------------------------------------------------------- restaurant console
  async function ensureRestaurants() { if (!state.restaurants.length) { const r = await api('/restaurants'); if (r.ok) state.restaurants = r.data; } }
  const restSelect = () => `<label>Restaurant</label><select data-change="managed">${state.restaurants.map((r) => `<option value="${esc(r.id)}" ${r.id === state.managed ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`;
  async function viewIncoming() {
    await ensureRestaurants();
    $('#view').innerHTML = title('Incoming orders', 'Accept and progress orders — customers and agents are notified automatically') + `<div class="card" style="margin-bottom:16px;max-width:380px">${restSelect()}</div><div id="incoming-list"><div class="empty">Loading…</div></div>`;
    loadIncoming();
  }
  async function loadIncoming() {
    const r = await api(`/orders?restaurantId=${encodeURIComponent(state.managed)}`); if (!r.ok || state.view !== 'incoming') return;
    const box = $('#incoming-list'); if (!box) return;
    const act = r.data.filter((o) => o.status !== 'PAYMENT_FAILED');
    box.innerHTML = act.length ? act.map((o) => `<article class="card order-card"><div class="order-top"><div><h3>${esc(o.id)}</h3><div class="muted" style="font-size:.82rem">${when(o.createdAt)}${o.priority ? ' · ⚡ Express' : ''}</div></div><span class="status s-${o.status}">${esc(STATUS[o.status] || o.status)}</span></div>
      <div class="items-line">${itemsLine(o)}</div>
      <div class="order-foot"><span class="price-tag">${money(o.total)}</span><span>
        ${o.status === 'CONFIRMED' ? `<button class="btn small" data-action="setStatus" data-id="${esc(o.id)}" data-status="PREPARING">Start preparing</button>` : ''}
        ${o.status === 'PREPARING' ? `<button class="btn green small" data-action="setStatus" data-id="${esc(o.id)}" data-status="READY">Mark ready</button>` : ''}
        ${o.status === 'READY' ? '<span class="muted">Waiting for the delivery agent…</span>' : ''}</span></div></article>`).join('') : '<div class="card empty"><span class="big">🍳</span>No orders for this restaurant yet.</div>';
  }
  async function setStatus(id, status) {
    const r = await api(`/orders/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status } });
    r.ok ? toast(`Order marked ${STATUS[status].toLowerCase()}`, 'success') : toast(errText(r), 'error'); loadIncoming();
  }
  async function viewMenuManager() {
    await ensureRestaurants();
    $('#view').innerHTML = title('Menu manager', 'Changes are visible to customers immediately (cache invalidated on write)') + `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="card">${restSelect()}
      <form data-form="addItem"><label>New dish name</label><input name="name" required maxlength="60" placeholder="e.g. Veg Biryani"><label>Price (₹)</label><input name="price" type="number" min="1" step="1" required placeholder="199"><button class="btn block" style="margin-top:14px" type="submit">Add to menu</button></form></div>
      <div class="card"><h3 style="margin-bottom:6px">Current menu</h3><div id="managed-menu"></div></div></div>`;
    loadManagedMenu();
  }
  async function loadManagedMenu() {
    const r = await api(`/restaurants/${encodeURIComponent(state.managed)}/menu`); const box = $('#managed-menu'); if (!box || !r.ok) return;
    box.innerHTML = r.data.menu.map((m) => `<div class="menu-item ${m.available ? '' : 'off'}"><div><h4>${esc(m.name)}</h4></div><span class="price">${money(m.price)}</span></div>`).join('');
  }

  // ---------------------------------------------------------------- agent console
  function viewDeliveries() {
    $('#view').innerHTML = title('My deliveries', 'Go online to receive assignments') + `<div class="card row spread" style="margin-bottom:16px"><div><b>${state.agentOnline ? '🟢 You are online' : '⚪ You are offline'}</b><div class="muted" style="font-size:.88rem">The delivery service assigns the least-loaded online agent when an order is placed.</div></div><button class="btn ${state.agentOnline ? 'secondary' : ''}" data-action="goOnline">${state.agentOnline ? 'Refresh availability' : 'Go online'}</button></div><div id="deliveries-list"><div class="empty">Loading…</div></div>`;
    loadDeliveries();
  }
  async function loadDeliveries() {
    const r = await api('/deliveries'); if (!r.ok || state.view !== 'deliveries') return;
    const box = $('#deliveries-list'); if (!box) return;
    const label = { ASSIGNED: 'Assigned', PICKED_UP: 'On the way', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', PENDING_ASSIGNMENT: 'Pending' };
    box.innerHTML = r.data.length ? r.data.map((d) => {
      const ready = d.orderStatus === 'READY';
      return `<article class="card order-card"><div class="order-top"><div><h3>${esc(d.orderId)}</h3><div class="muted" style="font-size:.82rem">${when(d.createdAt)}${d.priority ? ' · ⚡ Express' : ''} · ETA ${d.etaMinutes || '—'} min</div></div><span class="status ${d.status === 'DELIVERED' ? 's-DELIVERED' : d.status === 'CANCELLED' ? 's-CANCELLED' : d.status === 'PICKED_UP' ? 's-OUT_FOR_DELIVERY' : 's-CONFIRMED'}">${esc(label[d.status] || d.status)}</span></div>
        <div class="items-line">Restaurant status: <b>${esc(STATUS[d.orderStatus] || d.orderStatus)}</b></div>
        <div class="order-foot"><span></span><span>
          ${d.status === 'ASSIGNED' ? `<button class="btn small" data-action="pickup" data-id="${esc(d.orderId)}" ${ready ? '' : 'disabled title="Waiting for the restaurant to mark the order ready"'}>${ready ? 'Picked up' : 'Waiting for restaurant'}</button>` : ''}
          ${d.status === 'PICKED_UP' ? `<button class="btn green small" data-action="complete" data-id="${esc(d.orderId)}">Mark delivered</button>` : ''}</span></div></article>`;
    }).join('') : '<div class="card empty"><span class="big">🛵</span>No deliveries yet. Go online, then ask a customer to place an order.</div>';
  }
  async function goOnline() {
    const r = await api('/deliveries/agents/online', { method: 'POST', body: {} });
    if (r.ok) { state.agentOnline = true; toast('You are online', 'success'); viewDeliveries(); } else toast(errText(r), 'error');
  }
  async function deliveryStep(id, step) {
    const r = await api(`/deliveries/${encodeURIComponent(id)}/${step}`, { method: 'POST', body: {} });
    r.ok ? toast(step === 'pickup' ? 'Pickup confirmed' : 'Delivered — great job!', 'success') : toast(errText(r), 'error'); loadDeliveries();
  }

  // ---------------------------------------------------------------- event wiring (no inline handlers: strict CSP)
  const actions = {
    authTab: (d) => { state.authTab = d.tab; renderAuth(); },
    demo: async (d) => {
      const email = `demo-${d.role}@foodhub.test`; const password = 'Passw0rd!23';
      let r = await signIn(email, password);
      if (!r.ok) { await api('/auth/register', { method: 'POST', body: { name: `Demo ${d.role}`, email, password, role: d.role } }); r = await signIn(email, password); }
      if (!r.ok) toast(errText(r), 'error');
    },
    nav: (d) => go(d.view), logout: () => logout(),
    cuisine: (d) => { state.cuisine = d.cuisine; renderRestaurantList(); },
    openMenu: (d) => openMenu(d.id), backToList: () => { state.selected = null; renderRestaurantList(); },
    add: (d) => addItem(d.id), qty: (d) => addItem(d.id, Number(d.d)),
    openCart, closeCart, cartQty: (d) => cartQty(d.id, Number(d.d)), placeOrder,
    cancel: (d) => cancelOrder(d.id), setStatus: (d) => setStatus(d.id, d.status),
    goOnline, pickup: (d) => deliveryStep(d.id, 'pickup'), complete: (d) => deliveryStep(d.id, 'complete'),
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]'); if (!el || el.disabled) return;
    const fn = actions[el.dataset.action]; if (fn) fn(el.dataset, e);
  });
  document.addEventListener('change', (e) => {
    const kind = e.target.dataset && e.target.dataset.change; if (!kind) return;
    if (kind === 'totals') renderCartLines();
    if (kind === 'method') { const m = e.target.value; ['card', 'upi', 'wallet'].forEach((x) => { $(`#pay-${x}`).hidden = x !== m; }); }
    if (kind === 'managed') { state.managed = e.target.value; state.view === 'incoming' ? loadIncoming() : loadManagedMenu(); }
  });
  document.addEventListener('submit', async (e) => {
    const kind = e.target.dataset && e.target.dataset.form; if (!kind) return;
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const btn = e.target.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    if (kind === 'login' || kind === 'register') {
      const err = $('#auth-error'); err.textContent = '';
      if (kind === 'register') {
        const rr = await api('/auth/register', { method: 'POST', body: f });
        if (!rr.ok) { err.textContent = errText(rr).replace(/_/g, ' '); if (btn) btn.disabled = false; return; }
      }
      const r = await signIn(f.email, f.password);
      if (!r.ok) { err.textContent = r.status === 401 ? 'Wrong email or password' : errText(r); if (btn) btn.disabled = false; }
    }
    if (kind === 'addItem') {
      const r = await api(`/restaurants/${encodeURIComponent(state.managed)}/menu`, { method: 'POST', body: { name: f.name, price: Number(f.price) } });
      if (r.ok) { toast(`Added “${r.data.name}” to the menu`, 'success'); e.target.reset(); loadManagedMenu(); } else toast(errText(r), 'error');
      if (btn) btn.disabled = false;
    }
  });

  render();
  if (state.user) loadNotes();
})();
