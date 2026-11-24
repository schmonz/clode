'use strict';
// The origins test/connect-family.test.cjs reaches by the name `localhost` (which resolves to ::1 AND 127.0.0.1 on the
// hosts it runs on), run by HOST node, the fixed point. Every origin answers with the family of the address it listens
// on, so a client's answer says which address it reached, not only that it reached one:
//   v4    listens on 127.0.0.1 only (nothing on [::1] at that port)
//   v6    listens on ::1 only (nothing on 127.0.0.1 at that port)
//   dual  one server on 127.0.0.1 and one on ::1 at the SAME port: which one answers is the client's first choice
// each as plain http (with a WebSocket upgrade) and as https (a leaf for DNS:localhost of the CA the caller holds,
// cert and key at argv[2], argv[3]).
//   any request      200, JSON { fam: 'v4' | 'v6' }
//   WebSocket        the handshake, then one text message, the same JSON, then a close
// net.connect / tls.connect rows send a request line and read the same JSON back.
// Prints one line `PORTS {"v4":{"http":n,"https":n},"v6":{...},"dual":{...}}` once every server listens.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const [, , certPath, keyPath] = process.argv;
const TLS = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
const HOST = { v4: '127.0.0.1', v6: '::1' };

function serve(kind, fam) {
  const body = JSON.stringify({ fam });
  const onReq = (req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(body); });
  };
  const s = kind === 'https' ? https.createServer(TLS, onReq) : http.createServer(onReq);
  s.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const msg = Buffer.from(body);
    sock.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    setTimeout(() => { sock.write(Buffer.from([0x88, 2, 0x03, 0xe8])); sock.end(); }, 100);
    sock.on('error', () => {});
  });
  s.on('clientError', (_e, sock) => sock.destroy());
  s.keepAliveTimeout = 200;
  return s;
}
const listen = (s, host, port) => new Promise((resolve, reject) => {
  s.once('error', reject);
  s.listen(port, host, () => { s.removeListener('error', reject); resolve(s.address().port); });
});
// a port nobody holds on the OTHER family's loopback: bind it and let it go (a bind that succeeds is a free port)
const freeOn = (host, port) => new Promise((resolve) => {
  const t = net.createServer();
  t.once('error', () => resolve(false));
  t.listen(port, host, () => t.close(() => resolve(true)));
});

async function one(kind, fam) {
  for (let i = 0; i < 50; i++) {
    const s = serve(kind, fam);
    const port = await listen(s, HOST[fam], 0);
    if (await freeOn(HOST[fam === 'v4' ? 'v6' : 'v4'], port)) return port;
    s.close();
  }
  throw new Error(`no port free on the other loopback for ${kind} ${fam}`);
}
async function dual(kind) {
  for (let i = 0; i < 50; i++) {
    const a = serve(kind, 'v4');
    const port = await listen(a, HOST.v4, 0);
    try { await listen(serve(kind, 'v6'), HOST.v6, port); return port; } catch (_) { a.close(); }
  }
  throw new Error(`no port free on both loopbacks for ${kind} dual`);
}
(async () => {
  const P = {};
  for (const fam of ['v4', 'v6']) P[fam] = { http: await one('http', fam), https: await one('https', fam) };
  P.dual = { http: await dual('http'), https: await dual('https') };
  process.stdout.write(`PORTS ${JSON.stringify(P)}\n`);
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
