const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class ConfigManager extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath || path.join(process.cwd(), 'config', 'gateway.json');
    this.versionStorePath = path.join(path.dirname(this.configPath), '.versions.json');
    this.config = null;
    this.apiKeyMap = new Map();
    this.watcher = null;
    this.versions = this.loadVersions();
    this._skipVersionSave = false;
    this.load();
    this.watch();
  }

  loadVersions() {
    try {
      if (fs.existsSync(this.versionStorePath)) {
        const raw = fs.readFileSync(this.versionStorePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[Config] Failed to load versions:', err.message);
    }
    return { versions: [] };
  }

  async saveVersions() {
    try {
      if (this.versions.versions.length > 50) {
        this.versions.versions = this.versions.versions.slice(0, 50);
      }
      await fs.promises.writeFile(this.versionStorePath, JSON.stringify(this.versions, null, 2), 'utf8');
    } catch (err) {
      console.error('[Config] Failed to save versions:', err.message);
    }
  }

  recordVersion(changeType, details = {}) {
    if (this._skipVersionSave) return;
    const snapshot = JSON.parse(JSON.stringify(this.config));
    const version = {
      id: `v-${uuidv4().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      changeType,
      author: process.env.USER || 'system',
      message: details.message || `${changeType} configuration`,
      changes: details.changes || [],
      diff: details.diff || null,
      snapshot
    };
    this.versions.versions.unshift(version);
    this.saveVersions();
    this.emit('version:created', version);
  }

  getVersions(limit = 20) {
    return this.versions.versions.slice(0, limit).map(v => ({
      id: v.id,
      timestamp: v.timestamp,
      changeType: v.changeType,
      author: v.author,
      message: v.message,
      changes: v.changes,
      hasSnapshot: !!v.snapshot
    }));
  }

  getVersion(versionId) {
    return this.versions.versions.find(v => v.id === versionId) || null;
  }

  async rollbackToVersion(versionId) {
    const version = this.getVersion(versionId);
    if (!version) {
      return { success: false, error: 'Version not found' };
    }
    if (!version.snapshot) {
      return { success: false, error: 'No snapshot available for this version' };
    }

    const previousConfig = JSON.parse(JSON.stringify(this.config));
    this._skipVersionSave = true;

    try {
      this.config = JSON.parse(JSON.stringify(version.snapshot));
      this.rebuildIndexes();
      await this.save();

      const rollbackVersion = {
        id: `v-${uuidv4().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        changeType: 'rollback',
        author: process.env.USER || 'system',
        message: `Rollback to ${versionId}: ${version.message}`,
        changes: [{ type: 'rollback', from: version.id }],
        snapshot: JSON.parse(JSON.stringify(this.config))
      };
      this.versions.versions.unshift(rollbackVersion);
      await this.saveVersions();

      this._skipVersionSave = false;
      this.emit('config:updated', this.config);
      this.emit('version:rollback', rollbackVersion, version);

      return {
        success: true,
        version: rollbackVersion,
        rolledBackFrom: versionId,
        previousConfig
      };
    } catch (err) {
      this._skipVersionSave = false;
      return { success: false, error: err.message };
    }
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
    this.sortRoutes();
  }

  sortRoutes() {
    if (!this.config.routes) return;
    this.config.routes.sort((a, b) => {
      const priorityA = a.priority ?? a.path.length;
      const priorityB = b.priority ?? b.path.length;
      if (priorityB !== priorityA) {
        return priorityB - priorityA;
      }
      return b.path.length - a.path.length;
    });
  }

  detectConflicts(routes = this.config.routes) {
    const conflicts = [];
    if (!routes) return conflicts;

    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const r1 = routes[i];
        const r2 = routes[j];
        if (r1.path === r2.path) {
          conflicts.push({
            type: 'exact',
            routes: [r1.id, r2.id],
            path: r1.path,
            message: `两条路由使用完全相同的路径: ${r1.path}`
          });
        } else if (r1.path.startsWith(r2.path) || r2.path.startsWith(r1.path)) {
          const longer = r1.path.length > r2.path.length ? r1 : r2;
          const shorter = r1.path.length > r2.path.length ? r2 : r1;
          conflicts.push({
            type: 'prefix',
            routes: [shorter.id, longer.id],
            path: shorter.path,
            overlappingPath: longer.path,
            message: `路径 ${longer.path} 会被 ${shorter.path} 优先匹配，请调整优先级或路径`
          });
        }
      }
    }
    return conflicts;
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

  async updateRoutes(routes, options = {}) {
    for (const route of routes) {
      if (!route.id) route.id = `route-${require('uuid').v4().slice(0, 8)}`;
      if (!route.cache) route.cache = { enabled: false };
      if (typeof route.authRequired === 'undefined') route.authRequired = true;
      if (typeof route.rateLimitBypass === 'undefined') route.rateLimitBypass = false;
      if (typeof route.priority === 'undefined') route.priority = route.path.length;
    }

    const conflicts = this.detectConflicts(routes);
    if (conflicts.length > 0 && !options.ignoreConflicts) {
      return { success: false, conflicts, routes };
    }

    const oldRoutes = JSON.parse(JSON.stringify(this.config.routes || []));
    this.config.routes = routes;
    this.rebuildIndexes();
    await this.save();
    this.recordVersion('routes', {
      message: 'Updated routes configuration',
      changes: [{ type: 'routes', count: routes.length }],
      diff: { before: oldRoutes, after: JSON.parse(JSON.stringify(routes)) }
    });
    this.emit('config:updated', this.config);
    return { success: true, routes: this.getRoutes(), conflicts };
  }

  async updateApiKeys(apiKeys) {
    const oldKeys = JSON.parse(JSON.stringify(this.config.apiKeys || []));
    this.config.apiKeys = apiKeys;
    this.rebuildIndexes();
    await this.save();
    this.recordVersion('apikeys', {
      message: 'Updated API keys configuration',
      changes: [{ type: 'apikeys', count: apiKeys.length }],
      diff: { before: oldKeys, after: JSON.parse(JSON.stringify(apiKeys)) }
    });
    this.emit('config:updated', this.config);
  }

  async revokeApiKey(key) {
    const apiKey = this.apiKeyMap.get(key);
    if (apiKey) {
      apiKey.revoked = true;
      this.rebuildIndexes();
      await this.save();
      this.recordVersion('apikeys', {
        message: `Revoked API key: ${key.slice(0, 8)}...`,
        changes: [{ type: 'revoke', key: key.slice(0, 8) }]
      });
      this.emit('config:updated', this.config);
      return true;
    }
    return false;
  }

  async updateRateLimit(key, requests, windowMs) {
    const apiKey = this.apiKeyMap.get(key);
    if (apiKey) {
      const oldLimit = JSON.parse(JSON.stringify(apiKey.rateLimit || {}));
      apiKey.rateLimit = { requests, windowMs };
      this.rebuildIndexes();
      await this.save();
      this.recordVersion('ratelimit', {
        message: `Updated rate limit for key ${key.slice(0, 8)}...`,
        changes: [{ type: 'ratelimit', before: oldLimit, after: { requests, windowMs } }]
      });
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
