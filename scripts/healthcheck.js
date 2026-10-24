const http = require('node:http');

const request = http.get({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/healthz', timeout: 3000 }, response => {
  response.resume();
  if (response.statusCode !== 200) process.exitCode = 1;
});
request.on('timeout', () => request.destroy(new Error('Healthcheck timeout')));
request.on('error', () => { process.exitCode = 1; });
