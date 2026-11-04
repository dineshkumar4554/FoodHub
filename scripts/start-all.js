'use strict';
// Starts every FoodHub service as its own OS process (one process = one deployable microservice).
const { spawn } = require('child_process');
const path = require('path');

const SERVICES = ['event-bus', 'user', 'restaurant', 'payment', 'delivery', 'notification', 'order', 'gateway'];
const root = path.join(__dirname, '..');

function startAll(extraEnv = {}) {
  const children = SERVICES.map((name) => {
    const child = spawn(process.execPath, [path.join(root, 'services', name, 'index.js')], {
      cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => { if (code) console.error(`[start-all] ${name} exited with code ${code}`); });
    return child;
  });
  const stop = () => children.forEach((c) => c.kill());
  process.on('exit', stop);
  return stop;
}

if (require.main === module) {
  const stop = startAll();
  console.log(`FoodHub starting ${SERVICES.length} services... gateway on http://localhost:${process.env.GATEWAY_PORT || 3000}`);
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { stop(); process.exit(0); }));
}
module.exports = { startAll, SERVICES };
