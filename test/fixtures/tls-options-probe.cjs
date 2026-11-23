'use strict';
// TLS verification and client-certificate probe for test/node-shim-tls-options.test.cjs. Runs unchanged under host
// node (the oracle) and under the node-shim loader; PROBE_PKI (testPki()'s JSON) and PROBE_PORTS (the origin's JSON)
// arrive in the environment. Each row is { status, body } for a response, { threw: code } for a synchronous throw
// from https.request, or { error: code, message } for an 'error' event.
const https = require('node:https');
const fs = require('node:fs');

const pki = JSON.parse(process.env.PROBE_PKI);
const ports = JSON.parse(process.env.PROBE_PORTS);
const pem = (p) => fs.readFileSync(p, 'utf8');
const CA = pem(pki.ca.cert);
const CA2 = pem(pki.ca2.cert);
const out = {};

function row(label, opts) {
  return new Promise((resolve) => {
    const done = (v) => { out[label] = v; resolve(); };
    let req;
    try {
      req = https.request({ host: '127.0.0.1', path: `/${label}`, agent: false, ...opts }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
    } catch (e) { done({ threw: e.code }); return; }
    req.on('error', (e) => done({ error: e.code, message: e.message }));
    req.end();
  });
}

async function main() {
  const leaf = { port: ports.leaf };
  // trust: the caller's ca REPLACES the default roots
  await row('trusted', { ...leaf, ca: CA, servername: 'localhost' });
  await row('trustedByIp', { ...leaf, ca: CA });
  await row('trustedCaArray', { ...leaf, ca: [CA2, CA] });
  await row('trustedCaBuffer', { ...leaf, ca: Buffer.from(CA) });
  await row('notInCa', { ...leaf, ca: CA2 });
  await row('notInCaArray', { ...leaf, ca: [CA2] });
  await row('noCa', { ...leaf });
  await row('agentNotInCa', { ...leaf, agent: new https.Agent({ ca: CA2 }) });
  await row('agentTrusted', { ...leaf, agent: new https.Agent({ ca: CA }) });
  await row('requestCaOverAgent', { ...leaf, ca: CA2, agent: new https.Agent({ ca: CA }) });
  // rejectUnauthorized: false skips verification, whatever the ca
  await row('insecure', { ...leaf, rejectUnauthorized: false });
  await row('insecureNotInCa', { ...leaf, ca: CA2, rejectUnauthorized: false });
  // the name the certificate is checked against
  await row('altnameMismatch', { ...leaf, ca: CA, servername: 'other.example' });
  // what node's code says about the chain the server sent
  await row('chainWithUntrustedRoot', { port: ports.withRoot, ca: CA2 });
  await row('chainViaIntermediate', { port: ports.viaInter, ca: CA });
  await row('chainIntermediateNoRoot', { port: ports.viaInter, ca: CA2 });
  await row('selfSigned', { port: ports.selfSigned, ca: CA });
  if (ports.expired) await row('expired', { port: ports.expired, ca: CA });
  // mTLS: the client certificate is presented, in every shape node takes it
  const cert = pem(pki.client.cert); const key = pem(pki.client.key);
  await row('mtlsCert', { port: ports.mtls, ca: CA, cert, key });
  await row('mtlsAgent', { port: ports.mtls, agent: new https.Agent({ ca: CA, cert, key }) });
  await row('mtlsArrays', { port: ports.mtls, ca: [CA], cert: [cert], key: [key] });
  await row('mtlsBuffers', { port: ports.mtls, ca: CA, cert: Buffer.from(cert), key: Buffer.from(key) });
  await row('mtlsKeyObject', { port: ports.mtls, ca: CA, cert, key: [{ pem: key }] });
  // a certificate or key that cannot be used is refused before any connection, as node's createSecureContext does
  await row('garbageCert', { port: ports.mtls, ca: CA, cert: 'not a certificate', key });
  await row('garbageKey', { port: ports.mtls, ca: CA, cert, key: 'not a key' });
  console.log(JSON.stringify(out, null, 1));
}

main().then(() => process.exit(0), (e) => { console.error('probe failed: ' + (e && e.stack || e)); process.exit(1); });
