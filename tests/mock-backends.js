const http = require('http');

function createBackend(port, name) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Backend', name);
    const data = {
      backend: name,
      receivedPath: req.url,
      receivedMethod: req.method,
      receivedHeaders: req.headers,
      timestamp: new Date().toISOString(),
      echo: {
        query: req.url.split('?')[1] || '',
        path: req.url.split('?')[0]
      }
    };

    if (req.url === '/slow') {
      setTimeout(() => {
        res.statusCode = 200;
        res.end(JSON.stringify({ ...data, message: 'slow response' }));
      }, 500);
    } else if (req.url.startsWith('/error')) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ...data, error: 'simulated error' }));
    } else {
      res.statusCode = 200;
      res.end(JSON.stringify(data));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[Mock Backend] ${name} running on port ${port}`);
      resolve(server);
    });
  });
}

module.exports = { createBackend };
