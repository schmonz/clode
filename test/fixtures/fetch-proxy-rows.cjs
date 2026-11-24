'use strict';
// THE PROXY ROWS (test/fetch-proxy.test.cjs): what Bun's fetch and WebSocket DO with a proxy, observed from both ends:
// what the caller got (a status, or an error's name/code/message, or a WebSocket's events) and what arrived AT the
// proxy (test/fixtures/proxy-server.cjs records every request line and its proxy headers). A client-side answer alone
// cannot tell "through the proxy" from "direct"; the proxy's log can.
//
// Native Bun's answers are RECORDED (test/fixtures/fetch-proxy-native.json): run inside native Claude Code's Bun as a
// preload, with the servers fetch-proxy.test.cjs starts (re-record: FETCH_PROXY_RECORD=<native claude> node
// test/run.mjs test/fetch-proxy.test.cjs, which rewrites the fixture). The test runs this same file under the tjs
// loader with bun-shim loaded, against fresh servers, and compares. Every fetch says keepalive: false: native Bun pools
// connections (a direct one, or a tunnel) and a pooled one would be reused by the next row without reaching the proxy.
//
// PROXY_ROWS (env): { log, http, https, open, auth, dead, ca } — the proxy's log file, the ports of the http origin
// (test/fixtures/options-census-origin.cjs), the https origin (test/fixtures/https-client-origin.cjs, a leaf of the
// test CA at `ca`), an open proxy, a proxy that wants Basic u:p, and a port nothing listens on.
const fs = require('fs');

const P = JSON.parse(process.env.PROXY_ROWS);
const CA = fs.readFileSync(P.ca, 'utf8');
// the engine's default trust is the test CA, so tls.ca: [CA] is that set (bun-shim honours a ca equal to it; native
// Bun's fetch reads tls.ca per request and ignores the default)
require('tls').setDefaultCACertificates([CA]);
const TLS = { tls: { ca: [CA] } };

