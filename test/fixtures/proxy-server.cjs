'use strict';
// A real HTTP proxy — forward proxy for absolute-form requests, CONNECT tunnel
// for TLS — that RECORDS WHAT ARRIVED. It exists because a client-side check
// cannot tell "went through the proxy" from "went direct and got lucky": the
// only honest evidence is the request the proxy itself saw.
//
// Dependency-free on purpose (the house rule the MCP ws mock follows too): the
// thing being measured must not be measured through a dependency of the thing.
//
//   PROXY_LOG        path to append one JSON line per arrival (required)
//   PROXY_TLS_CERT   PEM cert -> the proxy itself listens with TLS (https://
//   PROXY_TLS_KEY    PEM key      proxy URL); plain HTTP without them
//   PROXY_REFUSE     '1' -> answer 403 instead of forwarding (a proxy that
//                    denies, so a test can prove the client did not fall back)
//
// Prints `PORT <n>` on stdout once listening, like the other origin fixtures.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');

const LOG = process.env.PROXY_LOG;
if (!LOG) { process.stderr.write('proxy-server: PROXY_LOG is required\n'); process.exit(2); }
const REFUSE = process.env.PROXY_REFUSE === '1';

function record(entry) {
  fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

// rawHeaders keeps the case and order the client actually sent — lower-cased
// req.headers would hide exactly the kind of divergence this file is for.
function rawHeaderLines(req) {
  const out = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) out.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  return out;
}

function onRequest(req, res) {
  record({
    at: 'proxy',
    startLine: `${req.method} ${req.url} HTTP/${req.httpVersion}`,
    headers: rawHeaderLines(req),
  });
  if (REFUSE) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('proxy refused'); return; }
  let u;
  try { u = new URL(req.url); } catch {
    // Origin-form at a proxy is a client bug — say so on the wire, loudly, so a
    // test that expected absolute-form sees the failure instead of a 200.
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`proxy: expected an absolute-form request target, got ${req.url}`);
    return;
  }
  const fwd = http.request({
    host: u.hostname,
    port: u.port || 80,
    path: `${u.pathname}${u.search}`,
    method: req.method,
    headers: req.headers,
  }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  fwd.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`proxy upstream error: ${e.message}`); });
  req.pipe(fwd);
}

function onConnect(req, sock, head) {
  record({ at: 'proxy', startLine: `CONNECT ${req.url} HTTP/${req.httpVersion}`, headers: rawHeaderLines(req) });
  if (REFUSE) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const i = req.url.lastIndexOf(':');
  const host = req.url.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(req.url.slice(i + 1));
  const up = net.connect(port, host, () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
}

const cert = process.env.PROXY_TLS_CERT;
const key = process.env.PROXY_TLS_KEY;
const server = cert && key
  ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, onRequest)
  : http.createServer(onRequest);
server.on('connect', onConnect);
server.on('clientError', (e, sock) => { record({ at: 'proxy', error: String(e && e.message) }); sock.destroy(); });
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
