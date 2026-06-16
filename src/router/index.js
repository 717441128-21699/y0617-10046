const http = require('http');
const https = require('https');
const { URL } = require('url');

class Router {
  constructor(configManager) {
    this.configManager = configManager;
    this.agents = new Map();
    this.pathRewriter = this.pathRewriter.bind(this);
  }

  getAgent(target) {
    if (!this.agents.has(target)) {
      const url = new URL(target);
      const options = {
        keepAlive: true,
        maxSockets: 100,
        timeout: 30000
      };
      const agent = url.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
      this.agents.set(target, agent);
    }
    return this.agents.get(target);
  }

  pathRewriter(path, route) {
    if (route.stripPrefix) {
      const prefix = route.path;
      if (path.startsWith(prefix)) {
        const rewritten = path.slice(prefix.length) || '/';
        return rewritten;
      }
    }
    return path;
  }

  routeMatcher(req, res, next) {
    const route = this.configManager.matchRoute(req.path);
    req.gatewayRoute = route;
    next();
  }

  proxyHandler() {
    return (req, res, next) => {
      const route = req.gatewayRoute;
      if (!route) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'No route matched for this path'
        });
      }

      this.proxyRequest(req, res, route);
    };
  }

  proxyRequest(req, res, route) {
    const targetUrl = new URL(route.target);
    const rewrittenPath = this.pathRewriter(req.path, route);
    const queryString = req.url.split('?')[1];
    const targetPath = queryString ? `${rewrittenPath}?${queryString}` : rewrittenPath;

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      protocol: targetUrl.protocol,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers },
      agent: this.getAgent(route.target),
      timeout: 30000
    };

    delete options.headers['content-length'];
    delete options.headers['connection'];
    options.headers['connection'] = 'keep-alive';
    options.headers['host'] = targetUrl.host;

    if (route.headers) {
      for (const [key, value] of Object.entries(route.headers)) {
        options.headers[key] = value;
      }
    }

    if (req.caller) {
      options.headers['X-Gateway-Caller'] = req.caller;
    }

    const protocol = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = protocol.request(options, (proxyRes) => {
      res.statusCode = proxyRes.statusCode;
      res.statusMessage = proxyRes.statusMessage;

      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (key.toLowerCase() !== 'transfer-encoding') {
          res.setHeader(key, value);
        }
      }

      res.setHeader('X-Gateway-Processed', 'true');
      res.setHeader('X-Gateway-Route', route.id);

      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.status(504).json({
        error: 'Gateway Timeout',
        message: 'Upstream service timed out'
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[Proxy] Error forwarding request:', err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Bad Gateway',
          message: `Failed to connect to upstream service: ${err.message}`
        });
      }
    });

    req.pipe(proxyReq);
  }

  close() {
    for (const agent of this.agents.values()) {
      agent.destroy();
    }
    this.agents.clear();
  }
}

module.exports = Router;
