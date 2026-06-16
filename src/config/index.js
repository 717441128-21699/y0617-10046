const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const EventEmitter = require('events');

class ConfigManager extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath || path.join(process.cwd(), 'config', 'gateway.json');
    this.config = null;
    this.apiKeyMap = new Map();
    this.watcher = null;
    this.load();
    this.watch();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      this.config = config;
      this.rebuildIndexes();
      console.log('[Config] Configuration loaded successfully');
      this.emit('config:updated', this.config);
    } catch (err) {
      console.error('[Config] Failed to load configuration:', err.message);
      if (!this.config) {
        throw err;
      }
    }
  }

  rebuildIndexes() {
    this.apiKeyMap.clear();
    if (this.config.apiKeys) {
      for (const apiKey of this.config.apiKeys) {
        this.apiKeyMap.set(apiKey.key, apiKey);
      }
    }
  }

  watch() {
    if (this.watcher) {
      this.watcher.close();
    }
    this.watcher = chokidar.watch(this.configPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });

    this.watcher.on('change', () => {
      console.log('[Config] Configuration file changed, reloading...');
      this.load();
    });

    this.watcher.on('error', (err) => {
      console.error('[Config] Watcher error:', err.message);
    });
  }

  get() {
    return this.config;
  }

  getRoutes() {
    return this.config.routes || [];
  }

  getApiKey(key) {
    return this.apiKeyMap.get(key) || null;
  }

  getApiKeys() {
    return this.config.apiKeys || [];
  }

  getDefaultRateLimit() {
    return this.config.global?.defaultRateLimit || { requests: 20, windowMs: 60000 };
  }

  getServerPort() {
    return this.config.server?.port || 3000;
  }

  getAdminPort() {
    return this.config.server?.adminPort || 3001;
  }

  async save() {
    const json = JSON.stringify(this.config, null, 2);
    await fs.promises.writeFile(this.configPath, json, 'utf8');
  }

  async updateRoutes(routes) {
    this.config.routes = routes;
    this.rebuildIndexes();
    await this.save();
    this.emit('config:updated', this.config);
  }

  async updateApiKeys(apiKeys) {
    this.config.apiKeys = apiKeys;
    this.rebuildIndexes();
    await this.save();
    this.emit('config:updated', this.config);
  }

  async revokeApiKey(key) {
    const apiKey = this.apiKeyMap.get(key);
    if (apiKey) {
      apiKey.revoked = true;
      this.rebuildIndexes();
      await this.save();
      this.emit('config:updated', this.config);
      return true;
    }
    return false;
  }

  async updateRateLimit(key, requests, windowMs) {
    const apiKey = this.apiKeyMap.get(key);
    if (apiKey) {
      apiKey.rateLimit = { requests, windowMs };
      this.rebuildIndexes();
      await this.save();
      this.emit('config:updated', this.config);
      return true;
    }
    return false;
  }

  matchRoute(path) {
    const routes = this.getRoutes();
    for (const route of routes) {
      if (path.startsWith(route.path)) {
        return route;
      }
    }
    return null;
  }

  close() {
    if (this.watcher) {
      this.watcher.close();
    }
  }
}

module.exports = ConfigManager;
