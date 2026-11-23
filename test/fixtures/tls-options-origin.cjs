'use strict';
// The TLS servers test/node-shim-tls-options.test.cjs's probe talks to, one per certificate shape (always host node:
// the oracle's fixed point). argv[2]: the JSON testPki() returned (test/self-signed-cert.cjs). Prints
// `PORTS {"leaf":n,...}` once every server listens. Each answers JSON naming the path and the client certificate's CN.
const https = require('node:https');
const fs = require('node:fs');

const pki = JSON.parse(process.argv[2]);
const read = (p) => fs.readFileSync(p, 'utf8');
const handler = (req, res) => {
  const peer = req.socket.getPeerCertificate && req.socket.getPeerCertificate();
  const body = JSON.stringify({ url: req.url, client: (peer && peer.subject && peer.subject.CN) || null });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const shapes = {
  leaf: { cert: read(pki.leaf.cert), key: read(pki.leaf.key) },                                       // leaf only
  withRoot: { cert: read(pki.leaf.cert) + read(pki.ca.cert), key: read(pki.leaf.key) },               // leaf + its root
  viaInter: { cert: read(pki.leafInter.cert) + read(pki.inter.cert), key: read(pki.leafInter.key) },  // leaf + intermediate
  selfSigned: { cert: read(pki.selfLeaf.cert), key: read(pki.selfLeaf.key) },
  mtls: { cert: read(pki.leaf.cert), key: read(pki.leaf.key), ca: read(pki.ca.cert), requestCert: true, rejectUnauthorized: true },
};
if (pki.expired) shapes.expired = { cert: read(pki.expired.cert), key: read(pki.expired.key) };

const ports = {};
let pending = Object.keys(shapes).length;
for (const [name, opts] of Object.entries(shapes)) {
  const server = https.createServer(opts, handler);
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1', () => {
    ports[name] = server.address().port;
    if (--pending === 0) process.stdout.write(`PORTS ${JSON.stringify(ports)}\n`);
  });
}
