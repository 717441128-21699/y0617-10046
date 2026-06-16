const express = require('express');
const ConfigManager = require('./config');
const Router = require('./router');
const AuthMiddleware = require('./middleware/auth');
const RateLimitMiddleware = require('./middleware/rateLimit');
const LoggerMiddleware = require('./middleware/logger');
const CacheMiddleware = require('./middleware/cache');
const AdminServer = require('./admin');

class Gateway {
  constructor() {
    this.configManager = new ConfigManager();
    this.router = new Router(this.configManager);
    this.auth = new AuthMiddleware(this.configManager);
    this.rateLimiter = new RateLimitMiddleware(this.configManager);
    this.logger = new LoggerMiddleware();
    this.cache = new CacheMiddleware(this.configManager);
    this.admin = new AdminServer(this.configManager, this.cache, this.rateLimiter, this.logger, this);

    this.app = express();
    this.server = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.disable('x-powered-by');
    this.app.set('trust proxy', true);

    const rawBodySaver = (req, res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
      }
    };

    this.app.use(express.json({
      limit: '10mb',
      verify: rawBodySaver
    }));
    this.app.use(express.urlencoded({
      extended: true,
      limit: '10mb',
      verify: rawBodySaver
    }));

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
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    this.app.all('*', this.router.proxyHandler());

    this.app.use((err, req, res, next) => {
      console.error('[Gateway] Error:', err.message);
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message
      });
    });
  }

  start() {
    const port = this.configManager.getServerPort();
    this.server = this.app.listen(port, () => {
      console.log(`[Gateway] API Gateway started on port ${port}`);
      console.log(`[Gateway] Admin interface on port ${this.configManager.getAdminPort()}`);
    });

    this.admin.start();

    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  stop() {
    console.log('[Gateway] Shutting down gracefully...');

    if (this.server) {
      this.server.close(() => {
        console.log('[Gateway] HTTP server closed');
      });
    }

    this.admin.stop();
    this.router.close();
    this.rateLimiter.close();
    this.configManager.close();

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
}

if (require.main === module) {
  const gateway = new Gateway();
  gateway.start();
}

module.exports = Gateway;
