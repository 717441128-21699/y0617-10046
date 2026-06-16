class RateLimitMiddleware {
  constructor(configManager) {
    this.configManager = configManager;
    this.keyBuckets = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  handler() {
    return (req, res, next) => {
      const route = req.gatewayRoute;
      if (!route || route.rateLimitBypass) {
        return next();
      }

      const identifier = req.apiKey || req.ip;
      const result = this.checkLimit(identifier, req.keyConfig);

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          retryAfter
        });
      }

      next();
    };
  }

  checkLimit(identifier, keyConfig) {
    const rateLimit = keyConfig?.rateLimit || this.configManager.getDefaultRateLimit();
    const { requests, windowMs } = rateLimit;

    const now = Date.now();
    let bucket = this.keyBuckets.get(identifier);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = {
        windowStart: now,
        count: 0
      };
      this.keyBuckets.set(identifier, bucket);
    }

    bucket.count++;

    const resetTime = bucket.windowStart + windowMs;
    const remaining = Math.max(0, requests - bucket.count);

    return {
      allowed: bucket.count <= requests,
      limit: requests,
      remaining,
      resetTime
    };
  }

  cleanup() {
    const now = Date.now();
    const maxWindowMs = 24 * 60 * 60 * 1000;
    for (const [key, bucket] of this.keyBuckets) {
      if (now - bucket.windowStart >= maxWindowMs) {
        this.keyBuckets.delete(key);
      }
    }
  }

  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = RateLimitMiddleware;