let seen = 0;
// what reached the proxy since the last row: the request line, its Host, and the headers that are about the proxy
// (every Proxy-* and X-Proxy-* header) in the order sent. Where Host falls among them is not compared: it is the
// request's own header, and the engine writes it before any other.
function arrivals() {
  const all = fs.readFileSync(P.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fresh = all.slice(seen); seen = all.length;
  return fresh.map((e) => {
    const h = e.headers || [];
    return { line: e.startLine || null, host: h.filter((x) => /^host:/i.test(x)), proxy: h.filter((x) => /^(proxy-[^:]*|x-proxy-[^:]*):/i.test(x)) };
  });
}
const ENV = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const env = (vars) => { for (const k of ENV) delete process.env[k]; Object.assign(process.env, vars || {}); };
const errOf = (e) => ({ error: { name: e && e.name, code: (e && e.code) || null, message: e && e.message } });
async function fetchRow(url, init, vars) {
  env(vars);
  let out;
  try {
    const r = await fetch(url, { keepalive: false, ...init });
    const text = await r.text();
    let origin = null;
    try { const j = JSON.parse(text); origin = { method: j.method, url: j.url }; } catch (_) { origin = text.slice(0, 40); }
    out = { status: r.status, origin };
  } catch (e) { out = errOf(e); }
  env({});
  return { ...out, arrivals: arrivals() };
}
// for no_proxy: did the request reach the proxy? The target's host does not resolve, so "bypassed" fails in DNS (whose
// error text is the engine's own, not compared) and "proxied" is answered by the proxy (502)
async function reached(url, init, vars) {
  env(vars);
  try { const r = await fetch(url, { keepalive: false, ...init }); await r.text(); } catch (_) { /* bypassed: no DNS */ }
  env({});
  return { reached: arrivals().length > 0 };
}
function wsRow(url, opts, vars) {
  env(vars);
  return new Promise((resolve) => {
    const ev = [];
    const done = () => { env({}); resolve({ events: ev, arrivals: arrivals() }); };
    let w;
    try { w = new WebSocket(url, opts); } catch (e) { ev.push(`throw ${e.name}: ${e.message}`); done(); return; }
    const timer = setTimeout(() => { ev.push('timeout'); done(); }, 5000);
    w.onopen = () => ev.push('open');
    w.onmessage = (m) => { let h = null; try { h = JSON.parse(String(m.data)).headers; } catch (_) { /* not ours */ } ev.push(`message${h ? ' from the origin' : ''}`); };
    w.onerror = (e) => ev.push(`error: ${e && e.message}`);
    w.onclose = (c) => { clearTimeout(timer); ev.push(`close ${c.code}`); done(); };
  });
}

const H = `http://127.0.0.1:${P.http}/echo?q=1`;
const S = `https://127.0.0.1:${P.https}/x`;
const SL = `https://localhost:${P.https}/x`;
const PX = `http://127.0.0.1:${P.open}`;
const PA = `http://127.0.0.1:${P.auth}`;
const PU = `http://u:p@127.0.0.1:${P.auth}`;
const BASIC = `Basic ${Buffer.from('u:p').toString('base64')}`;
const DEAD = `http://127.0.0.1:${P.dead}`;
const W = `ws://127.0.0.1:${P.http}/`;
const NAMED = 'http://sub.example.invalid:8080/x';

const ROWS = {
  // ---- an explicit proxy ----
  'http.string': () => fetchRow(H, { proxy: PX }),
  'https.string': () => fetchRow(S, { proxy: PX, ...TLS }),
  'https.byName': () => fetchRow(SL, { proxy: PX, ...TLS }),
  'http.userinfo': () => fetchRow(H, { proxy: PU }),
  'https.userinfo': () => fetchRow(S, { proxy: PU, ...TLS }),
  'http.userinfoPercentEncoded': () => fetchRow(H, { proxy: `http://u%40x:p%3Ay@127.0.0.1:${P.open}` }),
  'http.object': () => fetchRow(H, { proxy: { url: PA, headers: { 'Proxy-Authorization': BASIC, 'X-Proxy-Extra': 'e' } } }),
  'https.object': () => fetchRow(S, { proxy: { url: PA, headers: { 'Proxy-Authorization': BASIC, 'X-Proxy-Extra': 'e' } }, ...TLS }),
  'https.objectUserinfoUrl': () => fetchRow(S, { proxy: { url: PU }, ...TLS }),
  'https.objectNoUrl': () => fetchRow(S, { proxy: { headers: { 'X-Proxy-Extra': 'e' } }, ...TLS }, { HTTPS_PROXY: PX }),
  'http.407': () => fetchRow(H, { proxy: PA }),
  'https.407': () => fetchRow(S, { proxy: PA, ...TLS }),
  'http.deadProxy': () => fetchRow(H, { proxy: DEAD }),
  'https.deadProxy': () => fetchRow(S, { proxy: DEAD, ...TLS }),
  'http.redirect': () => fetchRow(`http://127.0.0.1:${P.http}/redirect?n=1`, { proxy: PX }),
  'http.invalidUrl': () => fetchRow(H, { proxy: `127.0.0.1:${P.open}` }),
  'http.socks': () => fetchRow(H, { proxy: `socks5://127.0.0.1:${P.open}` }),
  // ---- none named, or none wanted: the environment ----
  'http.env': () => fetchRow(H, {}, { HTTP_PROXY: PX }),
  'https.env': () => fetchRow(S, TLS, { HTTPS_PROXY: PX }),
  'https.envHttpProxyOnly': () => fetchRow(S, TLS, { HTTP_PROXY: PX }),
  'http.envLowerCaseWins': () => fetchRow(H, {}, { HTTP_PROXY: PX, http_proxy: PU }),
  'https.envLowerCaseWins': () => fetchRow(S, TLS, { HTTPS_PROXY: PX, https_proxy: PU }),
  'https.envAllProxy': () => fetchRow(S, TLS, { ALL_PROXY: PX }),
  'http.envNoScheme': () => fetchRow(H, {}, { HTTP_PROXY: `127.0.0.1:${P.open}` }),
  'http.envNull': () => fetchRow(H, { proxy: null }, { HTTP_PROXY: PX }),
  'http.envEmptyString': () => fetchRow(H, { proxy: '' }, { HTTP_PROXY: PX }),
  'http.false': () => fetchRow(H, { proxy: false }, { HTTP_PROXY: PX }),
  'http.none': () => fetchRow(H, {}),
  // ---- no_proxy ----
  // (by address: a host name is the matcher row's, whose targets need not answer)
  'https.noProxyExplicit': () => fetchRow(S, { proxy: PX, ...TLS }, { NO_PROXY: '127.0.0.1' }),
  'https.noProxyEnv': () => fetchRow(S, TLS, { HTTPS_PROXY: PX, NO_PROXY: `127.0.0.1:${P.https}` }),
  'https.noProxyOtherPort': () => fetchRow(S, TLS, { HTTPS_PROXY: PX, NO_PROXY: '127.0.0.1:1' }),
  'https.noProxyLowerCaseWins': () => fetchRow(S, TLS, { HTTPS_PROXY: PX, NO_PROXY: '127.0.0.1', no_proxy: 'nothing' }),
  'noProxy.matcher': async () => {
    const out = {};
    for (const np of ['example.invalid', '.example.invalid', '*.example.invalid', 'invalid', 'sub.example.invalid', 'ample.invalid',
      'SUB.EXAMPLE.INVALID', 'sub.example.invalid:8080', 'sub.example.invalid:80', ' , sub.example.invalid ', '*', '', '.0.0.1']) {
      out[np] = (await reached(NAMED, { proxy: PX }, { NO_PROXY: np })).reached;
    }
    out['default port'] = (await reached('http://example.invalid/x', { proxy: PX }, { NO_PROXY: 'example.invalid:80' })).reached;
    out['ip suffix'] = (await reached(H, { proxy: PX }, { NO_PROXY: '.0.0.1' })).reached;
    return out;
  },
  // ---- WebSocket ----
  'ws.proxy': () => wsRow(W, { proxy: PX }),
  'ws.userinfo': () => wsRow(W, { proxy: PU }),
  'ws.object': () => wsRow(W, { proxy: { url: PA, headers: { 'Proxy-Authorization': BASIC } } }),
  'ws.407': () => wsRow(W, { proxy: PA }),
  'ws.deadProxy': () => wsRow(W, { proxy: DEAD }),
  'ws.envIgnored': () => wsRow(W, {}, { HTTP_PROXY: PX, HTTPS_PROXY: PX }),
  'ws.false': () => wsRow(W, { proxy: false }),
  'ws.noProxy': () => wsRow(W, { proxy: PX }, { NO_PROXY: '127.0.0.1' }),
  'ws.badScheme': () => wsRow(W, { proxy: `socks5://127.0.0.1:${P.open}` }),
};

// the ports differ from run to run; the rows are compared with each one named
function named(v) {
  let s = JSON.stringify(v);
  for (const [k, port] of Object.entries(P)) if (typeof port === 'number') s = s.split(String(port)).join(`<${k}>`);
  return JSON.parse(s);
}

(async () => {
  arrivals();
  const out = {};
  for (const [k, row] of Object.entries(ROWS)) {
    try { out[k] = named(await row()); } catch (e) { out[k] = { rowThrew: String(e && e.stack) }; }
  }
  const text = JSON.stringify(out);
  if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, `${text}\n`);
  console.log(text);
  process.exit(0);
})();
