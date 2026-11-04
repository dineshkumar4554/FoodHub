'use strict';
// Circuit Breaker pattern: CLOSED -> OPEN (after N failures) -> HALF_OPEN (after cool-down) -> CLOSED.
class CircuitOpenError extends Error {
  constructor(name) { super(`circuit '${name}' is open`); this.code = 'circuit_open'; }
}

class CircuitBreaker {
  constructor({ name = 'circuit', failureThreshold = 5, resetTimeoutMs = 10000, now = Date.now } = {}) {
    Object.assign(this, { name, failureThreshold, resetTimeoutMs, now });
    this.state = 'CLOSED'; this.failures = 0; this.openedAt = 0;
  }
  canRequest() {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.resetTimeoutMs) this.state = 'HALF_OPEN';
      else return false;
    }
    return true;
  }
  onSuccess() { this.failures = 0; this.state = 'CLOSED'; }
  onFailure() {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN'; this.openedAt = this.now();
    }
  }
  async exec(fn) {
    if (!this.canRequest()) throw new CircuitOpenError(this.name);
    try { const result = await fn(); this.onSuccess(); return result; }
    catch (err) { this.onFailure(); throw err; }
  }
}
module.exports = { CircuitBreaker, CircuitOpenError };
