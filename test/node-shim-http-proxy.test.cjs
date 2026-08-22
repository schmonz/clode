'use strict';
// HTTP(S)_PROXY under quaude — proved against a REAL proxy that records what
// arrived, never against what the client claims it did (a client-side check
// cannot tell "proxied" from "direct and lucky").
//
// WHAT WAS WRONG. The shim's http/https client (added 13c91a4) connected
// straight to the origin no matter what the proxy environment said, and said
// nothing about it. Behind a mandatory proxy that is a confusing failure;
// behind a monitoring or filtering proxy it is a silent BYPASS — traffic
// leaving by a route the environment believes is closed. It was also a
// naude-vs-quaude divergence: clode sets NODE_USE_ENV_PROXY=1 for every target
// it builds (libexec/target-env.cjs), and node >= 24 honours the proxy
// environment in its http/https clients under that flag.
//
// WHAT WAS ALREADY RIGHT, and is pinned here so an engine bump cannot lose it
// quietly: the ENGINE honours the proxy environment for `fetch`, the global
// `XMLHttpRequest` and WebSocket (txiki's lws client vhost). That is where
// essentially all of the bundle's traffic goes — a `-p` turn through a local
// proxy shows every request arriving there, including the Messages POST.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, engineSpawn } = require('./node-shim-helper.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const PROBE = path.join(FIXTURES, 'http-proxy-probe.cjs');

// Start a fixture that prints `PORT <n>` once listening (same contract as the
// http-client fixtures). Always host node: the instruments are the fixed point.
function startFixture(script, env = {}) {
  const proc = spawn(process.execPath, [path.join(FIXTURES, script)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${script} never printed a PORT line; stderr:\n${stderr}`)), 15000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = /PORT (\d+)/.exec(buf);
      if (!m) return;
      clearTimeout(timer);
      resolve({ proc, port: Number(m[1]) });
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited early (${code}); stderr:\n${stderr}`)); });
  });
}

// Every spawned fixture goes on a list that is ALWAYS drained: a leaked child
// keeps the test runner's event loop alive, so a failed assertion would hang
// the file instead of failing it (it did, once, for 580 seconds — the
// instrument has to fail fast or it is not an instrument).
function fixtures() {
  const started = [];
  return {
    async start(script, env) { const f = await startFixture(script, env); started.push(f); return f; },
    killAll() { for (const f of started) { try { f.proc.kill(); } catch { /* already gone */ } } },
  };
}

// A port with nothing on it: bind, read the port, close. Used for "the proxy is
// down" — which must fail visibly, never fall back to a direct connection.
function deadPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function freshLog(dir, name) { return path.join(dir, `${name}.jsonl`); }
function arrivals(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function parseProbe(stdout) {
  const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

test('http through a proxy: the request ARRIVES AT THE PROXY, absolute-form, from both engines', async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-proxy-'));
  const fx = fixtures();
  const origin = await fx.start('http-client-origin.cjs');
  const nodeLog = freshLog(dir, 'plain-node');
  const shimLog = freshLog(dir, 'plain-shim');
  const pNode = await fx.start('proxy-server.cjs', { PROXY_LOG: nodeLog });
  const pShim = await fx.start('proxy-server.cjs', { PROXY_LOG: shimLog });
  try {
    const mk = (port) => ({
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
      PROBE_ORIGIN: String(origin.port),
      PROBE_CASE: 'plain',
    });
    const nodeRun = spawnSync(process.execPath, [PROBE], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...mk(pNode.port) } });
    const shimRun = runLoader(PROBE, [], { timeout: 60000, env: mk(pShim.port) });
    const n = parseProbe(nodeRun.stdout);
    const s = parseProbe(shimRun.stdout);
    assert.ok(n, `host node probe printed nothing:\n${nodeRun.stderr}`);
    assert.ok(s, `tjs probe printed nothing:\n${shimRun.stderr}`);
    assert.strictEqual(s.status, 200, `shim did not get a 200: ${JSON.stringify(s)}`);
    assert.deepStrictEqual(
      { status: s.status, originStartLine: s.originStartLine },
      { status: n.status, originStartLine: n.originStartLine },
      'shim and host node disagree about the proxied response');

    const na = arrivals(nodeLog);
    const sa = arrivals(shimLog);
    assert.strictEqual(na.length, 1, `host node: expected exactly one arrival at the proxy, got ${JSON.stringify(na)}`);
    assert.strictEqual(sa.length, 1, `shim: expected exactly one arrival at the proxy, got ${JSON.stringify(sa)} `
      + '(zero means the request went DIRECT — the bug this test exists for)');
    assert.strictEqual(sa[0].startLine, na[0].startLine,
      'the absolute-form request line the proxy saw differs between the shim and host node');
    assert.match(sa[0].startLine, new RegExp(`^GET http://127\\.0\\.0\\.1:${origin.port}/echo HTTP/1\\.1$`));
    // Host stays the ORIGIN's authority through a proxy (node's behaviour).
    assert.ok(sa[0].headers.some((h) => h.toLowerCase() === `host: 127.0.0.1:${origin.port}`),
      `Host header missing or rewritten: ${JSON.stringify(sa[0].headers)}`);
    // proxy-connection mirrors Connection; ours is always close (no pooling).
    assert.ok(sa[0].headers.some((h) => /^proxy-connection: close$/i.test(h)),
      `proxy-connection not mirrored: ${JSON.stringify(sa[0].headers)}`);
  } finally { fx.killAll(); }
});

