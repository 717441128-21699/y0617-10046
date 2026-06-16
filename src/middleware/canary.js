const crypto = require('crypto');

class CanaryManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.stats = new Map();

    this.configManager.on('config:updated', () => {
      this.cleanupStats();
    });
  }

  cleanupStats() {
    const validRouteIds = new Set(this.configManager.getRoutes().map(r => r.id));
    for (const routeId of this.stats.keys()) {
      if (!validRouteIds.has(routeId)) {
        this.stats.delete(routeId);
      }
    }
  }

  getRouteStats(routeId) {
    if (!this.stats.has(routeId)) {
      this.stats.set(routeId, {
        totalRequests: 0,
        primaryHits: 0,
        canaryHits: 0,
        canaryRuleHits: new Map()
      });
    }
    return this.stats.get(routeId);
  }

  recordHit(routeId, target, ruleId = null) {
    const stats = this.getRouteStats(routeId);
    stats.totalRequests++;
    if (target === 'canary') {
      stats.canaryHits++;
      if (ruleId) {
        stats.canaryRuleHits.set(ruleId, (stats.canaryRuleHits.get(ruleId) || 0) + 1);
      }
    } else {
      stats.primaryHits++;
    }
  }

  matchCanaryRule(req, route) {
    if (!route.canary || !route.canary.enabled) {
      return { matched: false };
    }

    const rules = route.canary.rules || [];
    for (const rule of rules) {
      const result = this.evaluateRule(rule, req, route);
      if (result.matched) {
        return result;
      }
    }

    return { matched: false };
  }

  evaluateRule(rule, req, route) {
    switch (rule.type) {
      case 'caller':
        if (req.caller && rule.callers && rule.callers.includes(req.caller)) {
          return {
            matched: true,
            ruleId: rule.id,
            target: route.canary.target,
            headers: rule.headers,
            ruleType: 'caller'
          };
        }
        break;

      case 'header':
        if (rule.headerName) {
          const headerValue = req.headers[rule.headerName.toLowerCase()];
          if (headerValue !== undefined) {
            if (rule.headerValue === undefined ||
                rule.headerValue === '*' ||
                headerValue === rule.headerValue ||
                (rule.headerRegex && new RegExp(rule.headerRegex).test(headerValue))) {
              return {
                matched: true,
                ruleId: rule.id,
                target: route.canary.target,
                headers: rule.headers,
                ruleType: 'header'
              };
            }
          }
        }
        break;

      case 'weight':
        if (rule.weight !== undefined) {
          const weight = Math.max(0, Math.min(100, rule.weight));
          const hash = this.computeConsistentHash(req, route);
          const percentile = (hash % 10000) / 100;
          if (percentile < weight) {
            return {
              matched: true,
              ruleId: rule.id,
              target: route.canary.target,
              headers: rule.headers,
              ruleType: 'weight',
              weightPercentile: percentile.toFixed(2)
            };
          }
        }
        break;
    }

    return { matched: false };
  }

  computeConsistentHash(req, route) {
    const identifier = req.caller ||
      req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.ip ||
      req.headers['user-agent'] ||
      req.apiKey ||
      'anonymous';

    return crypto
      .createHash('md5')
      .update(`${route.id}:${identifier}`)
      .digest()
      .readUInt32BE(0);
  }

  getAllStats() {
    const result = {};
    for (const [routeId, stats] of this.stats) {
      const ruleBreakdown = {};
      for (const [ruleId, count] of stats.canaryRuleHits) {
        ruleBreakdown[ruleId] = count;
      }
      result[routeId] = {
        totalRequests: stats.totalRequests,
        primaryHits: stats.primaryHits,
        canaryHits: stats.canaryHits,
        canaryPercentage: stats.totalRequests > 0
          ? ((stats.canaryHits / stats.totalRequests) * 100).toFixed(2)
          : '0.00',
        ruleBreakdown
      };
    }
    return result;
  }

  resetStats(routeId = null) {
    if (routeId) {
      this.stats.delete(routeId);
    } else {
      this.stats.clear();
    }
  }
}

module.exports = CanaryManager;
