class AuthMiddleware {
  constructor(configManager) {
    this.configManager = configManager;
  }

  handler() {
    return (req, res, next) => {
      const route = req.gatewayRoute;
      if (!route || !route.authRequired) {
        return next();
      }

      const apiKey = this.extractApiKey(req);
      if (!apiKey) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'API Key is required'
        });
      }

      const keyConfig = this.configManager.getApiKey(apiKey);
      if (!keyConfig) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid API Key'
        });
      }

      if (keyConfig.revoked) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'API Key has been revoked'
        });
      }

      req.apiKey = apiKey;
      req.caller = keyConfig.caller;
      req.keyConfig = keyConfig;
      next();
    };
  }

  extractApiKey(req) {
    const header = req.headers['x-api-key'];
    if (header) {
      return header;
    }

    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    if (req.query && req.query.api_key) {
      return req.query.api_key;
    }

    return null;
  }
}

module.exports = AuthMiddleware;