test('proxy credentials, NO_PROXY, the disable flag, agents and socks: shim matches host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-proxy2-'));
  const fx = fixtures();
  const origin = await fx.start('http-client-origin.cjs');
  const dead = await deadPort();
  try {
    // Each row gets its own proxy+log pair per engine so nothing is attributed to
    // the wrong run.
    const rows = [
      // [case, extra env, expectation]
      ['creds', (p) => ({ HTTP_PROXY: `http://user:pa%40ss@127.0.0.1:${p}`, NODE_USE_ENV_PROXY: '1' }),
        { proxied: true, note: 'credentials in the proxy URL become proxy-authorization' }],
      ['noproxy', (p) => ({ HTTP_PROXY: `http://127.0.0.1:${p}`, NODE_USE_ENV_PROXY: '1', NO_PROXY: '127.0.0.1' }),
        { proxied: false, note: 'NO_PROXY excludes the host' }],
      ['disabled', (p) => ({ HTTP_PROXY: `http://127.0.0.1:${p}` }),
        { proxied: false, note: 'without NODE_USE_ENV_PROXY=1 node ignores the env, and so do we' }],
      ['socks', (p) => ({ HTTP_PROXY: `socks5://127.0.0.1:${p}`, NODE_USE_ENV_PROXY: '1' }),
        { proxied: false, note: 'node ignores a non-http(s) proxy URL' }],
      ['global-agent', (p) => ({ HTTP_PROXY: `http://127.0.0.1:${p}`, NODE_USE_ENV_PROXY: '1' }),
        { proxied: true, note: 'the env applies to the global agent' }],
      ['custom-agent', (p) => ({ HTTP_PROXY: `http://127.0.0.1:${p}`, NODE_USE_ENV_PROXY: '1' }),
        { proxied: false, note: 'a caller-supplied agent opts out of the env proxy, as in node' }],
      ['agent-false', (p) => ({ HTTP_PROXY: `http://127.0.0.1:${p}`, NODE_USE_ENV_PROXY: '1' }),
        { proxied: false, note: 'agent:false goes direct in node' }],
    ];
    for (const [probeCase, mkEnv, expect] of rows) {
      const nodeLog = freshLog(dir, `${probeCase}-node`);
      const shimLog = freshLog(dir, `${probeCase}-shim`);
      const pNode = await fx.start('proxy-server.cjs', { PROXY_LOG: nodeLog });
      const pShim = await fx.start('proxy-server.cjs', { PROXY_LOG: shimLog });
        const common = { PROBE_CASE: probeCase, PROBE_ORIGIN: String(origin.port), NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', NODE_USE_ENV_PROXY: '' };
        const nEnv = { ...process.env, ...common, ...mkEnv(pNode.port) };
        const sEnv = { ...common, ...mkEnv(pShim.port) };
        const nodeRun = spawnSync(process.execPath, [PROBE], { encoding: 'utf8', timeout: 60000, env: nEnv });
        const shimRun = runLoader(PROBE, [], { timeout: 60000, env: sEnv });
        const n = parseProbe(nodeRun.stdout);
        const s = parseProbe(shimRun.stdout);
        assert.ok(n, `[${probeCase}] host node printed nothing:\n${nodeRun.stderr}`);
        assert.ok(s, `[${probeCase}] shim printed nothing:\n${shimRun.stderr}`);
        const na = arrivals(nodeLog);
        const sa = arrivals(shimLog);
        assert.strictEqual(na.length > 0, expect.proxied,
          `[${probeCase}] host node did not behave as the reference row says (${expect.note}): ${JSON.stringify(na)}`);
        assert.strictEqual(sa.length > 0, na.length > 0,
          `[${probeCase}] shim ${sa.length ? 'used' : 'did NOT use'} the proxy where host node ${na.length ? 'did' : 'did not'} (${expect.note})`);
        assert.strictEqual(s.status, n.status, `[${probeCase}] status differs: ${JSON.stringify([s, n])}`);
        if (expect.proxied) {
          assert.strictEqual(sa[0].startLine, na[0].startLine, `[${probeCase}] request line at the proxy differs`);
        }
        if (probeCase === 'creds') {
          const authOf = (a) => a[0].headers.find((h) => /^proxy-authorization:/i.test(h));
          assert.strictEqual(authOf(sa), authOf(na), 'proxy-authorization differs from node');
          assert.match(authOf(sa), /^proxy-authorization: Basic dXNlcjpwYUBzcw==$/i,
            'credentials must be percent-DEcoded before base64 (user:pa@ss)');
        }
        if (probeCase === 'socks') {
          // node goes direct and says nothing. We go direct too (matching node's
          // routing is what keeps this predictable) but we do NOT do it quietly.
          assert.match(shimRun.stderr, /is not an http:\/\/ or https:\/\/ proxy, so it is IGNORED/,
            'an unsupported proxy scheme must be named on stderr, not silently bypassed');
        }
      pNode.proc.kill(); pShim.proc.kill();
    }

    // A proxy that is DOWN must fail visibly — never a quiet fall-back to a
    // direct connection, which is the exact bug.
    {
      const env = {
        PROBE_CASE: 'deadproxy', PROBE_ORIGIN: String(origin.port),
        HTTP_PROXY: `http://127.0.0.1:${dead}`, NODE_USE_ENV_PROXY: '1',
        NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
      };
      const shimRun = runLoader(PROBE, [], { timeout: 60000, env });
      const s = parseProbe(shimRun.stdout);
      assert.ok(s, `dead-proxy probe printed nothing:\n${shimRun.stderr}`);
      assert.ok(s.error, `the request SUCCEEDED with a dead proxy — it fell back to a direct connection: ${JSON.stringify(s)}`);
      assert.strictEqual(s.error.code, 'ECONNREFUSED', `unexpected error: ${JSON.stringify(s)}`);
      const nodeRun = spawnSync(process.execPath, [PROBE], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
      const n = parseProbe(nodeRun.stdout);
      assert.strictEqual(n.error && n.error.code, 'ECONNREFUSED', `host node reference changed: ${JSON.stringify(n)}`);
    }
  } finally { fx.killAll(); }
});

