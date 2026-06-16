const http = require('http');
const https = require('https');
const { URL } = require('url');

class CircuitBreakerManager {
  constructor(configManager, options = {}) {
    this.configManager = configManager;
    this.states = new Map();
    this.interval = null;
    this.defaultOptions = {
      failureThreshold: options.failureThreshold || 5,
      successThreshold: options.successThreshold || 3,
      timeout: options.timeout || 30000,
      resetTimeout: options.resetTimeout || 30000,
      healthCheckInterval: options.healthCheckInterval || 10000,
      healthCheckPath: options.healthCheckPath || '/health'
    };

    this.initAllStates();
    this.startHealthCheck();
    this._configListener = () => this.refreshTargets();
    this.configManager.on('config:updated', this._configListener);
  }

  refreshTargets() {
    const routes = this.configManager.getRoutes();
    const activeTargets = new Set();
    for (const route of routes) {
      activeTargets.add(route.target);
      if (route.canary?.target) {
        activeTargets.add(route.canary.target);
      }
    }
    for (const target of activeTargets) {
      this.getOrCreateState(target);
    }
  }

  initAllStates() {
    const routes = this.configManager.getRoutes();
    const targets = new Set();
    for (const route of routes) {
      targets.add(route.target);
      if (route.canary?.target) {
        targets.add(route.canary.target);
      }
    }
    for (const target of targets) {
      this.getOrCreateState(target);
    }
  }

  getOrCreateState(target) {
    if (!this.states.has(target)) {
      this.states.set(target, {
        status: 'CLOSED',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        lastFailureReason: null,
        openedAt: null,
        halfOpenTestAt: null,
        history: []
      });
    }
    return this.states.get(target);
  }

  isAvailable(target) {
    const state = this.getOrCreateState(target);
    if (state.status === 'OPEN') {
      if (Date.now() - state.openedAt >= this.defaultOptions.resetTimeout) {
        state.status = 'HALF_OPEN';
        state.halfOpenTestAt = Date.now();
      }
    }
    return state.status !== 'OPEN';
  }

  recordSuccess(target) {
    const state = this.getOrCreateState(target);
    state.lastSuccessTime = Date.now();
    state.failureCount = 0;

    if (state.status === 'HALF_OPEN') {
      state.successCount++;
      if (state.successCount >= this.defaultOptions.successThreshold) {
        state.status = 'CLOSED';
        state.successCount = 0;
        this.addHistory(target, 'CLOSED', 'Circuit closed after successful recovery');
      }
    } else if (state.status !== 'CLOSED') {
      state.status = 'CLOSED';
    }
  }

  recordFailure(target, reason = null) {
    const state = this.getOrCreateState(target);
    state.lastFailureTime = Date.now();
    state.lastFailureReason = reason;
    state.successCount = 0;

    if (state.status === 'HALF_OPEN') {
      state.status = 'OPEN';
      state.openedAt = Date.now();
      this.addHistory(target, 'OPEN', `Circuit re-opened: ${reason || 'test request failed'}`);
    } else if (state.status === 'CLOSED') {
      state.failureCount++;
      if (state.failureCount >= this.defaultOptions.failureThreshold) {
        state.status = 'OPEN';
        state.openedAt = Date.now();
        this.addHistory(target, 'OPEN', `Circuit opened after ${state.failureCount} failures: ${reason || 'unknown'}`);
      }
    }
  }

  addHistory(target, transition, reason) {
    const state = this.states.get(target);
    if (!state) return;
    state.history.unshift({
      timestamp: new Date().toISOString(),
      transition,
      reason
    });
    if (state.history.length > 20) {
      state.history = state.history.slice(0, 20);
    }
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.interval = setInterval(() => this.runHealthChecks(), this.defaultOptions.healthCheckInterval);
  }

  stopHealthCheck() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runHealthChecks() {
    const targets = Array.from(this.states.keys());
    for (const target of targets) {
      try {
        await this.performHealthCheck(target);
      } catch (err) {
        this.recordFailure(target, `Health check failed: ${err.message}`);
      }
    }
  }

  performHealthCheck(target) {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(target);
        const protocol = url.protocol === 'https:' ? https : http;
        const options = {
          hostname: url.hostname,
          port: url.port,
          path: this.defaultOptions.healthCheckPath,
          method: 'GET',
          timeout: 5000,
          headers: { 'User-Agent': 'Gateway-HealthCheck' }
        };

        const req = protocol.request(options, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 400) {
            this.recordSuccess(target);
            resolve(true);
          } else {
            this.recordFailure(target, `Health check returned ${res.statusCode}`);
            resolve(false);
          }
          res.resume();
        });

        req.on('timeout', () => {
          req.destroy();
          this.recordFailure(target, 'Health check timed out');
          resolve(false);
        });

        req.on('error', (err) => {
          this.recordFailure(target, `Connection error: ${err.message}`);
          resolve(false);
        });

        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  getStatus(target) {
    const state = this.states.get(target);
    if (!state) {
      return {
        target,
        status: 'UNKNOWN',
        failureCount: 0,
        lastCheck: null,
        nextRetryIn: 0,
        history: []
      };
    }

    const now = Date.now();
    let nextRetryIn = 0;
    if (state.status === 'OPEN') {
      nextRetryIn = Math.max(0, this.defaultOptions.resetTimeout - (now - (state.openedAt || now)));
    }

    return {
      target,
      status: state.status,
      failureCount: state.failureCount,
      successCount: state.successCount,
      lastSuccessTime: state.lastSuccessTime ? new Date(state.lastSuccessTime).toISOString() : null,
      lastFailureTime: state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : null,
      lastFailureReason: state.lastFailureReason,
      openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : null,
      nextRetryInMs: nextRetryIn,
      nextRetryInSec: Math.ceil(nextRetryIn / 1000),
      history: state.history
    };
  }

  getAllStatuses() {
    const statuses = {};
    const routes = this.configManager.getRoutes();
    const targets = new Set();
    for (const route of routes) {
      targets.add(route.target);
      if (route.canary?.target) {
        targets.add(route.canary.target);
      }
    }
    for (const target of targets) {
      statuses[target] = this.getStatus(target);
    }
    return statuses;
  }

  forceClose(target) {
    const state = this.getOrCreateState(target);
    state.status = 'CLOSED';
    state.failureCount = 0;
    state.successCount = 0;
    this.addHistory(target, 'CLOSED', 'Manually closed via admin');
  }

  forceOpen(target, reason = 'Manually opened via admin') {
    const state = this.getOrCreateState(target);
    state.status = 'OPEN';
    state.openedAt = Date.now();
    state.lastFailureReason = reason;
    this.addHistory(target, 'OPEN', reason);
  }

  reset(target = null) {
    if (target) {
      this.states.delete(target);
    } else {
      this.states.clear();
    }
  }

  close() {
    this.stopHealthCheck();
    if (this._configListener) {
      this.configManager.removeListener('config:updated', this._configListener);
    }
  }
}

module.exports = CircuitBreakerManager;
