'use strict';
// node-shim connects to a hostname the way node does: every address, node's order, node's attempt timeout
// (libexec/node-shim/internal/connect-multiple.cjs). The 2026-11-22 live /login on the NetBSD/arm64 VM failed the
// OAuth token exchange with "EHOSTUNREACH": platform.claude.com answers AAAA first, the VM has no IPv6 route, and
// tjs.connect dials only the first answer. Native (Bun) and node fall back to the A record.
//
// Three layers: the policy against a FAKE resolver and fake sockets (host node, every rule); the real http client
// under tjs against `localhost` with a server on 127.0.0.1 only (::1 refuses — the same shape as the VM, with no
// network); and a scan that no other node-shim code dials the engine directly, which is how a new connect path would
// skip all this.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dns = require('node:dns');
const { spawn } = require('node:child_process');
const { tjsPath } = require('./node-shim-helper.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const cm = require('../libexec/node-shim/internal/connect-multiple.cjs');

const V6 = { ip: '2001:db8::10', family: 6 };
const V4 = { ip: '192.0.2.10', family: 4 };

function harness({ answers, behave }) {
  const calls = [];
  const lookups = [];
  const timers = [];
  const deps = {
    lookup: async (host, o) => { lookups.push({ host, ...o }); const a = answers.filter((x) => !o.family || x.family === o.family); return o.all ? a : a[0]; },
    connect: (transport, ip, port, o) => { calls.push({ transport, ip, port, sni: o.sni, signal: o.signal }); return behave(ip, o); },
  };
  return { deps, calls, lookups, timers };
}
const refuse = (code) => Promise.reject(Object.assign(new Error(`connect ${code}`), { code }));

test('connect-multiple: an unreachable AAAA falls through to the A record (the VM\'s failure)', async () => {
  const h = harness({ answers: [V6, V4], behave: (ip) => (ip === V6.ip ? refuse('EHOSTUNREACH') : Promise.resolve({ ip })) });
  const { connectHost } = cm.makeConnectMultiple(h.deps);
  const sock = await connectHost('tls', 'platform.claude.com', 443, {});
  assert.deepStrictEqual(sock, { ip: V4.ip });
  assert.deepStrictEqual(h.calls.map((c) => c.ip), [V6.ip, V4.ip]);
  assert.ok(h.calls.every((c) => c.sni === 'platform.claude.com'), 'the certificate is checked against the NAME, not the address');
});

test('connect-multiple: node\'s order alternates families from the first answer, deduplicated', () => {
  const a = (ip, family) => ({ ip, family });
  assert.deepStrictEqual(cm.attemptOrder([a('::1', 6), a('::2', 6), a('1.1.1.1', 4), a('::1', 6), a('2.2.2.2', 4), a('3.3.3.3', 4)])
    .map((x) => x.address), ['::1', '1.1.1.1', '::2', '2.2.2.2', '3.3.3.3']);
  assert.deepStrictEqual(cm.attemptOrder([a('1.1.1.1', 4), a('::1', 6)]).map((x) => x.address), ['1.1.1.1', '::1']);
});

test('connect-multiple: an attempt that hangs past the attempt timeout is abandoned and the next begins', async () => {
  let v6Signal = null;
  const h = harness({ answers: [V6, V4], behave: (ip, o) => {
    if (ip === V6.ip) { v6Signal = o.signal; return new Promise(() => {}); }
    return Promise.resolve({ ip });
  } });
  const { connectHost } = cm.makeConnectMultiple(h.deps);
  const t0 = Date.now();
  const sock = await connectHost('tcp', 'dual.example', 80, {}, { autoSelectFamilyAttemptTimeout: 30 });
  assert.deepStrictEqual(sock, { ip: V4.ip });
  assert.ok(Date.now() - t0 >= 25, 'the next attempt waits for the attempt timeout');
  assert.ok(v6Signal && v6Signal.aborted, 'the abandoned attempt is aborted');
});

test('connect-multiple: family 4/6 and autoSelectFamily:false make ONE attempt, as node does', async () => {
  for (const [policy, want] of [[{ family: 4 }, [V4.ip]], [{ family: 6 }, [V6.ip]], [{ autoSelectFamily: false }, [V6.ip]]]) {
    const h = harness({ answers: [V6, V4], behave: (ip) => (ip === V6.ip ? refuse('EHOSTUNREACH') : Promise.resolve({ ip })) });
    const { connectHost } = cm.makeConnectMultiple(h.deps);
    await connectHost('tcp', 'dual.example', 80, {}, policy).catch(() => {});
    assert.deepStrictEqual(h.calls.map((c) => c.ip), want, JSON.stringify(policy));
    assert.strictEqual(h.lookups[0].all, false);
  }
});

test('connect-multiple: all attempts failing is an AggregateError whose code is the first attempt\'s; an IP literal is dialled directly', async () => {
  const h = harness({ answers: [V6, V4], behave: (ip) => refuse(ip === V6.ip ? 'EHOSTUNREACH' : 'ECONNREFUSED') });
  const { connectHost } = cm.makeConnectMultiple(h.deps);
  const e = await connectHost('tcp', 'dual.example', 80, {}).then(() => null, (x) => x);
  assert.ok(e instanceof AggregateError);
  assert.strictEqual(e.code, 'EHOSTUNREACH');
  assert.deepStrictEqual(e.errors.map((x) => x.code), ['EHOSTUNREACH', 'ECONNREFUSED']);
  const h2 = harness({ answers: [], behave: (ip) => Promise.resolve({ ip }) });
  await cm.makeConnectMultiple(h2.deps).connectHost('tcp', '127.0.0.1', 80, {});
  assert.strictEqual(h2.lookups.length, 0);
});

// The real client, under tjs: `localhost` answers ::1 first here, and the server listens on 127.0.0.1 only, so the
// first answer refuses exactly as the VM's AAAA did. Before the fix: ECONNREFUSED.
test('node-shim http under tjs reaches a v4-only server through a name that answers ::1 first', async (t) => {
  const tjs = tjsPath();
  if (!tjs) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs)'); return; }
  const answers = await new Promise((r) => dns.lookup('localhost', { all: true }, (e, a) => r(e ? [] : a)));
  if (!(answers[0] && answers[0].family === 6 && answers.some((a) => a.family === 4))) {
    t.skip(`localhost does not answer ::1 first and 127.0.0.1 after here (${JSON.stringify(answers)})`); return;
  }
  const server = http.createServer((q, s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-connect-multiple-'));
  try {
    const script = path.join(tmp, 'get.cjs');
    fs.writeFileSync(script, `require('http').get(process.argv[2], (res) => { console.log('STATUS', res.statusCode, res.socket.remoteAddress); res.resume(); })
      .on('error', (e) => { console.log('ERROR', e.code, e.message); process.exitCode = 1; });\n`);
    const loader = path.join(__dirname, '..', 'libexec', 'node-shim', 'loader.cjs');
    const out = await new Promise((resolve) => {
      const c = spawn(tjs, ['run', loader, script, `http://localhost:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.stderr.on('data', (d) => { s += d; });
      c.on('close', () => resolve(s));
    });
    assert.match(out, /STATUS 200 127\.0\.0\.1/, out);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// No other node-shim code may dial the engine itself: a new connect path that called tjs.connect / tjs.lookup / a
// raw TCPSocket would take the first answer again, silently.
const SHIM_DIR = path.join(__dirname, '..', 'libexec', 'node-shim');
const OWNER = path.join('internal', 'connect-multiple.cjs');
// A line's CODE: string literal contents blanked (an error message may name tjs.connect) and a // comment dropped.
function codeOnly(line) {
  let out = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) { q = null; out += c; } continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c;
  }
  return out;
}
function scanDirectDials(files) {
  const findings = [];
  let examined = 0;
  for (const { rel, src } of files) {
    examined++;
    if (rel === OWNER) continue;
    src.split('\n').forEach((line, i) => {
      const code = codeOnly(line);
      if (/^\s*\*/.test(code)) return;
      if (/\btjs\.connect\s*\(|\btjs\.lookup\s*\(|\bnew\s+(TCPSocket|TLSSocket)\b/.test(code)) {
        findings.push(`libexec/node-shim/${rel}:${i + 1} dials the engine directly (${code.trim()}) — go through internal/connect-multiple.cjs's connectHost`);
      }
    });
  }
  return { findings, examined, note: 'node-shim source files' };
}
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (/\.(c?js|mjs)$/.test(e.name)) out.push({ rel: path.relative(base, p), src: fs.readFileSync(p, 'utf8') });
  }
  return out;
}
const guard = defineGuard({
  name: 'node-shim-connects-through-connect-multiple',
  floor: 10,
  read: () => walk(SHIM_DIR),
  scan: scanDirectDials,
  control: () => [{ rel: path.join('modules', 'http.cjs'), src: 'const sock = await tjs.connect(transport, host, port, opts);' }],
});
guardTests(guard);