test('https through a proxy is REFUSED by name, not silently sent direct (documented divergence from node)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-proxy3-'));
  const nodeLog = freshLog(dir, 'https-node');
  const shimLog = freshLog(dir, 'https-shim');
  const fx = fixtures();
  const pNode = await fx.start('proxy-server.cjs', { PROXY_LOG: nodeLog });
  const pShim = await fx.start('proxy-server.cjs', { PROXY_LOG: shimLog });
  try {
    const common = { PROBE_CASE: 'https-origin', NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', NODE_USE_ENV_PROXY: '1' };
    const nodeRun = spawnSync(process.execPath, [PROBE], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ...common, HTTPS_PROXY: `http://127.0.0.1:${pNode.port}` },
    });
    const shimRun = runLoader(PROBE, [], { timeout: 60000, env: { ...common, HTTPS_PROXY: `http://127.0.0.1:${pShim.port}` } });
    const n = parseProbe(nodeRun.stdout);
    const s = parseProbe(shimRun.stdout);
    assert.ok(n, `host node printed nothing:\n${nodeRun.stderr}`);
    assert.ok(s, `shim printed nothing:\n${shimRun.stderr}`);
    // Reference: node opens a CONNECT tunnel at the proxy.
    const na = arrivals(nodeLog);
    assert.strictEqual(na.length, 1, `host node reference changed: ${JSON.stringify(na)}`);
    assert.match(na[0].startLine, /^CONNECT nowhere\.example\.invalid:443 /);
    // Subject: we cannot tunnel TLS, so we refuse BY NAME — and, crucially,
    // nothing was sent anywhere: not to the proxy, not direct to the origin.
    assert.ok(s.threw, `the shim did not refuse: ${JSON.stringify(s)}`);
    assert.strictEqual(s.threw.code, 'ERR_SHIM_HTTPS_PROXY_UNSUPPORTED');
    assert.match(s.threw.message, /REFUSING to connect directly/);
    assert.deepStrictEqual(arrivals(shimLog), [], 'the shim contacted the proxy despite refusing');
    assert.ok(!/ENOTFOUND|EAI_NONAME/.test(JSON.stringify(s)),
      'the shim tried to resolve the origin — i.e. it started a DIRECT connection');
  } finally { fx.killAll(); }
});

