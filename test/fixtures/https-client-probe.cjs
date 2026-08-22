'use strict';
// TLS probe for test/node-shim-http-client.test.cjs. Runs unchanged under host
// node and under the node-shim loader; the JSON results must deep-equal.
// PROBE_PORT + PROBE_CA (a PEM path) arrive in the environment.
const https = require('node:https');
const fs = require('node:fs');

const PORT = Number(process.env.PROBE_PORT);
const CA = fs.readFileSync(process.env.PROBE_CA, 'utf8');
const out = {};

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

async function main() {
  // 1. verified against a caller-supplied CA, with SNI, and a request body.
  {
    out.verified = await new Promise((resolve, reject) => {
      const r = https.request({
        host: '127.0.0.1', port: PORT, path: '/secure?q=1', method: 'POST',
        agent: false, ca: CA, servername: 'localhost', headers: { 'x-probe': 'tls' },
      }, async (res) => resolve({ statusCode: res.statusCode, body: JSON.parse(await collect(res)) }));
      r.on('error', reject);
      r.end('tls-body');
    });
  }

  // 2. rejectUnauthorized: false skips verification (no CA supplied at all).
  {
    out.insecure = await new Promise((resolve, reject) => {
      const r = https.request({
        host: '127.0.0.1', port: PORT, path: '/insecure', agent: false, rejectUnauthorized: false,
      }, async (res) => resolve({ statusCode: res.statusCode, body: JSON.parse(await collect(res)) }));
      r.on('error', reject);
      r.end();
    });
  }

  // 3. an untrusted certificate must FAIL, not silently succeed. (Both engines
  //    surface a different message/code for this, so only the fact of failure
  //    and the absence of a response is compared.)
  {
    out.untrusted = await new Promise((resolve) => {
      const r = https.request({ host: '127.0.0.1', port: PORT, path: '/nope', agent: false }, () => resolve({ failed: false }));
      r.on('error', () => resolve({ failed: true }));
      r.end();
    });
  }

  // 4. https.get() and the URL form.
  {
    out.getHelper = await new Promise((resolve, reject) => {
      const r = https.get(`https://127.0.0.1:${PORT}/g`, { agent: false, ca: CA, servername: 'localhost' },
        async (res) => resolve({ statusCode: res.statusCode, body: JSON.parse(await collect(res)) }));
      r.on('error', reject);
    });
  }

  // 5. an http: URL handed to https.request is refused by name rather than
  //    silently downgraded off TLS.
  {
    try { https.request('http://127.0.0.1/x'); out.protocolGuard = 'NO THROW'; }
    catch (e) { out.protocolGuard = { code: e.code, msgHasProtocol: /http:/.test(e.message) }; }
  }

  console.log(JSON.stringify(out, null, 1));
}

main().then(() => process.exit(0), (e) => { console.error('probe failed: ' + (e && e.stack || e)); process.exit(1); });
