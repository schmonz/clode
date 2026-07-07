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

// Host-node parity for the FULL launch-failure lifecycle: on a spawn ENOENT
// node fires BOTH 'error' AND 'close' (order: error then close), 'close' with
// (code,signal)=(-2,null), and does NOT fire 'exit'. A caller using the
// 'close'-listener idiom must not hang. The fixture records the ordered event
// sequence and ends with a bounded self-timer that prints whatever fired — so
// if 'close' never came (a hang under the shim), the sequence would differ
// from node's and the deepStrictEqual would fail rather than the test timing
// out silently.
test("spawn launch failure: fires 'error' THEN 'close' (no 'exit'), args match node", (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const seq = [];
    const c = cp.spawn('/no/such/binary-xyz', []);
    c.on('error', (e) => { seq.push(['error', e.code]); });
    c.on('exit', (code, sig) => { seq.push(['exit', code, sig]); });
    c.on('close', (code, sig) => { seq.push(['close', code, sig]); });
    setTimeout(() => { console.log(JSON.stringify(seq)); }, 250);`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Sanity-anchor the oracle: node must show error then close(-2,null), no exit.
  assert.deepStrictEqual(node, [['error', 'ENOENT'], ['close', -2, null]]);
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

// Wall (Task 4, -p round-trip): the bundle spawns single command STRINGS with
// { shell: true } — `ps aux | grep …` (a pipeline) for IDE detection and the
// session-start hook. Without shell support the shim ENOENTs on a literal
// "ps ... | grep ..." path. With shell:true it must route through /bin/sh -c and
// produce node's observable stdout/exit.
test('spawn: shell:true runs a pipeline command string like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('echo piped | cat', { shell: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('exit', (code) => { console.log(JSON.stringify({ code, out: out.trim() })); });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// Wall (Task 4): execa-style cleanup calls child.stdout.destroy() on the error
// path; the child stream wrappers must expose destroy() (emits 'close') so that
// cleanup doesn't throw `TypeError: not a function`.
test('spawn: child.stdout.destroy() is a function and emits close', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/echo', ['x']);
    const typ = typeof c.stdout.destroy;
    c.stdout.on('close', () => console.log(JSON.stringify({ typ, closed: true })));
    c.on('exit', () => c.stdout.destroy());`;
  const f = prog(body);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { typ: 'function', closed: true });
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