test('an https:// PROXY (TLS to the proxy itself) works, with the caller\'s CA', async (t) => {
  if (skipUnlessTjs(t)) return;
  // openssl is the only certificate generator this repo can count on; without
  // it the row SKIPS loudly rather than passing on nothing.
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (openssl.status !== 0) { t.skip('no openssl on PATH; cannot mint a test certificate'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-proxy-tls-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const fx = fixtures();
  const origin = await fx.start('http-client-origin.cjs');
  const log = freshLog(dir, 'tls-proxy');
  const proxy = await fx.start('proxy-server.cjs', { PROXY_LOG: log, PROXY_TLS_CERT: cert, PROXY_TLS_KEY: key });
  try {
    const env = {
      PROBE_CASE: 'tls-proxy', PROBE_ORIGIN: String(origin.port), PROBE_CA: cert,
      HTTP_PROXY: `https://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1',
      NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
    };
    const run = runLoader(PROBE, [], { timeout: 60000, env });
    const s = parseProbe(run.stdout);
    assert.ok(s, `probe printed nothing:\n${run.stderr}`);
    assert.strictEqual(s.status, 200, `TLS proxy leg failed: ${JSON.stringify(s)} ${run.stderr}`);
    const a = arrivals(log);
    assert.strictEqual(a.length, 1, `nothing arrived at the TLS proxy: ${JSON.stringify(a)}`);
    assert.match(a[0].startLine, new RegExp(`^GET http://127\\.0\\.0\\.1:${origin.port}/echo `));
    // CA TRUST NOTE, measured: the engine gives a client socket no env-driven
    // trust store — neither SSL_CERT_FILE nor TJS_CA_BUNDLE reaches
    // tjs.connect('tls', ...) — so a private-CA TLS proxy is reachable ONLY
    // through a caller-supplied `ca`. Without one it fails visibly (the proxy
    // logs an "unknown ca" alert); it never falls back to a direct connection.
    const bare = runLoader(PROBE, [], { timeout: 60000, env: { ...env, PROBE_CASE: 'plain' } });
    const b = parseProbe(bare.stdout);
    assert.ok(b && b.error, `an untrusted TLS proxy did not fail: ${JSON.stringify(b)}`);
  } finally { fx.killAll(); }
});

test('a proxy AGENT is honoured (http) or refused by name (socks) — never ignored', async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-proxy4-'));
  const fx = fixtures();
  const origin = await fx.start('http-client-origin.cjs');
  const log = freshLog(dir, 'agent-proxy');
  const proxy = await fx.start('proxy-server.cjs', { PROXY_LOG: log });
  try {
    const env = {
      PROBE_CASE: 'agent-proxy', PROBE_ORIGIN: String(origin.port), PROBE_PROXY: String(proxy.port),
      NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', NODE_USE_ENV_PROXY: '',
    };
    const run = runLoader(PROBE, [], { timeout: 60000, env });
    const s = parseProbe(run.stdout);
    assert.ok(s, `probe printed nothing:\n${run.stderr}`);
    assert.strictEqual(s.status, 200, `agent-proxy request failed: ${JSON.stringify(s)}`);
    const a = arrivals(log);
    assert.strictEqual(a.length, 1, `the agent's proxy was IGNORED (nothing arrived): ${JSON.stringify(a)}`);
    assert.match(a[0].startLine, new RegExp(`^GET http://127\\.0\\.0\\.1:${origin.port}/echo `));

    const socksRun = runLoader(PROBE, [], { timeout: 60000, env: { ...env, PROBE_CASE: 'agent-proxy-socks' } });
    const sk = parseProbe(socksRun.stdout);
    assert.ok(sk && sk.threw, `a socks agent was not refused: ${JSON.stringify(sk)}`);
    assert.strictEqual(sk.threw.code, 'ERR_SHIM_HTTP_UNSUPPORTED_AGENT_PROXY');
  } finally { fx.killAll(); }
});

test('ALL_PROXY is honoured (a DELIBERATE divergence: node ignores it, this engine does not)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-proxy5-'));
  const fx = fixtures();
  const origin = await fx.start('http-client-origin.cjs');
  const shimLog = freshLog(dir, 'allproxy-shim');
  const nodeLog = freshLog(dir, 'allproxy-node');
  const pShim = await fx.start('proxy-server.cjs', { PROXY_LOG: shimLog });
  const pNode = await fx.start('proxy-server.cjs', { PROXY_LOG: nodeLog });
  try {
    const mk = (port) => ({
      PROBE_CASE: 'plain', PROBE_ORIGIN: String(origin.port),
      ALL_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '', no_proxy: '', all_proxy: '',
    });
    const run = runLoader(PROBE, [], { timeout: 60000, env: mk(pShim.port) });
    const s = parseProbe(run.stdout);
    assert.ok(s, `probe printed nothing:\n${run.stderr}`);
    assert.strictEqual(s.status, 200, JSON.stringify(s));
    assert.strictEqual(arrivals(shimLog).length, 1,
      'ALL_PROXY was ignored by the shim — the engine honours it for fetch/XHR, so this client going '
      + 'direct would be a bypass inside the same process');
    // The reference, recorded rather than asserted-away: node reads only the
    // http_proxy/https_proxy pairs, so it goes direct here.
    const n = spawnSync(process.execPath, [PROBE], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...mk(pNode.port) } });
    const np = parseProbe(n.stdout);
    assert.strictEqual(np.status, 200, JSON.stringify(np));
    assert.deepStrictEqual(arrivals(nodeLog), [], 'host node started reading ALL_PROXY — revisit this divergence');
  } finally { fx.killAll(); }
});

