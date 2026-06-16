const { v4: uuidv4 } = require('uuid');
const LogStore = require('./logStore');

class LoggerMiddleware {
  constructor() {
    this.formatters = {
      json: this.jsonFormat.bind(this),
      text: this.textFormat.bind(this)
    };
    this.format = process.env.LOG_FORMAT || 'text';
    this.logStore = new LogStore(1000);
  }

  handler() {
    return (req, res, next) => {
      const startTime = Date.now();
      const start = process.hrtime.bigint();

      const originalEnd = res.end;
      res.end = (chunk, encoding, callback) => {
        const durationNs = process.hrtime.bigint() - start;
        const durationMs = Number(durationNs) / 1e6;

        const errorMessage = res.statusCode >= 400 ? (res.errorMessage || null) : null;

        const logEntry = {
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: durationMs.toFixed(3),
          caller: req.caller || 'anonymous',
          apiKey: req.apiKey ? `${req.apiKey.slice(0, 8)}...` : null,
          routeId: req.gatewayRoute?.id || null,
          target: req.gatewayRoute?.target || null,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || null,
          cacheHit: res.getHeader('X-Cache') === 'HIT',
          errorMessage,
          requestHeaders: this.sanitizeHeaders(req.headers),
          responseHeaders: this.sanitizeHeaders(res.getHeaders())
        };

        this.output(logEntry);
        this.logStore.add(logEntry);

        res.end = originalEnd;
        return res.end(chunk, encoding, callback);
      };

      next();
    };
  }

  output(entry) {
    const formatter = this.formatters[this.format] || this.formatters.text;
    const output = formatter(entry);
    console.log(output);
  }

  jsonFormat(entry) {
    return JSON.stringify(entry);
  }

  textFormat(entry) {
    const statusColor = entry.statusCode >= 500 ? '\x1b[31m' :
                        entry.statusCode >= 400 ? '\x1b[33m' :
                        entry.statusCode >= 300 ? '\x1b[36m' : '\x1b[32m';
    const resetColor = '\x1b[0m';

    const cacheIndicator = entry.cacheHit ? ' [CACHE]' : '';

    return `[${entry.timestamp}] ${entry.method} ${entry.path} ` +
           `${statusColor}${entry.statusCode}${resetColor} ` +
           `${entry.durationMs}ms ` +
           `caller=${entry.caller} ` +
           `route=${entry.routeId || '-'}${cacheIndicator}`;
  }

  sanitizeHeaders(headers) {
    const sanitized = {};
    const sensitive = ['authorization', 'x-api-key', 'cookie', 'set-cookie'];
    for (const [key, value] of Object.entries(headers)) {
      if (sensitive.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

module.exports = LoggerMiddleware;
