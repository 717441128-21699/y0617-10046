const express = require('express');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');

class AdminServer {
  constructor(configManager, cache, rateLimiter, logger, gateway, canary = null, circuitBreaker = null) {
    this.configManager = configManager;
    this.cache = cache;
    this.rateLimiter = rateLimiter;
    this.logger = logger;
    this.logStore = logger.logStore;
    this.gateway = gateway;
    this.canary = canary;
    this.circuitBreaker = circuitBreaker;
    this.app = express();
    this.server = null;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    this.app.get('/api/config', (req, res) => {
      res.json(this.configManager.get());
    });

    this.app.get('/api/routes', (req, res) => {
      res.json(this.configManager.getRoutes());
    });

    this.app.post('/api/routes', async (req, res) => {
      try {
        const routes = req.body;
        const { ignoreConflicts } = req.query;
        if (!Array.isArray(routes)) {
          return res.status(400).json({ error: 'Routes must be an array' });
        }
        const result = await this.configManager.updateRoutes(routes, { ignoreConflicts: ignoreConflicts === 'true' });
        for (const route of routes) {
          this.cache.invalidateRoute(route.id);
        }
        if (!result.success) {
          return res.status(409).json(result);
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/routes/:id', async (req, res) => {
      try {
        const routeId = req.params.id;
        const updates = req.body;
        const { ignoreConflicts } = req.query;
        const routes = this.configManager.getRoutes();
        const index = routes.findIndex(r => r.id === routeId);

        if (index === -1) {
          return res.status(404).json({ error: 'Route not found' });
        }

        routes[index] = { ...routes[index], ...updates, id: routeId };
        const result = await this.configManager.updateRoutes(routes, { ignoreConflicts: ignoreConflicts === 'true' });
        this.cache.invalidateRoute(routeId);

        if (!result.success) {
          return res.status(409).json(result);
        }
        res.json({ success: true, route: routes[index], conflicts: result.conflicts || [] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/routes/conflicts', (req, res) => {
      const conflicts = this.configManager.detectConflicts();
      res.json({ conflicts });
    });

    this.app.delete('/api/routes/:id', async (req, res) => {
      try {
        const routeId = req.params.id;
        const routes = this.configManager.getRoutes().filter(r => r.id !== routeId);
        await this.configManager.updateRoutes(routes);
        this.cache.invalidateRoute(routeId);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/apikeys', (req, res) => {
      const keys = this.configManager.getApiKeys().map(k => ({
        ...k,
        key: k.revoked ? k.key : `${k.key.slice(0, 8)}...${k.key.slice(-4)}`,
        fullKey: k.key
      }));
      res.json(keys);
    });

    this.app.post('/api/apikeys', async (req, res) => {
      try {
        const keys = req.body;
        if (!Array.isArray(keys)) {
          return res.status(400).json({ error: 'API Keys must be an array' });
        }
        await this.configManager.updateApiKeys(keys);
        res.json({ success: true, keys: this.configManager.getApiKeys() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/apikeys/:key/revoke', async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.key);
        const success = await this.configManager.revokeApiKey(key);
        if (!success) {
          return res.status(404).json({ error: 'API Key not found' });
        }
        res.json({ success: true, message: 'API Key revoked' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/apikeys/:key/ratelimit', async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.key);
        const { requests, windowMs } = req.body;
        if (!requests || !windowMs) {
          return res.status(400).json({ error: 'requests and windowMs are required' });
        }
        const success = await this.configManager.updateRateLimit(key, requests, windowMs);
        if (!success) {
          return res.status(404).json({ error: 'API Key not found' });
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/debug/route', async (req, res) => {
      try {
        const { routeId, method = 'GET', path = '', headers = {}, body = null } = req.body;
        const route = this.configManager.getRoutes().find(r => r.id === routeId);
        if (!route) {
          return res.status(404).json({ error: 'Route not found' });
        }

        const gatewayPort = this.configManager.getServerPort();
        const requestPath = path || route.path;

        const gatewayHeaders = { ...headers };
        Object.keys(gatewayHeaders).forEach(k => {
          const lower = k.toLowerCase();
          if (lower === 'host' || lower === 'content-length' || lower === 'connection') {
            delete gatewayHeaders[k];
          }
        });

        const startTime = Date.now();
        let requestBody = null;
        if (body !== null && body !== undefined) {
          if (typeof body === 'object') {
            requestBody = JSON.stringify(body);
            gatewayHeaders['content-type'] = gatewayHeaders['content-type'] || 'application/json';
          } else {
            requestBody = String(body);
            gatewayHeaders['content-type'] = gatewayHeaders['content-type'] || 'text/plain';
          }
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(requestPath, `http://localhost:${gatewayPort}`);
        } catch (e) {
          parsedUrl = new URL('/' + requestPath, `http://localhost:${gatewayPort}`);
        }

        const gatewayResult = await this.makeUpstreamRequest({
          method: method.toUpperCase(),
          url: `http://localhost:${gatewayPort}${parsedUrl.pathname}${parsedUrl.search}`,
          headers: gatewayHeaders,
          body: requestBody
        });

        const duration = Date.now() - startTime;

        const responseHeaders = gatewayResult.headers || {};
        const cacheHit = responseHeaders['x-cache'] === 'HIT';
        const canaryHit = responseHeaders['x-canary'] === 'HIT';
        const target = responseHeaders['x-gateway-target'] || route.target;
        const errorMsg = responseHeaders['x-gateway-error'] || null;

        const cacheKey = this.cache.generateCacheKey({
          method: method.toUpperCase(),
          originalUrl: requestPath,
          headers: headers
        });

        res.json({
          success: true,
          matchedRoute: route,
          requestPath,
          requestHeadersSent: gatewayHeaders,
          requestBodySent: requestBody,
          gatewayResponse: {
            statusCode: gatewayResult.statusCode,
            statusMessage: gatewayResult.statusMessage,
            headers: responseHeaders,
            body: gatewayResult.body
          },
          cacheInfo: {
            cacheStatus: cacheHit ? 'HIT' : 'MISS',
            cacheKey,
            wouldCache: route.cache?.enabled && (route.cache.methods || ['GET']).includes(method.toUpperCase())
          },
          canaryInfo: {
            canaryHit,
            ruleType: responseHeaders['x-canary-rule'] || null,
            targetUsed: target
          },
          errorInfo: errorMsg ? { message: errorMsg } : null,
          durationMs: duration
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/canary/stats', (req, res) => {
      if (!this.canary) {
        return res.json({ enabled: false });
      }
      res.json({
        enabled: true,
        stats: this.canary.getAllStats()
      });
    });

    this.app.post('/api/canary/stats/reset', (req, res) => {
      if (!this.canary) {
        return res.json({ success: false, error: 'Canary not enabled' });
      }
      const { routeId } = req.body || {};
      this.canary.resetStats(routeId);
      res.json({ success: true });
    });

    this.app.get('/api/canary/rules/:routeId', (req, res) => {
      const route = this.configManager.getRoutes().find(r => r.id === req.params.routeId);
      if (!route) {
        return res.status(404).json({ error: 'Route not found' });
      }
      res.json({
        routeId: route.id,
        canary: route.canary || { enabled: false, target: '', rules: [] }
      });
    });

    this.app.post('/api/canary/rules/:routeId', async (req, res) => {
      try {
        const { routeId } = req.params;
        const { enabled, target, rules } = req.body;
        const routes = this.configManager.getRoutes();
        const idx = routes.findIndex(r => r.id === routeId);
        if (idx === -1) {
          return res.status(404).json({ error: 'Route not found' });
        }

        if (rules) {
          for (const rule of rules) {
            if (!rule.id) rule.id = `rule-${require('uuid').v4().slice(0, 8)}`;
          }
        }

        routes[idx].canary = {
          enabled: enabled !== undefined ? enabled : (routes[idx].canary?.enabled || false),
          target: target || routes[idx].canary?.target || routes[idx].target,
          rules: rules || routes[idx].canary?.rules || []
        };

        const result = await this.configManager.updateRoutes(routes, { ignoreConflicts: true });
        if (!result.success) {
          return res.status(409).json(result);
        }
        if (this.canary) this.canary.resetStats(routeId);
        this.cache.invalidateRoute(routeId);

        res.json({ success: true, route: routes[idx] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/canary/rules/:routeId/toggle', async (req, res) => {
      try {
        const { routeId } = req.params;
        const { enabled } = req.body;
        const routes = this.configManager.getRoutes();
        const idx = routes.findIndex(r => r.id === routeId);
        if (idx === -1) {
          return res.status(404).json({ error: 'Route not found' });
        }
        if (!routes[idx].canary) {
          routes[idx].canary = { enabled: false, target: routes[idx].target, rules: [] };
        }
        routes[idx].canary.enabled = enabled;
        const result = await this.configManager.updateRoutes(routes, { ignoreConflicts: true });
        if (!result.success) {
          return res.status(409).json(result);
        }
        this.cache.invalidateRoute(routeId);
        res.json({ success: true, route: routes[idx] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/logs/replay/:logId', async (req, res) => {
      try {
        const logEntry = this.logStore.getById(req.params.logId);
        if (!logEntry) {
          return res.status(404).json({ error: 'Log entry not found' });
        }

        const { targetOverride = null, useCanary = false } = req.body || {};
        const gatewayPort = this.configManager.getServerPort();
        const route = this.configManager.getRoutes().find(r => r.id === logEntry.routeId);

        const headers = { ...(logEntry.requestHeaders || {}) };
        delete headers['host'];
        delete headers['content-length'];
        delete headers['connection'];
        delete headers['authorization'];
        delete headers['x-api-key'];
        delete headers['cookie'];

        if (targetOverride) {
          headers['x-debug-override-target'] = targetOverride;
        }
        if (useCanary && route?.canary?.target) {
          headers['x-debug-override-target'] = route.canary.target;
        }

        let replayBody = null;
        if (logEntry.method !== 'GET' && logEntry.method !== 'HEAD' && logEntry.requestBody) {
          try {
            replayBody = Buffer.from(logEntry.requestBody, logEntry.requestBodyEncoding || 'base64');
          } catch (e) {
            replayBody = null;
          }
        }

        const startTime = Date.now();
        const replayResult = await this.makeUpstreamRequest({
          method: logEntry.method,
          url: `http://localhost:${gatewayPort}${logEntry.originalUrl || logEntry.path}`,
          headers,
          body: replayBody
        });
        const duration = Date.now() - startTime;

        const originalBody = typeof replayResult.body === 'object'
          ? JSON.stringify(replayResult.body)
          : String(replayResult.body || '');

        const createHash = (s) => {
          try {
            return require('crypto').createHash('md5').update(s).digest('hex');
          } catch (e) {
            return `${s.length}bytes`;
          }
        };

        const originalRespHeaders = logEntry.responseHeaders || {};
        const replayRespHeaders = replayResult.headers || {};
        const headerDiffs = [];
        const allHeaderKeys = new Set([...Object.keys(originalRespHeaders), ...Object.keys(replayRespHeaders)]);
        const skipHeaders = ['date', 'x-cache', 'x-response-time', 'connection', 'keep-alive', 'transfer-encoding', 'x-gateway-target', 'x-gateway-error', 'x-canary', 'x-canary-rule'];
        for (const k of allHeaderKeys) {
          if (skipHeaders.includes(k.toLowerCase())) continue;
          if (originalRespHeaders[k] !== replayRespHeaders[k]) {
            headerDiffs.push({
              name: k,
              original: originalRespHeaders[k] || null,
              replay: replayRespHeaders[k] || null
            });
          }
        }

        const comparison = {
          statusCode: {
            original: logEntry.statusCode,
            replay: replayResult.statusCode,
            match: logEntry.statusCode === replayResult.statusCode
          },
          durationMs: {
            original: parseFloat(logEntry.durationMs),
            replay: duration
          },
          headers: {
            diffCount: headerDiffs.length,
            diffs: headerDiffs
          },
          body: {
            originalStatus: logEntry.statusCode,
            replayStatus: replayResult.statusCode,
            replayBodyHash: createHash(originalBody),
            replayBodyPreview: originalBody.slice(0, 500)
          }
        };

        res.json({
          success: true,
          replay: {
            statusCode: replayResult.statusCode,
            headers: replayResult.headers,
            body: replayResult.body,
            durationMs: duration,
            targetUsed: replayResult.headers['x-gateway-target'] || null
          },
          original: {
            statusCode: logEntry.statusCode,
            headers: originalRespHeaders,
            durationMs: parseFloat(logEntry.durationMs),
            target: logEntry.target,
            cacheHit: logEntry.cacheHit
          },
          comparison
        });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    this.app.get('/api/circuit-breaker/status', (req, res) => {
      if (!this.circuitBreaker) {
        return res.json({ enabled: false });
      }
      res.json({
        enabled: true,
        statuses: this.circuitBreaker.getAllStatuses()
      });
    });

    this.app.post('/api/circuit-breaker/:target/force-close', (req, res) => {
      if (!this.circuitBreaker) {
        return res.json({ success: false, error: 'Circuit breaker not enabled' });
      }
      const target = decodeURIComponent(req.params.target);
      this.circuitBreaker.forceClose(target);
      res.json({ success: true, status: this.circuitBreaker.getStatus(target) });
    });

    this.app.post('/api/circuit-breaker/:target/force-open', (req, res) => {
      if (!this.circuitBreaker) {
        return res.json({ success: false, error: 'Circuit breaker not enabled' });
      }
      const target = decodeURIComponent(req.params.target);
      const reason = req.body?.reason || 'Manually opened via admin';
      this.circuitBreaker.forceOpen(target, reason);
      res.json({ success: true, status: this.circuitBreaker.getStatus(target) });
    });

    this.app.post('/api/circuit-breaker/reset', (req, res) => {
      if (!this.circuitBreaker) {
        return res.json({ success: false, error: 'Circuit breaker not enabled' });
      }
      this.circuitBreaker.reset();
      res.json({ success: true });
    });

    this.app.get('/api/versions', (req, res) => {
      const limit = parseInt(req.query.limit) || 20;
      res.json({ versions: this.configManager.getVersions(limit) });
    });

    this.app.get('/api/versions/:id', (req, res) => {
      const version = this.configManager.getVersion(req.params.id);
      if (!version) {
        return res.status(404).json({ error: 'Version not found' });
      }
      res.json({
        id: version.id,
        timestamp: version.timestamp,
        changeType: version.changeType,
        author: version.author,
        message: version.message,
        changes: version.changes,
        snapshot: version.snapshot
      });
    });

    this.app.post('/api/versions/:id/rollback', async (req, res) => {
      try {
        const result = await this.configManager.rollbackToVersion(req.params.id);
        if (result.success) {
          this.cache.clearAll();
          if (this.canary) this.canary.resetStats();
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    this.app.get('/api/logs', (req, res) => {
      try {
        const { caller, routeId, statusCode, cacheHit, method, target, limit = 50, offset = 0 } = req.query;
        const filters = { caller, routeId, statusCode, cacheHit, method, target };
        Object.keys(filters).forEach(k => filters[k] === undefined && delete filters[k]);
        const result = this.logStore.query(filters, parseInt(limit), parseInt(offset));
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/logs/stats', (req, res) => {
      res.json(this.logStore.getStats());
    });

    this.app.get('/api/logs/:id', (req, res) => {
      const entry = this.logStore.getById(req.params.id);
      if (!entry) {
        return res.status(404).json({ error: 'Log entry not found' });
      }
      res.json(entry);
    });

    this.app.get('/api/logs/values/:field', (req, res) => {
      const values = this.logStore.getDistinctValues(req.params.field);
      res.json({ field: req.params.field, values });
    });

    this.app.get('/api/cache/stats', (req, res) => {
      res.json(this.cache.getStats());
    });

    this.app.post('/api/cache/invalidate/:routeId', (req, res) => {
      const success = this.cache.invalidateRoute(req.params.routeId);
      res.json({ success });
    });

    this.app.post('/api/cache/clear', (req, res) => {
      this.cache.clearAll();
      res.json({ success: true });
    });

    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not Found' });
    });
  }

  makeUpstreamRequest({ method, url, headers, body }) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        timeout: 10000
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          let parsedBody = responseBody;
          try {
            parsedBody = JSON.parse(responseBody);
          } catch (e) {}

          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: parsedBody,
            rawBody: responseBody
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out after 10s'));
      });

      req.on('error', reject);

      if (body !== null && body !== undefined) {
        let bodyStr;
        if (Buffer.isBuffer(body)) {
          bodyStr = body;
        } else if (typeof body === 'object') {
          bodyStr = JSON.stringify(body);
        } else {
          bodyStr = String(body);
        }
        req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
        req.write(bodyStr);
      }
      req.end();
    });
  }

  start() {
    const port = this.configManager.getAdminPort();
    this.server = this.app.listen(port, () => {
      console.log(`[Admin] Management interface started on port ${port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close(() => {
        console.log('[Admin] Management interface stopped');
      });
    }
  }
}

module.exports = AdminServer;