// ---- the pure decision functions, against node's own implementation ---------
// These run on every platform, engine or not: they are the semantics, and they
// are a straight port of node's ProxyConfig#shouldUseProxy.
const NO_PROXY_TABLE = [
  // [no_proxy, host, port, useProxy?]
  ['', 'example.com', 80, true],
  ['*', 'example.com', 80, false],
  ['example.com', 'example.com', 80, false],
  ['example.com', 'EXAMPLE.com', 80, false],
  ['example.com', 'sub.example.com', 80, true],       // a bare entry is NOT a suffix
  ['.example.com', 'sub.example.com', 80, false],     // a leading dot IS
  ['.example.com', 'example.com', 80, false],         // ...and matches the bare name too
  ['.example.com', 'badexample.com', 80, true],       // but only on a label boundary
  ['*.example.com', 'sub.example.com', 80, false],
  ['*.example.com', 'example.com', 80, true],
  ['example.com:8080', 'example.com', 8080, false],
  ['example.com:8080', 'example.com', 9090, true],
  ['foo , example.com , bar', 'example.com', 80, false],   // entries are trimmed
  ['127.0.0.0-127.0.0.255', '127.0.0.1', 80, false],       // simple IPv4 ranges
  ['127.0.0.0-127.0.0.255', '128.0.0.1', 80, true],
  ['10.0.0.1-10.0.0.9', 'example.com', 80, true],           // range vs a name: no match
];

