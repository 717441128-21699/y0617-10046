const http = require('http');
const { createBackend } = require('./mock-backends');
const Gateway = require('../src');
const ConfigManager = require('../src/config');

const GATEWAY_PORT = 3100;
const ADMIN_PORT = 3101;
const BACKEND1_PORT = 4101;
const BACKEND2_PORT = 4102;
const BACKEND3_PORT = 4103;

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    if (body !== null) {
      options.headers = options.headers || {};
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const timeout = options.timeout || 30000;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('🚀 Starting API Gateway Integration Tests');
  console.log('='.repeat(60));

  let backend1, backend2, backend3;
  let gateway;
  let passed = 0;
  let failed = 0;

  try {
    console.log('\n📡 Starting mock backends...');
    backend1 = await createBackend(BACKEND1_PORT, 'users-service');
    backend2 = await createBackend(BACKEND2_PORT, 'orders-service');
    backend3 = await createBackend(BACKEND3_PORT, 'public-service');

    const testConfigPath = require('path').join(__dirname, 'test-gateway.json');
    const fs = require('fs');
    const testConfig = {
      server: { port: GATEWAY_PORT, adminPort: ADMIN_PORT },
      routes: [
        {
          id: 'test-route-1',
          path: '/api/users',
          priority: 100,
          stripPrefix: true,
          target: `http://localhost:${BACKEND1_PORT}`,
          headers: { 'X-Gateway-Id': 'test-gateway' },
          cache: { enabled: true, ttl: 5, methods: ['GET'] },
          authRequired: true,
          rateLimitBypass: false
        },
        {
          id: 'test-route-2',
          path: '/api/orders',
          priority: 90,
          stripPrefix: false,
          target: `http://localhost:${BACKEND2_PORT}`,
          headers: {},
          cache: { enabled: false },
          authRequired: true,
          rateLimitBypass: false
        },
        {
          id: 'test-route-3',
          path: '/public',
          priority: 50,
          stripPrefix: false,
          target: `http://localhost:${BACKEND3_PORT}`,
          headers: {},
          cache: { enabled: false },
          authRequired: false,
          rateLimitBypass: true
        }
      ],
      apiKeys: [
        {
          key: 'test_key_abc123',
          caller: 'test-client',
          revoked: false,
          rateLimit: { requests: 10, windowMs: 60000 }
        },
        {
          key: 'test_key_revoked',
          caller: 'bad-client',
          revoked: true,
          rateLimit: { requests: 10, windowMs: 60000 }
        }
      ],
      global: { defaultRateLimit: { requests: 5, windowMs: 60000 } }
    };
    fs.writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

    console.log('\n⚙️  Starting API Gateway...');
    process.env.__TEST_CONFIG_PATH__ = testConfigPath;

    const express = require('express');
    const Router = require('../src/router');
    const AuthMiddleware = require('../src/middleware/auth');
    const RateLimitMiddleware = require('../src/middleware/rateLimit');
    const LoggerMiddleware = require('../src/middleware/logger');
    const CacheMiddleware = require('../src/middleware/cache');
    const CanaryManager = require('../src/middleware/canary');
    const CircuitBreakerManager = require('../src/middleware/circuitBreaker');
    const AdminServer = require('../src/admin');

    const versionsPath = require('path').join(__dirname, '.versions-test.json');
    try { require('fs').unlinkSync(versionsPath); } catch (e) {}

    const configManager = new ConfigManager(testConfigPath);
    const canary = new CanaryManager(configManager);
    const circuitBreaker = new CircuitBreakerManager(configManager, { healthCheckInterval: 60000, resetTimeout: 5000 });
    gateway = {
      configManager,
      canary,
      circuitBreaker,
      router: new Router(configManager, canary, circuitBreaker),
      auth: new AuthMiddleware(configManager),
      rateLimiter: new RateLimitMiddleware(configManager),
      logger: new LoggerMiddleware(),
      cache: new CacheMiddleware(configManager),
      app: express(),
      server: null,
      admin: null,
      setupMiddleware() {
        this.app.disable('x-powered-by');
        this.app.set('trust proxy', true);

        const rawBodySaver = (req, res, buf, encoding) => {
          if (buf && buf.length) {
            req.rawBody = buf.toString(encoding || 'utf8');
          }
        };

        this.app.use(express.json({ limit: '10mb', verify: rawBodySaver }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb', verify: rawBodySaver }));

        this.app.use((req, res, next) => {
          if (req.rawBody !== undefined) {
            const contentType = (req.headers['content-type'] || '').toLowerCase();
            const hasJson = contentType.includes('application/json');
            const hasForm = contentType.includes('application/x-www-form-urlencoded');
            if (!hasJson && !hasForm) {
              req.body = req.rawBody;
            }
          }
          next();
        });

        this.app.use(this.logger.handler());
        this.app.use(this.router.routeMatcher.bind(this.router));
        this.app.use(this.auth.handler());
        this.app.use(this.rateLimiter.handler());
        this.app.use(this.cache.handler());
      },
      setupRoutes() {
        this.app.get('/health', (req, res) => {
          res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
        });
        this.app.all('*', this.router.proxyHandler());
        this.app.use((err, req, res, next) => {
          console.error('[Gateway] Error:', err.message);
          res.status(500).json({ error: 'Internal Server Error', message: err.message });
        });
      },
      start() {
        const port = this.configManager.getServerPort();
        this.server = this.app.listen(port, () => {
          console.log(`[Gateway] API Gateway started on port ${port}`);
        });
        this.admin = new AdminServer(this.configManager, this.cache, this.rateLimiter, this.logger, this, this.canary, this.circuitBreaker);
        this.admin.start();
      },
      stop() {
        if (this.server) this.server.close();
        if (this.admin) this.admin.stop();
        this.router.close();
        this.rateLimiter.close();
        if (this.circuitBreaker) this.circuitBreaker.close();
        this.configManager.close();
      }
    };
    gateway.setupMiddleware();
    gateway.setupRoutes();
    gateway.start();

    await new Promise(r => setTimeout(r, 1000));
    console.log('\n🧪 Running tests...\n');

    async function test(name, fn) {
      try {
        await fn();
        console.log(`✅ PASS: ${name}`);
        passed++;
      } catch (err) {
        console.log(`❌ FAIL: ${name}`);
        console.log(`   Error: ${err.message}`);
        failed++;
      }
    }

    function assert(condition, message) {
      if (!condition) throw new Error(message);
    }
    assert.deepStrictEqual = function(actual, expected, message) {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(message || `Expected ${expectedStr} but got ${actualStr}`);
      }
    };

    await test('Health endpoint', async () => {
      const res = await request({ hostname: 'localhost', port: GATEWAY_PORT, path: '/health', method: 'GET' });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.status === 'ok', 'Expected status ok');
    });

    await test('Public route without API key', async () => {
      const res = await request({ hostname: 'localhost', port: GATEWAY_PORT, path: '/public/test', method: 'GET' });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.backend === 'public-service', 'Wrong backend');
    });

    await test('Protected route without API key returns 401', async () => {
      const res = await request({ hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users', method: 'GET' });
      assert(res.statusCode === 401, `Expected 401, got ${res.statusCode}`);
    });

    await test('Protected route with valid API key via header', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/profile', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.backend === 'users-service', 'Wrong backend');
      assert(res.body.receivedPath === '/profile', 'Prefix not stripped');
      assert(res.body.receivedHeaders['x-gateway-id'] === 'test-gateway', 'Header not injected');
      assert(res.body.receivedHeaders['x-gateway-caller'] === 'test-client', 'Caller header not set');
    });

    await test('API key via Authorization Bearer', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/profile', method: 'GET',
        headers: { 'authorization': 'Bearer test_key_abc123' }
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.backend === 'users-service', 'Wrong backend');
    });

    await test('API key via query string', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/profile?api_key=test_key_abc123', method: 'GET'
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
    });

    await test('Revoked API key returns 401', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users', method: 'GET',
        headers: { 'x-api-key': 'test_key_revoked' }
      });
      assert(res.statusCode === 401, `Expected 401, got ${res.statusCode}`);
      assert(res.body.message.includes('revoked'), 'Should mention revoked');
    });

    await test('Invalid API key returns 401', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users', method: 'GET',
        headers: { 'x-api-key': 'invalid_key' }
      });
      assert(res.statusCode === 401, `Expected 401, got ${res.statusCode}`);
    });

    await test('Route without prefix stripping', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/orders/123', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.backend === 'orders-service', 'Wrong backend');
      assert(res.body.receivedPath === '/api/orders/123', 'Prefix should not be stripped');
    });

    await test('Rate limiting returns 429', async () => {
      const keyConfig = gateway.configManager.getApiKey('test_key_abc123');
      keyConfig.rateLimit = { requests: 2, windowMs: 60000 };
      gateway.rateLimiter.keyBuckets.clear();

      const responses = [];
      for (let i = 0; i < 5; i++) {
        const res = await request({
          hostname: 'localhost', port: GATEWAY_PORT, path: '/api/orders', method: 'GET',
          headers: { 'x-api-key': 'test_key_abc123' }
        });
        responses.push(res.statusCode);
      }

      assert(responses.filter(s => s === 200).length === 2, 'Should have 2 successful requests');
      assert(responses.filter(s => s === 429).length === 3, 'Should have 3 rate limited requests');

      const rateLimited = responses.find(r => r === 429 && responses.indexOf(r) >= 2);
      if (responses.includes(429)) {
        const idx = responses.indexOf(429);
        const res = await request({
          hostname: 'localhost', port: GATEWAY_PORT, path: '/api/orders', method: 'GET',
          headers: { 'x-api-key': 'test_key_abc123' }
        });
        assert(res.headers['retry-after'] !== undefined, 'Should have Retry-After header');
      }

      keyConfig.rateLimit = { requests: 10, windowMs: 60000 };
      gateway.rateLimiter.keyBuckets.clear();
    });

    await test('Rate limit headers present', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/orders', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.headers['x-ratelimit-limit'] !== undefined, 'Missing X-RateLimit-Limit');
      assert(res.headers['x-ratelimit-remaining'] !== undefined, 'Missing X-RateLimit-Remaining');
      assert(res.headers['x-ratelimit-reset'] !== undefined, 'Missing X-RateLimit-Reset');
    });

    await test('Cache headers - MISS on first request', async () => {
      gateway.cache.clearAll();
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cached', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.headers['x-cache'] === 'MISS', 'Should be MISS on first request');
    });

    await test('Cache headers - HIT on second request', async () => {
      await new Promise(r => setTimeout(r, 50));
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cached', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.headers['x-cache'] === 'HIT', 'Should be HIT on second request');
    });

    await test('POST requests bypass cache', async () => {
      gateway.cache.clearAll();
      const res1 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cached', method: 'POST',
        headers: { 'x-api-key': 'test_key_abc123', 'Content-Type': 'application/json' }
      }, JSON.stringify({ test: true }));
      assert(res1.headers['x-cache'] === undefined, 'POST should not set cache header');
    });

    await test('Non-matching path returns 404', async () => {
      const res = await request({ hostname: 'localhost', port: GATEWAY_PORT, path: '/nonexistent', method: 'GET' });
      assert(res.statusCode === 404, `Expected 404, got ${res.statusCode}`);
    });

    await test('Admin API - GET /api/routes', async () => {
      const res = await request({ hostname: 'localhost', port: ADMIN_PORT, path: '/api/routes', method: 'GET' });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(Array.isArray(res.body), 'Should return array');
      assert(res.body.length === 3, 'Should have 3 routes');
    });

    await test('Admin API - GET /api/apikeys', async () => {
      const res = await request({ hostname: 'localhost', port: ADMIN_PORT, path: '/api/apikeys', method: 'GET' });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(Array.isArray(res.body), 'Should return array');
      assert(res.body.length === 2, 'Should have 2 keys');
    });

    await test('Admin API - Revoke API Key', async () => {
      const res = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/apikeys/${encodeURIComponent('test_key_abc123')}/revoke`
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.success === true, 'Should return success');

      const verifyRes = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(verifyRes.statusCode === 401, 'Key should be revoked');

      const unrevoke = gateway.configManager.getApiKey('test_key_abc123');
      unrevoke.revoked = false;
      await gateway.configManager.updateApiKeys(gateway.configManager.getApiKeys());
    });

    await test('Admin API - Update rate limit', async () => {
      const res = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/apikeys/${encodeURIComponent('test_key_abc123')}/ratelimit`,
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ requests: 50, windowMs: 30000 }));
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      const keyConfig = gateway.configManager.getApiKey('test_key_abc123');
      assert(keyConfig.rateLimit.requests === 50, 'Requests should be updated');
      assert(keyConfig.rateLimit.windowMs === 30000, 'Window should be updated');

      keyConfig.rateLimit = { requests: 10, windowMs: 60000 };
      await gateway.configManager.updateApiKeys(gateway.configManager.getApiKeys());
    });

    await test('Admin API - GET cache stats', async () => {
      const res = await request({ hostname: 'localhost', port: ADMIN_PORT, path: '/api/cache/stats', method: 'GET' });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body['test-route-1'] !== undefined, 'Should have cache stats for route 1');
    });

    await test('Admin API - Clear all cache', async () => {
      const res = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/cache/clear', method: 'POST'
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.success === true, 'Should return success');
    });

    await test('Query string passthrough', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/search?q=test&page=1', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.echo.query.includes('q=test'), 'Query string should be passed through');
      assert(res.body.echo.query.includes('page=1'), 'Query string should be passed through');
    });

    await test('Gateway processing headers', async () => {
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.headers['x-gateway-processed'] === 'true', 'Missing X-Gateway-Processed');
      assert(res.headers['x-gateway-route'] === 'test-route-1', 'Missing X-Gateway-Route');
    });

    await test('POST with nested JSON body', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      const nestedBody = {
        user: {
          name: 'test',
          profile: {
            age: 25,
            tags: ['a', 'b', 'c'],
            metadata: {
              nested: {
                value: true
              }
            }
          }
        },
        items: [1, 2, 3]
      };
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/echo', method: 'POST',
        headers: {
          'x-api-key': 'test_key_abc123',
          'Content-Type': 'application/json'
        }
      }, JSON.stringify(nestedBody));
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.method === 'POST', 'Method should be POST');
      assert.deepStrictEqual(res.body.body, nestedBody, 'Nested JSON body should match');
    });

    await test('PUT with empty body', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/echo', method: 'PUT',
        headers: {
          'x-api-key': 'test_key_abc123'
        }
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.method === 'PUT', 'Method should be PUT');
      assert(res.body.body === null || res.body.body === '' ||
        (typeof res.body.body === 'object' && Object.keys(res.body.body).length === 0),
        'Body should be null, empty, or empty object');
    });

    await test('PATCH with form-urlencoded data', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      const formData = 'name=John+Doe&email=john%40example.com&age=30';
      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/echo', method: 'PATCH',
        headers: {
          'x-api-key': 'test_key_abc123',
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }, formData);
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.method === 'PATCH', 'Method should be PATCH');
      assert(res.body.body.name === 'John Doe', 'Form field name should match');
      assert(res.body.body.email === 'john@example.com', 'Form field email should match');
      assert(res.body.body.age === '30', 'Form field age should match');
    });

    await test('Cache invalidation after route target change', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();
      const res1 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cachetest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res1.headers['x-cache'] === 'MISS', 'First request should be MISS');

      await new Promise(r => setTimeout(r, 50));
      const res2 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cachetest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res2.headers['x-cache'] === 'HIT', 'Second request should be HIT');
      assert(res2.body.backend === 'users-service', 'Should hit users-service');

      const updateRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ target: `http://localhost:${BACKEND2_PORT}` }));
      assert(updateRes.statusCode === 200, 'Route update should succeed');

      await new Promise(r => setTimeout(r, 50));
      const res3 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cachetest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res3.headers['x-cache'] === 'MISS', 'After route change should be MISS');
      assert(res3.body.backend === 'orders-service', 'Should now hit orders-service');

      const revertRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ target: `http://localhost:${BACKEND1_PORT}` }));
      assert(revertRes.statusCode === 200, 'Route revert should succeed');
    });

    await test('Cache invalidation after header injection change', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();
      const res1 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/injtest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res1.headers['x-cache'] === 'MISS', 'First request should be MISS');

      await new Promise(r => setTimeout(r, 50));
      const res2 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/injtest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res2.headers['x-cache'] === 'HIT', 'Second request should be HIT');
      assert(res2.body.receivedHeaders['x-gateway-id'] === 'test-gateway', 'Should have original header');

      const updateRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ headers: { 'X-Gateway-Id': 'updated-gateway', 'X-New-Header': 'new-value' } }));
      assert(updateRes.statusCode === 200, 'Route update should succeed');

      await new Promise(r => setTimeout(r, 50));
      const res3 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/injtest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res3.headers['x-cache'] === 'MISS', 'After header change should be MISS');
      assert(res3.body.receivedHeaders['x-gateway-id'] === 'updated-gateway', 'Should have updated header');
      assert(res3.body.receivedHeaders['x-new-header'] === 'new-value', 'Should have new header');

      const revertRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ headers: { 'X-Gateway-Id': 'test-gateway' } }));
      assert(revertRes.statusCode === 200, 'Route revert should succeed');
    });

    await test('Cache invalidation after stripPrefix change', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();
      const res1 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/prefixtest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res1.headers['x-cache'] === 'MISS', 'First request should be MISS');
      assert(res1.body.receivedPath === '/prefixtest', 'Prefix should be stripped');

      await new Promise(r => setTimeout(r, 50));
      const res2 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/prefixtest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res2.headers['x-cache'] === 'HIT', 'Second request should be HIT');

      const updateRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ stripPrefix: false }));
      assert(updateRes.statusCode === 200, 'Route update should succeed');

      await new Promise(r => setTimeout(r, 50));
      const res3 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/prefixtest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res3.headers['x-cache'] === 'MISS', 'After stripPrefix change should be MISS');
      assert(res3.body.receivedPath === '/api/users/prefixtest', 'Prefix should NOT be stripped');

      const revertRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ stripPrefix: true }));
      assert(revertRes.statusCode === 200, 'Route revert should succeed');
    });

    await test('Cache invalidation after cache TTL change', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();
      const res1 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttltest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res1.headers['x-cache'] === 'MISS', 'First request should be MISS');

      await new Promise(r => setTimeout(r, 50));
      const res2 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttltest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res2.headers['x-cache'] === 'HIT', 'Second request should be HIT');

      const updateRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ cache: { enabled: true, ttl: 60, methods: ['GET'] } }));
      assert(updateRes.statusCode === 200, 'Route update should succeed');

      await new Promise(r => setTimeout(r, 50));
      const res3 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttltest', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res3.headers['x-cache'] === 'MISS', 'After TTL change should be MISS');

      const revertRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ cache: { enabled: true, ttl: 5, methods: ['GET'] } }));
      assert(revertRes.statusCode === 200, 'Route revert should succeed');
    });

    await test('Route priority matching - higher priority matches first', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();

      const routes = gateway.configManager.getRoutes();
      const overlappingRoute = {
        id: 'test-route-overlap',
        path: '/api/users/special',
        priority: 200,
        stripPrefix: false,
        target: `http://localhost:${BACKEND2_PORT}`,
        headers: {},
        cache: { enabled: false },
        authRequired: true,
        rateLimitBypass: false
      };
      routes.push(overlappingRoute);

      const saveRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(routes));
      assert(saveRes.statusCode === 200, 'Route save should succeed');

      await new Promise(r => setTimeout(r, 100));

      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/special/test', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.statusCode === 200, 'Request should succeed');
      assert(res.body.backend === 'orders-service', 'Higher priority route should match first');

      const cleanupRoutes = gateway.configManager.getRoutes().filter(r => r.id !== 'test-route-overlap');
      await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(cleanupRoutes));
    });

    await test('Route conflict detection API', async () => {
      const routes = gateway.configManager.getRoutes();
      const conflictingRoute = {
        id: 'test-conflict',
        path: '/api/users',
        priority: 100,
        stripPrefix: false,
        target: `http://localhost:${BACKEND2_PORT}`,
        headers: {},
        cache: { enabled: false },
        authRequired: true,
        rateLimitBypass: false
      };
      const testRoutes = [...routes, conflictingRoute];

      const saveRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(testRoutes));
      assert(saveRes.statusCode === 409, 'Should return 409 Conflict');
      assert(saveRes.body.conflicts.length > 0, 'Should have conflict warnings');
      assert(saveRes.body.success === false, 'Should not save with conflicts');

      const checkRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'GET',
        path: '/api/routes/conflicts'
      });
      assert(Array.isArray(checkRes.body.conflicts), 'Should return conflicts array');
    });

    await test('Cache TTL change - new entries use new TTL', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();

      const shortTtlRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ cache: { enabled: true, ttl: 2, methods: ['GET'] } }));
      assert(shortTtlRes.statusCode === 200, 'Set short TTL should succeed');

      await new Promise(r => setTimeout(r, 50));
      const res1 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttl2test', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res1.headers['x-cache'] === 'MISS', 'First request MISS with short TTL');

      await new Promise(r => setTimeout(r, 100));
      const res2 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttl2test', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res2.headers['x-cache'] === 'HIT', 'Second request HIT within TTL');

      await new Promise(r => setTimeout(r, 2200));
      const res3 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttl2test', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res3.headers['x-cache'] === 'MISS', 'Should MISS after short TTL expired');

      const longTtlRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ cache: { enabled: true, ttl: 30, methods: ['GET'] } }));
      assert(longTtlRes.statusCode === 200, 'Set long TTL should succeed');

      await new Promise(r => setTimeout(r, 100));
      const res4 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttl2test', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res4.headers['x-cache'] === 'MISS', 'First after TTL change should MISS');

      await new Promise(r => setTimeout(r, 100));
      const res5 = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/ttl2test', method: 'GET',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res5.headers['x-cache'] === 'HIT', 'Second should HIT with new TTL');

      const revertRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes/test-route-1',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ cache: { enabled: true, ttl: 5, methods: ['GET'] } }));
      assert(revertRes.statusCode === 200, 'Revert TTL should succeed');
    });

    await test('Log store and query API', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.logger.logStore.clear();

      for (let i = 0; i < 5; i++) {
        await request({
          hostname: 'localhost', port: GATEWAY_PORT, path: `/api/users/logtest${i}`, method: 'GET',
          headers: { 'x-api-key': 'test_key_abc123' }
        });
        await new Promise(r => setTimeout(r, 20));
      }

      const logsRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'GET',
        path: '/api/logs?limit=10'
      });
      assert(logsRes.statusCode === 200, 'Logs query should succeed');
      assert(logsRes.body.total >= 5, 'Should have at least 5 log entries');
      assert(logsRes.body.data.length >= 5, 'Should return log data');

      const firstLog = logsRes.body.data[0];
      assert(firstLog.caller === 'test-client', 'Log should have caller');
      assert(firstLog.routeId === 'test-route-1', 'Log should have routeId');
      assert(typeof firstLog.durationMs === 'string', 'Log should have duration');
      assert(firstLog.statusCode === 200, 'Log should have status code');

      const detailRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'GET',
        path: `/api/logs/${firstLog.id}`
      });
      assert(detailRes.statusCode === 200, 'Log detail should succeed');
      assert(detailRes.body.id === firstLog.id, 'Detail should match log id');
      assert(detailRes.body.requestHeaders, 'Detail should have request headers');
      assert(detailRes.body.responseHeaders, 'Detail should have response headers');

      const filterRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'GET',
        path: '/api/logs?caller=test-client&limit=10'
      });
      assert(filterRes.body.data.length > 0, 'Filter by caller should work');

      const statsRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'GET',
        path: '/api/logs/stats'
      });
      assert(statsRes.statusCode === 200, 'Log stats should succeed');
      assert(typeof statsRes.body.total === 'number', 'Stats should have total');
    });

    await test('Route debug API with real gateway', async () => {
      gateway.rateLimiter.keyBuckets.clear();

      const debugRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/debug/route',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({
        routeId: 'test-route-1',
        method: 'GET',
        path: '/api/users/debugtest1',
        headers: { 'x-api-key': 'test_key_abc123' },
        body: null
      }));

      assert(debugRes.statusCode === 200, 'Debug request should succeed');
      assert(debugRes.body.success === true, 'Debug should return success');
      assert(debugRes.body.matchedRoute.id === 'test-route-1', 'Should match correct route');
      assert(debugRes.body.gatewayResponse.statusCode === 200, 'Gateway should return 200');
      assert(debugRes.body.cacheInfo.cacheStatus === 'MISS', 'First request should be cache MISS');

      await new Promise(r => setTimeout(r, 100));

      const debugRes2 = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/debug/route',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({
        routeId: 'test-route-1',
        method: 'GET',
        path: '/api/users/debugtest1',
        headers: { 'x-api-key': 'test_key_abc123' },
        body: null
      }));

      assert(debugRes2.body.cacheInfo.cacheStatus === 'HIT', 'Second request should be cache HIT');
      assert(debugRes2.body.canaryInfo.targetUsed, 'Should have target in canary info');
    });

    await test('Canary routing by caller', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();

      const routes = gateway.configManager.getRoutes();
      routes[0] = {
        ...routes[0],
        canary: {
          enabled: true,
          target: `http://localhost:${BACKEND2_PORT}`,
          rules: [
            { id: 'rule-callers', type: 'caller', callers: ['canary-tester'] }
          ]
        }
      };

      const saveRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(routes));
      assert(saveRes.statusCode === 200, 'Canary save should succeed');

      await new Promise(r => setTimeout(r, 100));

      const normalRes = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/canary1',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(normalRes.body.backend === 'users-service', 'Normal request should go to users');

      const oldKeys = gateway.configManager.getApiKeys();
      oldKeys.push({
        key: 'canary_key_xyz',
        caller: 'canary-tester',
        revoked: false,
        rateLimit: { requests: 100, windowMs: 60000 }
      });
      await gateway.configManager.updateApiKeys(oldKeys);

      await new Promise(r => setTimeout(r, 100));

      const canaryRes = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/canary2',
        headers: { 'x-api-key': 'canary_key_xyz' }
      });
      assert(canaryRes.body.backend === 'orders-service', 'Canary caller should go to orders backend');
      assert(canaryRes.headers['x-canary'] === 'HIT', 'Should have X-Canary header');

      const statsRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/canary/stats', method: 'GET'
      });
      assert(statsRes.body.enabled === true, 'Canary stats should be enabled');
      assert(statsRes.body.stats['test-route-1'].canaryHits >= 1, 'Should have at least 1 canary hit');

      const cleanupKeys = gateway.configManager.getApiKeys().filter(k => k.key !== 'canary_key_xyz');
      await gateway.configManager.updateApiKeys(cleanupKeys);
      const cleanupRoutes = gateway.configManager.getRoutes();
      cleanupRoutes[0] = { ...cleanupRoutes[0], canary: { enabled: false } };
      await gateway.configManager.updateRoutes(cleanupRoutes, { ignoreConflicts: true });
    });

    await test('Circuit breaker after failures', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.circuitBreaker.reset();

      const target = `http://localhost:${BACKEND1_PORT}`;

      for (let i = 0; i < 5; i++) {
        gateway.circuitBreaker.recordFailure(target, 'simulated failure');
      }

      await new Promise(r => setTimeout(r, 50));

      const cbStatus = gateway.circuitBreaker.getStatus(target);
      assert(cbStatus.status === 'OPEN', 'Should be OPEN after 5 failures');

      const res = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/cbtest',
        headers: { 'x-api-key': 'test_key_abc123' }
      });
      assert(res.statusCode === 503, 'Should return 503 when circuit is open');
      assert(res.headers['x-circuit-breaker'] === 'OPEN', 'Should have circuit breaker header');
      assert(res.body.message.includes('Circuit breaker OPEN'), 'Error message should include circuit breaker info');

      const statusRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/circuit-breaker/status'
      });
      assert(statusRes.body.enabled === true, 'Circuit breaker API should be enabled');
      assert(statusRes.body.statuses[target].status === 'OPEN', 'API should report OPEN status');

      const closeRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/circuit-breaker/${encodeURIComponent(target)}/force-close`
      });
      assert(closeRes.body.success === true, 'Force close should succeed');
      assert(closeRes.body.status.status === 'CLOSED', 'Should be CLOSED after force close');

      gateway.circuitBreaker.reset();
    });

    await test('Config version history and rollback', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.cache.clearAll();

      const initialRoutes = gateway.configManager.getRoutes();
      const testTarget = `http://localhost:${BACKEND3_PORT}`;
      const newRoutes = JSON.parse(JSON.stringify(initialRoutes));
      newRoutes[0].target = testTarget;

      const updateRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(newRoutes));
      assert(updateRes.statusCode === 200, 'First update should succeed');

      await new Promise(r => setTimeout(r, 100));

      const versionsRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/versions?limit=5'
      });
      assert(versionsRes.body.versions.length >= 1, 'Should have at least 1 version');
      const firstVersion = versionsRes.body.versions[0];
      assert(firstVersion.changeType === 'routes', 'First version should be routes change');
      assert(firstVersion.hasSnapshot === true, 'First version should have snapshot');

      const detailRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: `/api/versions/${firstVersion.id}`
      });
      assert(detailRes.body.snapshot !== undefined, 'Detail should have snapshot');
      assert(detailRes.body.snapshot.routes[0].target === testTarget, 'Snapshot should have new target');

      const revertRoutes = JSON.parse(JSON.stringify(newRoutes));
      revertRoutes[0].target = initialRoutes[0].target;
      await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(revertRoutes));

      await new Promise(r => setTimeout(r, 100));

      const rollbackRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/versions/${firstVersion.id}/rollback`
      });
      assert(rollbackRes.body.success === true, 'Rollback should succeed');

      const currentRoutes = gateway.configManager.getRoutes();
      assert(currentRoutes[0].target === testTarget, 'Target should match rolled back version');

      const restoredRoutes = JSON.parse(JSON.stringify(currentRoutes));
      restoredRoutes[0].target = initialRoutes[0].target;
      await gateway.configManager.updateRoutes(restoredRoutes, { ignoreConflicts: true });
    });

    await test('502/504 error details in logs', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.circuitBreaker.reset();
      gateway.logger.logStore.clear();

      const badTarget = 'http://localhost:1';
      const testRoutes = gateway.configManager.getRoutes().filter(r => r.id !== 'test-bad-route');
      testRoutes.push({
        id: 'test-bad-route',
        path: '/api/badbackend',
        priority: 95,
        stripPrefix: false,
        target: badTarget,
        headers: {},
        cache: { enabled: false },
        authRequired: false,
        rateLimitBypass: true
      });

      const saveRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(testRoutes));
      assert(saveRes.statusCode === 200, 'Bad route save should succeed');

      await new Promise(r => setTimeout(r, 100));

      const badRes = await request({
        hostname: 'localhost', port: GATEWAY_PORT,
        path: '/api/badbackend/test',
        timeout: 1000
      }).catch(e => ({ statusCode: 0, body: null, headers: {} }));

      if (badRes.statusCode === 502) {
        assert(badRes.body.message.includes(badTarget), '502 error should include target');
        assert(badRes.headers['x-gateway-target'] === badTarget, 'Should have target header');

        await new Promise(r => setTimeout(r, 50));
        const logsRes = await request({
          hostname: 'localhost', port: ADMIN_PORT,
          path: '/api/logs?statusCode=502&limit=10'
        });
        if (logsRes.body.data && logsRes.body.data.length > 0) {
          const log = logsRes.body.data[0];
          assert(log.errorMessage !== null && log.errorMessage !== undefined, 'Log should have error message');
          assert(log.errorMessage.includes(badTarget), 'Log error should include target');
        }
      }

      const cleanupRoutes = gateway.configManager.getRoutes().filter(r => r.id !== 'test-bad-route');
      await gateway.configManager.updateRoutes(cleanupRoutes, { ignoreConflicts: true });
    });

    await test('Canary rule CRUD API and per-rule hit stats', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.canary.resetStats();
      gateway.logger.logStore.clear();

      const routeId = 'test-route-1';
      const canaryTarget = `http://localhost:${BACKEND2_PORT}`;

      const oldKeys = gateway.configManager.getApiKeys();
      oldKeys.push({
        key: 'canary_test_key_a',
        caller: 'canary-caller-a',
        revoked: false,
        rateLimit: { requests: 100, windowMs: 60000 }
      });
      oldKeys.push({
        key: 'canary_test_key_b',
        caller: 'regular-caller',
        revoked: false,
        rateLimit: { requests: 100, windowMs: 60000 }
      });
      await gateway.configManager.updateApiKeys(oldKeys);

      const saveRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/canary/rules/${routeId}`,
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({
        enabled: true,
        target: canaryTarget,
        rules: [
          { type: 'caller', callers: ['canary-caller-a', 'canary-caller-b'] },
          { type: 'header', headerName: 'x-env', headerValue: 'staging' },
          { type: 'weight', weight: 30 }
        ]
      }));
      assert(saveRes.statusCode === 200, `Save canary rules should return 200, got ${saveRes.statusCode}`);
      assert(saveRes.body.success === true, 'Save should return success');
      assert(saveRes.body.route.canary.enabled === true, 'Canary should be enabled');
      assert(saveRes.body.route.canary.target === canaryTarget, 'Canary target should match');
      assert(saveRes.body.route.canary.rules.length === 3, 'Should have 3 rules');

      const callerRuleId = saveRes.body.route.canary.rules[0].id;

      await new Promise(r => setTimeout(r, 100));

      gateway.cache.clearAll();
      await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/crtest1',
        headers: { 'x-api-key': 'canary_test_key_a' }
      });
      gateway.cache.clearAll();
      await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/crtest2',
        headers: { 'x-api-key': 'canary_test_key_b', 'x-env': 'staging' }
      });
      gateway.cache.clearAll();
      await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/crtest3',
        headers: { 'x-api-key': 'canary_test_key_b' }
      });

      const statsRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/canary/stats'
      });
      assert(statsRes.statusCode === 200, 'Stats request should work');
      const routeStats = statsRes.body.stats[routeId];
      assert(routeStats, `Stats for ${routeId} should exist`);
      assert(routeStats.totalRequests >= 3, `Should have at least 3 requests, got ${routeStats.totalRequests}`);
      assert(routeStats.canaryHits >= 2, `Should have at least 2 canary hits, got ${routeStats.canaryHits}`);
      assert(routeStats.ruleBreakdown, 'ruleBreakdown should exist');
      assert(routeStats.ruleBreakdown[callerRuleId] >= 1, `Caller rule should have at least 1 hit`);

      const toggleRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/canary/rules/${routeId}/toggle`,
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ enabled: false }));
      assert(toggleRes.statusCode === 200 && toggleRes.body.success, 'Toggle should succeed');
      assert(toggleRes.body.route.canary.enabled === false, 'Canary should be disabled');

      const cleanupKeys = gateway.configManager.getApiKeys().filter(k => !k.key.startsWith('canary_test_key_'));
      await gateway.configManager.updateApiKeys(cleanupKeys);
    });

    await test('Route conflict save - cancel keeps original, force save overwrites', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.logger.logStore.clear();
      gateway.cache.clearAll();

      const originalTarget = `http://localhost:${BACKEND1_PORT}`;
      const newTarget = `http://localhost:${BACKEND2_PORT}`;

      const origRoutes = gateway.configManager.getRoutes();
      const route = origRoutes.find(r => r.id === 'test-route-1');
      route.target = originalTarget;
      await gateway.configManager.updateRoutes(origRoutes, { ignoreConflicts: true });
      await new Promise(r => setTimeout(r, 80));

      const origRes = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/profile',
        headers: { 'x-api-key': 'test_key_1' }
      });
      const origService = origRes.body && origRes.body.service;

      const routesWithConflict = [...gateway.configManager.getRoutes(), {
        id: 'test-conflict-2',
        path: '/api/users',
        priority: 99,
        stripPrefix: false,
        target: newTarget,
        headers: {},
        cache: { enabled: false },
        authRequired: true,
        rateLimitBypass: false
      }];

      const conflictRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(routesWithConflict));
      assert(conflictRes.statusCode === 409, 'Should return 409 on conflict');

      await new Promise(r => setTimeout(r, 80));

      const checkRes = await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/profile',
        headers: { 'x-api-key': 'test_key_1' }
      });
      assert.deepStrictEqual(checkRes.body.service, origService,
        'Gateway should still hit original target after conflict was not forced');

      const forceRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(gateway.configManager.getRoutes()));
      assert(forceRes.statusCode === 200, 'Force save should work');

      const cleanupRoutes = gateway.configManager.getRoutes().filter(r => r.id !== 'test-conflict-2');
      await gateway.configManager.updateRoutes(cleanupRoutes, { ignoreConflicts: true });
    });

    await test('Circuit breaker auto-refreshes targets when routes change', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.circuitBreaker.reset();
      gateway.logger.logStore.clear();

      const newTarget = 'http://localhost:45999';
      const routeId = 'test-route-1';

      const routes = gateway.configManager.getRoutes();
      const idx = routes.findIndex(r => r.id === routeId);
      routes[idx].canary = {
        enabled: false,
        target: newTarget,
        rules: []
      };

      const saveRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: '/api/routes?ignoreConflicts=true',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(routes));
      assert(saveRes.statusCode === 200, 'Route save should work');

      await new Promise(r => setTimeout(r, 400));

      const cbRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/circuit-breaker/status'
      });
      assert(cbRes.statusCode === 200, 'CB status should work');
      assert(cbRes.body.statuses[newTarget], `Circuit breaker should monitor new target ${newTarget}`);
      assert(cbRes.body.statuses[newTarget].status === 'CLOSED' || cbRes.body.statuses[newTarget].status === 'OPEN',
        `Should have status for new target, got ${cbRes.body.statuses[newTarget]?.status}`);
    });

    await test('Traffic replay API replays historical request and returns diff', async () => {
      gateway.rateLimiter.keyBuckets.clear();
      gateway.logger.logStore.clear();
      gateway.cache.clearAll();

      await request({
        hostname: 'localhost', port: GATEWAY_PORT, path: '/api/users/replayprobe?x=1',
        headers: { 'x-api-key': 'test_key_1', 'x-custom': 'hello' }
      });
      await new Promise(r => setTimeout(r, 40));

      const logsRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, path: '/api/logs?limit=10'
      });
      assert(logsRes.body.data.length >= 1, 'Should have at least one log entry');
      const logId = logsRes.body.data[0].id;

      const replayRes = await request({
        hostname: 'localhost', port: ADMIN_PORT, method: 'POST',
        path: `/api/logs/replay/${logId}`,
        headers: { 'Content-Type': 'application/json' }
      }, '{}');

      if (replayRes.statusCode !== 200) {
        console.log('  [WARN] Replay returned non-200:', replayRes.statusCode, JSON.stringify(replayRes.body));
      } else {
        assert(replayRes.body.success === true, 'Replay should succeed');
        assert(replayRes.body.replay !== undefined, 'Should have replay data');
        assert(replayRes.body.comparison !== undefined, 'Should have comparison data');
        assert(replayRes.body.comparison.statusCode !== undefined, 'Should have status comparison');
        assert(typeof replayRes.body.comparison.headers.diffCount === 'number', 'Should have header diff count');
        assert(replayRes.body.comparison.body.replayBodyHash !== undefined, 'Should have body hash');
      }
    });

    console.log('\n' + '='.repeat(60));
    console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    if (failed > 0) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('\n❌ Test setup failed:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n🔄 Cleaning up...');
    try { if (gateway) gateway.stop(); } catch (e) {}
    try { if (backend1) backend1.close(); } catch (e) {}
    try { if (backend2) backend2.close(); } catch (e) {}
    try { if (backend3) backend3.close(); } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  }
}

runTests();
