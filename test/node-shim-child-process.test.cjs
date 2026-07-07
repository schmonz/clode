'use strict';
// child_process characterization: the shim's spawn/spawnSync/execFile family
// must match host node's observable results for the same fixtures. Locks the
// surface bun-shim patches and the bundle's -p path may call. SKIPs without tjs.
//
// spawnSync/execFileSync: tjs has no synchronous event-loop pump reachable
// from JS (probed empirically — see child_process.cjs header, DIVERGENCE B),
// so the shim WALLS loudly and IMMEDIATELY instead of deadlocking. Those two
// rows assert the wall fires fast (proving no hang) rather than diffing
// against host node's real output. spawn/execFile (async, callback/event
// based) are real and are characterized directly against host node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cp-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('spawnSync: walls loud and fast instead of deadlocking (no tjs sync loop pump)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    try {
      cp.spawnSync('/bin/echo', ['hello']);
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, message: e.message }));
    }`;
  const f = prog(body);
  const start = Date.now();
  const r = runLoader(f);
  const elapsedMs = Date.now() - start;
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.threw, true);
  assert.match(out.message, /synchronous loop pump/);
  // Must wall fast, not ride the loader's 30s timeout — proves no deadlock.
  assert.ok(elapsedMs < 10000, `spawnSync wall took ${elapsedMs}ms — looks like a hang, not a fast throw`);
});

test('execFileSync: inherits the spawnSync wall (also fast, not a hang)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    try {
      cp.execFileSync('/bin/echo', ['xyz']);
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, message: e.message }));
    }`;
  const f = prog(body);
  const start = Date.now();
  const r = runLoader(f);
  const elapsedMs = Date.now() - start;
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.threw, true);
  assert.match(out.message, /synchronous loop pump/);
  assert.ok(elapsedMs < 10000, `execFileSync wall took ${elapsedMs}ms — looks like a hang, not a fast throw`);
});

test('spawn: exit event + piped stdout resolve like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/echo', ['streamed']);
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('exit', (code) => { console.log(JSON.stringify({ code, out: out.trim() })); });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawn: nonzero exit code matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/usr/bin/false', []);
    c.on('exit', (code) => { console.log(JSON.stringify({ code })); });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawn: ENOENT surfaces as an async error event, never a sync throw', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    let threw = false;
    try {
      const c = cp.spawn('/no/such/binary-xyz', []);
      c.on('error', (e) => { console.log(JSON.stringify({ threw, code: e.code })); });
      c.on('exit', () => { console.log(JSON.stringify({ threw, unexpectedExit: true })); });
    } catch (e) { threw = true; console.log(JSON.stringify({ threw, code: e.code })); }`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('execFile (async, callback): stdout + exit code match node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    cp.execFile('/bin/echo', ['xyz'], { encoding: 'utf8' }, (err, stdout, stderr) => {
      console.log(JSON.stringify({ err: err ? err.code || err.message : null, stdout: stdout.trim(), stderr }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('exec (async, shell): stdout matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    cp.exec('echo shelled', { encoding: 'utf8' }, (err, stdout, stderr) => {
      console.log(JSON.stringify({ err: err ? err.code || err.message : null, stdout: stdout.trim(), stderr }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('bun-shim-style feature detection now patches (real functions, not {})', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const patched = [];
    for (const m of ['execFile','execFileSync','spawn','spawnSync','exec','execSync']) {
      const orig = cp[m];
      if (typeof orig !== 'function') continue;
      patched.push(m);
    }
    console.log(JSON.stringify(patched.sort()));`;
  const f = prog(body);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()),
    ['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync']);
});