test('no_proxy matching is node\'s, case for case', () => {
  const http = require('../libexec/node-shim/modules/http.cjs');
  const { makeProxyConfig, shouldUseProxy } = http._internals.proxy;
  for (const [list, host, port, expected] of NO_PROXY_TABLE) {
    const cfg = makeProxyConfig('http://proxy.internal:3128', list);
    assert.strictEqual(shouldUseProxy(cfg, host, port), expected,
      `no_proxy=${JSON.stringify(list)} host=${host}:${port}`);
  }
});

test('the no_proxy table IS node\'s answer (checked against node\'s own ProxyConfig)', (t) => {
  // node keeps the implementation in internal/http; --expose-internals is the
  // only way to reach it. If a future node drops that, this row SKIPS loudly
  // rather than passing on a table nobody re-checked.
  const script = `
    const { parseProxyConfigFromEnv } = require('internal/http');
    const table = ${JSON.stringify(NO_PROXY_TABLE)};
    const out = table.map(([list, host, port]) => {
      const cfg = parseProxyConfigFromEnv({ http_proxy: 'http://proxy.internal:3128', no_proxy: list }, 'http:', false);
      return cfg.shouldUseProxy(host, port);
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--expose-internals', '-e', script], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) { t.skip(`node internals unavailable (${(r.stderr || '').split('\n')[0]})`); return; }
  const nodeAnswers = JSON.parse(r.stdout);
  assert.deepStrictEqual(nodeAnswers, NO_PROXY_TABLE.map((row) => row[3]),
    'node\'s no_proxy semantics moved out from under the table above');
});

test('proxy URL parsing: credentials become a header and leave the href', () => {
  const http = require('../libexec/node-shim/modules/http.cjs');
  const { makeProxyConfig, envProxyEnabled, proxyUrlFromEnv } = http._internals.proxy;
  const cfg = makeProxyConfig('http://user:pa%40ss@127.0.0.1:3128', '');
  assert.strictEqual(cfg.auth, `Basic ${Buffer.from('user:pa@ss').toString('base64')}`);
  assert.ok(!cfg.href.includes('pa%40ss') && !cfg.href.includes('user:'),
    `credentials must not survive into the loggable href: ${cfg.href}`);
  assert.strictEqual(cfg.port, 3128);
  assert.strictEqual(makeProxyConfig('http://p.internal', '').port, 80);
  assert.strictEqual(makeProxyConfig('https://p.internal', '').port, 443);
  assert.throws(() => makeProxyConfig('not a url', ''), { code: 'ERR_PROXY_INVALID_CONFIG' });
  // Only the exact string "1" enables it — node's boolean env-option parsing,
  // measured against node v24 (true/yes/2/'' all went direct).
  for (const v of ['1']) assert.strictEqual(envProxyEnabled({ NODE_USE_ENV_PROXY: v }), true, v);
  for (const v of ['0', 'true', 'TRUE', 'yes', '2', '', undefined]) {
    assert.strictEqual(envProxyEnabled({ NODE_USE_ENV_PROXY: v }), false, String(v));
  }
  // Lower case wins over upper case, and https: reads the https_* pair.
  assert.strictEqual(proxyUrlFromEnv({ http_proxy: 'http://lower', HTTP_PROXY: 'http://UPPER' }, 'http:'), 'http://lower');
  assert.strictEqual(proxyUrlFromEnv({ HTTP_PROXY: 'http://UPPER' }, 'http:'), 'http://UPPER');
  assert.strictEqual(proxyUrlFromEnv({ HTTPS_PROXY: 'http://s' }, 'https:'), 'http://s');
  assert.strictEqual(proxyUrlFromEnv({ HTTP_PROXY: 'http://p' }, 'https:'), null);
  assert.throws(() => proxyUrlFromEnv({ HTTP_PROXY: 'http://p\r\nX: y' }, 'http:'), { code: 'ERR_PROXY_INVALID_CONFIG' });
});

// ---- the ENGINE's own proxy support ----------------------------------------
// Not our code, but load-bearing for quaude: fetch and XMLHttpRequest carry
// essentially all of the bundle's traffic, and if an engine bump lost this the
// symptom would be a silent bypass with nothing in our own code to blame.
test('engine: fetch and XMLHttpRequest honour the proxy env, respect NO_PROXY, and fail visibly when it is down', async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-proxy-'));
  const fx = fixtures();
  const origin = await fx.start('http-client-origin.cjs');
  const dead = await deadPort();
  const runEngine = (env) => {
    const [cmd, argv] = engineSpawn(['run', path.join(FIXTURES, 'engine-proxy-probe.js')]);
    return spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  };
  try {
    // 1. proxied
    const log1 = freshLog(dir, 'engine-on');
    const p1 = await fx.start('proxy-server.cjs', { PROXY_LOG: log1 });
    const r1 = runEngine({
      PROBE_ORIGIN: String(origin.port), HTTP_PROXY: `http://127.0.0.1:${p1.port}`,
      NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
    });
    p1.proc.kill();
    const o1 = parseProbe(r1.stdout);
    assert.ok(o1, `engine probe printed nothing:\n${r1.stderr}`);
    assert.strictEqual(o1.fetch.status, 200, JSON.stringify(o1));
    assert.strictEqual(o1.xhr.status, 200, JSON.stringify(o1));
    const a1 = arrivals(log1);
    // lws tunnels even plain http through CONNECT — a documented engine
    // difference from node's absolute-form, and still a real proxy transit.
    assert.strictEqual(a1.length, 2,
      `engine fetch/XHR did not both reach the proxy (this is the silent-bypass shape): ${JSON.stringify(a1)}`);
    for (const a of a1) assert.match(a.startLine, new RegExp(`^CONNECT 127\\.0\\.0\\.1:${origin.port} `));

    // 2. NO_PROXY excludes the host
    const log2 = freshLog(dir, 'engine-noproxy');
    const p2 = await fx.start('proxy-server.cjs', { PROXY_LOG: log2 });
    const r2 = runEngine({
      PROBE_ORIGIN: String(origin.port), HTTP_PROXY: `http://127.0.0.1:${p2.port}`,
      NO_PROXY: '127.0.0.1', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
    });
    p2.proc.kill();
    const o2 = parseProbe(r2.stdout);
    assert.strictEqual(o2.fetch.status, 200, JSON.stringify(o2));
    assert.deepStrictEqual(arrivals(log2), [], 'NO_PROXY did not exclude the host at the engine level');

    // 3. proxy down -> visible failure, NOT a direct connection
    const r3 = runEngine({
      PROBE_ORIGIN: String(origin.port), HTTP_PROXY: `http://127.0.0.1:${dead}`,
      NO_PROXY: '', no_proxy: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
    });
    const o3 = parseProbe(r3.stdout);
    assert.ok(o3.fetch.error, `fetch succeeded with a dead proxy — it went direct: ${JSON.stringify(o3)}`);
    assert.ok(o3.xhr.error, `XHR succeeded with a dead proxy — it went direct: ${JSON.stringify(o3)}`);
  } finally { fx.killAll(); }
});
