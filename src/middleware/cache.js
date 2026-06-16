const { LRUCache } = require('lru-cache');
const crypto = require('crypto');

class CacheMiddleware {
  constructor(configManager) {
    this.configManager = configManager;
    this.caches = new Map();
    this.maxSize = 500;

    this.configManager.on('config:updated', () => {
      this.rebuildCaches();
    });

    this.rebuildCaches();
  }

  rebuildCaches() {
    const routes = this.configManager.getRoutes();
    const newCaches = new Map();

    for (const route of routes) {
      if (route.cache?.enabled) {
        const existing = this.caches.get(route.id);
        if (existing) {
          const newTtl = (route.cache.ttl || 60) * 1000;
          if (existing.ttl === newTtl) {
            newCaches.set(route.id, existing);
            continue;
          }
        }
        newCaches.set(route.id, this.createCache(route));
      }
    }

    for (const [id, cache] of this.caches) {
      if (!newCaches.has(id)) {
        cache.clear();
      }
    }

    this.caches = newCaches;
  }

  createCache(route) {
    const ttl = (route.cache.ttl || 60) * 1000;
    const cache = new LRUCache({
      max: this.maxSize,
      ttl,
      allowStale: false,
      updateAgeOnGet: false
    });
    cache.ttl = ttl;
    return cache;
  }

  handler() {
    return (req, res, next) => {
      const route = req.gatewayRoute;
      if (!route || !route.cache?.enabled) {
        return next();
      }

      const methods = route.cache.methods || ['GET'];
      if (!methods.includes(req.method.toUpperCase())) {
        return next();
      }

      const cache = this.caches.get(route.id);
      if (!cache) {
        return next();
      }

      const cacheKey = this.generateCacheKey(req);
      const cached = cache.get(cacheKey);

      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        res.setHeader('Content-Type', cached.contentType);
        return res.status(cached.statusCode).send(cached.body);
      }

      res.setHeader('X-Cache', 'MISS');

      const originalWrite = res.write;
      const originalEnd = res.end;
      const originalSend = res.send;
      const originalJson = res.json;

      const chunks = [];
      let responseContentType = null;
      let shouldCache = true;

      res.write = function(chunk, encoding, callback) {
        if (shouldCache && res.statusCode < 400) {
          if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk, encoding));
          } else if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
          }
        }
        return originalWrite.call(this, chunk, encoding, callback);
      };

      res.end = function(chunk, encoding, callback) {
        if (shouldCache && res.statusCode < 400) {
          if (chunk) {
            if (typeof chunk === 'string') {
              chunks.push(Buffer.from(chunk, encoding));
            } else if (Buffer.isBuffer(chunk)) {
              chunks.push(chunk);
            }
          }
          if (chunks.length > 0) {
            const body = Buffer.concat(chunks);
            responseContentType = res.getHeader('Content-Type') || 'application/json';
            cache.set(cacheKey, {
              statusCode: res.statusCode,
              contentType: responseContentType,
              body: body.toString(),
              timestamp: Date.now()
            });
          }
        }
        return originalEnd.call(this, chunk, encoding, callback);
      };

      res.send = function(body) {
        if (res.statusCode < 400) {
          responseContentType = res.getHeader('Content-Type') || 'application/json';
          const bodyStr = typeof body === 'object' ? JSON.stringify(body) : String(body);
          cache.set(cacheKey, {
            statusCode: res.statusCode,
            contentType: responseContentType,
            body: bodyStr,
            timestamp: Date.now()
          });
          shouldCache = false;
        }
        return originalSend.call(this, body);
      };

      res.json = function(body) {
        if (res.statusCode < 400) {
          const bodyStr = JSON.stringify(body);
          cache.set(cacheKey, {
            statusCode: res.statusCode,
            contentType: 'application/json',
            body: bodyStr,
            timestamp: Date.now()
          });
          shouldCache = false;
        }
        return originalJson.call(this, body);
      };

      next();
    };
  }

  generateCacheKey(req) {
    const parts = [
      req.method.toUpperCase(),
      req.originalUrl,
      req.headers['accept-encoding'] || '',
      req.headers['accept'] || ''
    ];

    return crypto
      .createHash('sha256')
      .update(parts.join('|'))
      .digest('hex')
      .slice(0, 16);
  }

  invalidateRoute(routeId) {
    const cache = this.caches.get(routeId);
    if (cache) {
      cache.clear();
      return true;
    }
    return false;
  }

  clearAll() {
    for (const cache of this.caches.values()) {
      cache.clear();
    }
  }

  getStats() {
    const stats = {};
    for (const [routeId, cache] of this.caches) {
      stats[routeId] = {
        size: cache.size,
        maxSize: cache.max
      };
    }
    return stats;
  }
}

module.exports = CacheMiddleware;
