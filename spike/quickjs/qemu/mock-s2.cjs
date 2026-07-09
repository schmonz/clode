'use strict';
// mock-s2.cjs — host-side mock Anthropic Messages endpoint for the sparc S5
// gate (mock PONG). Reuses test/mock-anthropic-helper.cjs's canned SSE but on
// a FIXED loopback port (the helper binds an ephemeral 49xxx port, which this
// campaign must not touch; 8183 is inside our 818x allotment). The qemu guest
// reaches it as http://10.0.2.2:8183. Requests are appended (JSON lines) to
// vendor/sparc-s2-mock.log as host-side evidence for the S5 verdict.
// Writes vendor/dist/s2-ports.env after binding. Phase-1 tooling, uncommitted.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..'); // repo root
const { cannedSSE } = require(path.join(REPO, 'test', 'mock-anthropic-helper.cjs'));
const QJS = path.resolve(__dirname, '..');              // spike/quickjs
const LOG = path.join(QJS, 'vendor', 'sparc-s2-mock.log');
const PORTSENV = path.join(QJS, 'vendor', 'dist', 's2-ports.env');
const PORT = 8183;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    fs.appendFileSync(LOG, JSON.stringify({
      t: new Date().toISOString(), method: req.method, url: req.url, body,
    }) + '\n');
    if (req.method === 'POST' && /\/messages$/.test(req.url.split('?')[0])) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(cannedSSE('PONG'));
      return;
    }
    // Benign answer for any preflight/config probe so a boot never walls here.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(PORTSENV, `PORT_A=${PORT}\n`);
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), listening: PORT }) + '\n');
  console.log('mock-s2 listening on 127.0.0.1:%d; ports env at %s', PORT, PORTSENV);
});
