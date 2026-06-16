const express = require('express');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');

class AdminServer {
  constructor(configManager, cache, rateLimiter, logger, gateway) {
    this.configManager = configManager;
    this.cache = cache;
    this.rateLimiter = rateLimiter;
    this.logger = logger;
    this.logStore = logger.logStore;
    this.gateway = gateway;
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

        const targetPath = route.stripPrefix ? path.replace(route.path, '') : path;
        const targetUrl = new URL(targetPath || '/', route.target);

        const upstreamHeaders = {};
        Object.entries({ ...headers, ...(route.headers || {}) }).forEach(([k, v]) => {
          upstreamHeaders[k.toLowerCase()] = v;
        });
        upstreamHeaders['host'] = targetUrl.hostname;
        delete upstreamHeaders['content-length'];

        const requestBody = body !== null ? (typeof body === 'object' ? JSON.stringify(body) : String(body)) : null;
        if (requestBody !== null && !upstreamHeaders['content-type']) {
          upstreamHeaders['content-type'] = typeof body === 'object' ? 'application/json' : 'text/plain';
        }

        const startTime = Date.now();

        const upstreamResult = await this.makeUpstreamRequest({
          method: method.toUpperCase(),
          url: targetUrl.toString(),
          headers: upstreamHeaders,
          body: requestBody
        });

        const duration = Date.now() - startTime;

        const cacheKey = this.cache.generateCacheKey({
          method: method.toUpperCase(),
          originalUrl: route.path + (path || ''),
          headers: headers
        });

        const routeCache = this.cache.caches.get(routeId);
        const cachedEntry = routeCache ? routeCache.get(cacheKey) : null;

        res.json({
          success: true,
          matchedRoute: route,
          computedPath: targetPath,
          upstreamUrl: targetUrl.toString(),
          upstreamHeaders,
          requestBodySent: requestBody,
          upstreamResponse: {
            statusCode: upstreamResult.statusCode,
            statusMessage: upstreamResult.statusMessage,
            headers: upstreamResult.headers,
            body: upstreamResult.body
          },
          cacheInfo: {
            wouldCache: route.cache?.enabled && (route.cache.methods || ['GET']).includes(method.toUpperCase()) && upstreamResult.statusCode < 400,
            cacheKey,
            existingCache: cachedEntry ? {
              statusCode: cachedEntry.statusCode,
              timestamp: new Date(cachedEntry.timestamp).toISOString(),
              age: Math.floor((Date.now() - cachedEntry.timestamp) / 1000) + 's'
            } : null
          },
          durationMs: duration
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
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
        const bodyStr = typeof body === 'object' ? JSON.stringify(body) : String(body);
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
