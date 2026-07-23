'use strict';
// Regression guard for the CLASS of bug fixed at 50646d9 (fix(tjs/haiku):
// pipe() child stdio — Haiku's socketpair deadlocks past 64KB; see
// scripts/build-tjs.mjs's fixupLibuvHaikuStdioPipe): a spawned child that
// produces MORE than one pipe buffer's worth of stdout before exiting must
// have its FULL output collected by the parent — never hang. That fix is
// `#if defined(__HAIKU__)`-guarded (this file's darwin/linux code path is the
// byte-for-byte UNCHANGED libuv socketpair branch — see the anchor/`#else` in
// fixupLibuvHaikuStdioPipe), so it cannot exercise the Haiku-specific branch
// on this box. What it DOES lock: the general "large child output completes,
// matches node, no deadlock" invariant, on the exact code path (tjs's own
// child-stdio pipe creation for a spawned child) the Haiku fix touches — the
// same shape of test that would TIME OUT (and fail, not hang silently)
// against the unpatched Haiku libuv on that rig. Also covers the sibling
// "write a large file" clause of C2 via fs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const N = 200 * 1024; // > one pipe buffer (~64KB) with margin
const RUN_TIMEOUT = 20000; // generous: a deadlock must show up as a bounded failure, not a CI hang

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-large-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

// The fixture itself spawns a real child (via child_process, going through
// whichever runtime — node or tjs — is executing this script) that produces
// > 64KB of stdout before exiting, and reports what it collected + exit code.
// This exercises the SAME pipe-stdio-creation path the Haiku fix patches,
// from inside the engine under test, not just this test file's own process.
const SPAWN_BODY = `
  const cp = require('node:child_process');
  const c = cp.spawn('/bin/sh', ['-c', 'head -c ${N} /dev/zero | tr "\\\\0" "A"']);
  let len = 0;
  c.stdout.on('data', (d) => { len += d.length; });
  c.on('exit', (code) => { console.log(JSON.stringify({ code, len })); });
  c.on('error', (e) => { console.log(JSON.stringify({ code: null, len, err: String(e) })); });`;

test('a spawned child producing >64KB of stdout before exiting completes without deadlock, matching node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(SPAWN_BODY);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: RUN_TIMEOUT }).trim());
  assert.strictEqual(node.code, 0, 'host node baseline: child must exit cleanly');
  assert.strictEqual(node.len, N, 'host node baseline: full child output collected');
  // A deadlock manifests as runLoader's own timeout (spawnSync kills + returns
  // a non-zero/null status) rather than this test call hanging forever.
  const r = runLoader(f, [], { timeout: RUN_TIMEOUT });
  assert.strictEqual(r.status, 0, `quaude must not hang collecting a large child output; stderr:\n${r.stderr}`);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.code, 0, 'quaude: spawned child must exit cleanly');
  assert.strictEqual(got.len, N, 'quaude must collect the FULL child output, matching node (no short-read/deadlock)');
});

// Sibling clause of C2 ("write a large file"): a >64KB write through fs must
// round-trip in full, matching node — the general large-write invariant
// (distinct from D1/A1's small 0-byte-config-write bug, and from the
// isatty/O_NONBLOCK large-stdout-write regression already locked in
// node-shim-tty.test.cjs).
test('writing a >64KB file completes and reads back in full, matching node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'large-write-')), 'out.bin');
    const payload = 'B'.repeat(${N});
    fs.writeFileSync(f, payload);
    const back = fs.readFileSync(f, 'utf8');
    console.log(JSON.stringify({ len: back.length, match: back === payload }));`;
  const f = prog(body);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: RUN_TIMEOUT }).trim());
  assert.deepStrictEqual(node, { len: N, match: true }, 'host node baseline');
  const r = runLoader(f, [], { timeout: RUN_TIMEOUT });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node, 'quaude matches node exactly');
});
