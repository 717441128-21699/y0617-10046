const http = require('http');
const https = require('https');
const { URL } = require('url');

class Router {
  constructor(configManager, canaryManager = null, circuitBreaker = null) {
    this.configManager = configManager;
    this.canaryManager = canaryManager;
    this.circuitBreaker = circuitBreaker;
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
    let canaryMatch = { matched: false };
    if (this.canaryManager) {
      canaryMatch = this.canaryManager.matchCanaryRule(req, route);
    }

    const finalTarget = canaryMatch.matched ? canaryMatch.target : route.target;

    if (this.canaryManager) {
      this.canaryManager.recordHit(route.id, canaryMatch.matched ? 'canary' : 'primary', canaryMatch.ruleId);
    }
    req.canaryInfo = canaryMatch;

    if (this.circuitBreaker && !this.circuitBreaker.isAvailable(finalTarget)) {
      const state = this.circuitBreaker.getStatus(finalTarget);
      const errorMsg = `Circuit breaker OPEN for ${finalTarget}. ` +
        `Next retry in ${state.nextRetryInSec}s. Last failure: ${state.lastFailureReason || 'unknown'}`;
      res.setHeader('X-Circuit-Breaker', 'OPEN');
      res.setHeader('X-Gateway-Error', errorMsg);
      res.errorMessage = errorMsg;
      return res.status(503).json({
        error: 'Service Unavailable',
        message: errorMsg,
        circuitBreaker: state
      });
    }

    const targetUrl = new URL(finalTarget);
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
      res.setHeader('X-Gateway-Target', finalTarget);
      if (canaryMatch.matched) {
        res.setHeader('X-Canary', 'HIT');
        res.setHeader('X-Canary-Rule', canaryMatch.ruleType);
      }

      if (this.circuitBreaker) {
        if (proxyRes.statusCode >= 500) {
          this.circuitBreaker.recordFailure(finalTarget, `Upstream returned ${proxyRes.statusCode}`);
        } else {
          this.circuitBreaker.recordSuccess(finalTarget);
        }
      }

      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      const errorMsg = `Upstream service timed out connecting to ${finalTarget}`;
      res.errorMessage = errorMsg;
      if (this.circuitBreaker) {
        this.circuitBreaker.recordFailure(finalTarget, 'Request timed out');
      }
      res.setHeader('X-Gateway-Error', errorMsg);
      res.setHeader('X-Gateway-Target', finalTarget);
      res.status(504).json({
        error: 'Gateway Timeout',
        message: errorMsg,
        target: finalTarget
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[Proxy] Error forwarding request:', err.message);
      const errorMsg = `Failed to connect to upstream service (${finalTarget}): ${err.message}`;
      res.errorMessage = errorMsg;
      if (this.circuitBreaker) {
        this.circuitBreaker.recordFailure(finalTarget, err.message);
      }
      if (!res.headersSent) {
        res.setHeader('X-Gateway-Error', errorMsg);
        res.setHeader('X-Gateway-Target', finalTarget);
        res.status(502).json({
          error: 'Bad Gateway',
          message: errorMsg,
          target: finalTarget
        });
      }
    });

    const contentType = (req.headers['content-type'] || '').toLowerCase();
    const hasContentLength = req.headers['content-length'] !== undefined &&
      parseInt(req.headers['content-length']) > 0;
    const hasTransferEncoding = req.headers['transfer-encoding'] !== undefined;
    const hasActualBody = hasContentLength || hasTransferEncoding;

    if (req.rawBody !== undefined && req.rawBody !== null && req.rawBody.length > 0) {
      const bodyContent = req.rawBody;
      const contentLength = Buffer.byteLength(bodyContent);
      proxyReq.setHeader('Content-Length', contentLength);
      if (contentType) {
        options.headers['content-type'] = contentType;
      }
      proxyReq.write(bodyContent);
      proxyReq.end();
    } else if (req.body !== undefined && req.body !== null &&
      !(typeof req.body === 'object' && Object.keys(req.body).length === 0)) {
      let bodyContent;
      if (Buffer.isBuffer(req.body)) {
        bodyContent = req.body;
      } else if (typeof req.body === 'object') {
        if (contentType.includes('application/x-www-form-urlencoded')) {
          bodyContent = new URLSearchParams(req.body).toString();
        } else {
          bodyContent = JSON.stringify(req.body);
          options.headers['content-type'] = 'application/json';
        }
      } else {
        bodyContent = String(req.body);
      }
      const contentLength = Buffer.byteLength(bodyContent);
      proxyReq.setHeader('Content-Length', contentLength);
      proxyReq.write(bodyContent);
      proxyReq.end();
    } else if (hasActualBody) {
      if (contentType) {
        options.headers['content-type'] = contentType;
      }
      proxyReq.setHeader('Transfer-Encoding', 'chunked');
      req.pipe(proxyReq);
    } else {
      proxyReq.setHeader('Content-Length', '0');
      proxyReq.end();
    }
  }

  close() {
    for (const agent of this.agents.values()) {
      agent.destroy();
    }
    this.agents.clear();
  }
}

module.exports = Router;
