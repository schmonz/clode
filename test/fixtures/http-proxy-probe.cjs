'use strict';
// One proxy behaviour per run, printed as JSON, so the SAME script can be run
// under host node (the oracle) and under tjs via the node-shim loader and the
// two answers compared. The proxy env vars come from the environment the test
// builds; PROBE_CASE picks the behaviour.
//
// The client's own report is deliberately thin: what matters is what arrived at
// the proxy (test/fixtures/proxy-server.cjs records that), and this side only
// has to agree about "did it work / how did it fail".
const http = require('node:http');
const https = require('node:https');

const CASE = process.env.PROBE_CASE;
const ORIGIN = process.env.PROBE_ORIGIN;      // port of the http origin
const out = { case: CASE };

function done() {
  process.stdout.write(`${JSON.stringify(out)}\n`);
  // The shim's client holds no pooled sockets and node's global agent may; be
  // explicit so neither engine's exit timing depends on that.
  process.exit(0);
}

function collect(req) {
  req.on('response', (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      out.status = res.statusCode;
      // /echo answers with what the ORIGIN saw; a proxied request reaches it in
      // origin-form (the proxy re-writes), so this proves end-to-end delivery.
      try { out.originStartLine = JSON.parse(body).startLine; } catch { out.body = body.slice(0, 200); }
      done();
    });
  });
  req.on('error', (e) => { out.error = { code: e.code, name: e.name }; done(); });
  req.end();
}

function guard(fn) {
  try { fn(); } catch (e) { out.threw = { code: e.code, message: String(e.message).slice(0, 400) }; done(); }
}

switch (CASE) {
  // Plain http through the proxy — the base case, and the one that used to go
  // direct under quaude with no notice at all.
  case 'plain':
  case 'creds':
  case 'noproxy':
  case 'disabled':
  case 'socks':
  case 'deadproxy':
  case 'refused':
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`)));
    break;

  // An https:// PROXY (TLS to the proxy itself, plain http to the origin
  // through it). The proxy's certificate has to be trusted: under host node
  // that is NODE_EXTRA_CA_CERTS, under the shim the caller's `ca` — the engine
  // exposes no env for a client socket's trust store (measured: neither
  // SSL_CERT_FILE nor TJS_CA_BUNDLE reaches tjs.connect('tls', ...)).
  case 'tls-proxy':
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`, {
      ca: require('node:fs').readFileSync(process.env.PROBE_CA, 'utf8'),
    })));
    break;

  // node applies the proxy env to the GLOBAL agent only.
  case 'global-agent':
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`, { agent: http.globalAgent })));
    break;
  case 'custom-agent':
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`, { agent: new http.Agent() })));
    break;
  case 'agent-false':
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`, { agent: false })));
    break;

  // An https ORIGIN through a proxy needs a CONNECT tunnel with TLS started on
  // the tunnelled socket. Host node does it; the shim cannot, and refuses by
  // name rather than connecting direct. The host is deliberately unresolvable
  // (RFC 6761 .invalid): if anything tries to connect DIRECTLY it fails with a
  // DNS error that is unmistakable in the result, and nothing leaves the box.
  case 'https-origin':
    guard(() => collect(https.request('https://nowhere.example.invalid/echo')));
    break;

  // A proxy AGENT: the caller explicitly asking for a proxy. The shim runs no
  // agents, so before this it was ignored silently.
  case 'agent-proxy': {
    const agent = new http.Agent();
    agent.proxy = new URL(`http://127.0.0.1:${process.env.PROBE_PROXY}`);
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`, { agent })));
    break;
  }
  case 'agent-proxy-socks': {
    const agent = new http.Agent();
    agent.proxy = { host: '127.0.0.1', port: 1080, type: 5 };   // socks-proxy-agent's shape
    guard(() => collect(http.request(`http://127.0.0.1:${ORIGIN}/echo`, { agent })));
    break;
  }

  default:
    out.error = { code: 'BAD_CASE' };
    done();
}
