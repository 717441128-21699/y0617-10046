const http = require('http');

function createBackend(port, name) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Backend', name);

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let receivedBody = null;
      let rawBody = null;

      if (chunks.length > 0) {
        rawBody = Buffer.concat(chunks).toString();
        try {
          const contentType = req.headers['content-type'] || '';
          if (contentType.includes('application/json')) {
            receivedBody = JSON.parse(rawBody);
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(rawBody);
            receivedBody = Object.fromEntries(params.entries());
          } else {
            receivedBody = rawBody;
          }
        } catch (e) {
          receivedBody = rawBody;
        }
      }

      const data = {
        backend: name,
        receivedPath: req.url,
        receivedMethod: req.method,
        receivedHeaders: req.headers,
        receivedBody,
        rawBody,
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
      } else if (req.url.startsWith('/echo')) {
        res.statusCode = 200;
        res.end(JSON.stringify({
          status: 'ok',
          method: req.method,
          body: receivedBody,
          rawBody,
          contentType: req.headers['content-type']
        }));
      } else {
        res.statusCode = 200;
        res.end(JSON.stringify(data));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[Mock Backend] ${name} running on port ${port}`);
      resolve(server);
    });
  });
}

module.exports = { createBackend };
