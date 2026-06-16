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
    req.on('error', reject);
    if (body) req.write(body);
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
    const AdminServer = require('../src/admin');

    const configManager = new ConfigManager(testConfigPath);
    gateway = {
      configManager,
      router: new Router(configManager),
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
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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
        this.admin = new AdminServer(this.configManager, this.cache, this.rateLimiter);
        this.admin.start();
      },
      stop() {
        if (this.server) this.server.close();
        if (this.admin) this.admin.stop();
        this.router.close();
        this.rateLimiter.close();
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
