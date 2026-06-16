const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class AdminServer {
  constructor(configManager, cache, rateLimiter) {
    this.configManager = configManager;
    this.cache = cache;
    this.rateLimiter = rateLimiter;
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
        if (!Array.isArray(routes)) {
          return res.status(400).json({ error: 'Routes must be an array' });
        }
        for (const route of routes) {
          if (!route.id) route.id = `route-${uuidv4().slice(0, 8)}`;
          if (!route.cache) route.cache = { enabled: false };
          if (typeof route.authRequired === 'undefined') route.authRequired = true;
          if (typeof route.rateLimitBypass === 'undefined') route.rateLimitBypass = false;
        }
        await this.configManager.updateRoutes(routes);
        res.json({ success: true, routes: this.configManager.getRoutes() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/routes/:id', async (req, res) => {
      try {
        const routeId = req.params.id;
        const updates = req.body;
        const routes = this.configManager.getRoutes();
        const index = routes.findIndex(r => r.id === routeId);

        if (index === -1) {
          return res.status(404).json({ error: 'Route not found' });
        }

        routes[index] = { ...routes[index], ...updates, id: routeId };
        await this.configManager.updateRoutes(routes);
        this.cache.invalidateRoute(routeId);

        res.json({ success: true, route: routes[index] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
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
