'use strict';
// TLS half of test/node-shim-http-client.test.cjs's origin. A stock node
// https server (the plaintext oddities are covered by http-client-origin.cjs;
// what matters here is only that the handshake, SNI and CA verification behave
// the same under both engines). Cert/key paths arrive in argv.
const https = require('node:https');
const fs = require('node:fs');

const [, , certPath, keyPath] = process.argv;
const server = https.createServer(
  { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
  (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const payload = JSON.stringify({
        method: req.method,
        url: req.url,
        probe: req.headers['x-probe'] || null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
server.listen(0, '127.0.0.1', () => { process.stdout.write(`PORT ${server.address().port}\n`); });
