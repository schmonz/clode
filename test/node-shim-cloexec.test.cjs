'use strict';
// CLOEXEC characterization: an fd the PARENT opens for its own use must NOT be
// visible inside a SYNC-spawned child unless explicitly wired into its stdio.
// Node's fs.openSync fds are FD_CLOEXEC by default (libuv sets it on every fd
// it creates), so a spawnSync'd child that never asked for that fd cannot see
// it. A shim whose spawn primitive fails to preserve CLOEXEC would leak the
// parent's open fds (config files, sockets, credential handles) into every
// Bash-tool child it spawns — a real information-disclosure/handle-exhaustion
// class distinct from D3's "killed child reported as exit 0" and E1's
// launch-failure crash, so it gets its own row (E2) and its own oracle here.
//
// Oracle: the child tries to `exec 3<&FD` (dup the fd number for reading). In
// POSIX sh, a redirection failure on a plain command aborts the script before
// the next command runs — so if the fd was NOT inherited, "OPENED" never
// prints and the shell exits non-zero; if it WAS leaked (the bug), "OPENED"
// prints and the shell exits 0. Diffed against real node's own spawnSync,
// which must show the same "not leaked" result — this pins BOTH sides to the
// same client-observable contract, not a hardcoded assumption.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cloexec-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const BODY = `
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloexec-target-')), 'f.txt');
  fs.writeFileSync(tmp, 'hello');
  const fd = fs.openSync(tmp, 'r');           // parent-only fd; not passed to any child stdio
  const r = cp.spawnSync('/bin/sh', ['-c', 'exec 3<&' + fd + '; echo OPENED'], { encoding: 'utf8' });
  console.log(JSON.stringify({
    status: r.status,
    leaked: (r.stdout || '').includes('OPENED'),
  }));`;

// RESOLVED (2026-07-23): this initially FAILED against the then-current
// build/tjs/tjs (dated 2026-07-18), which leaked the parent fd. Root cause was
// NOT a code regression — the mod_spawn_sync.c fix (7b36cf5, in-source since
// 2026-07-12: POSIX_SPAWN_CLOEXEC_DEFAULT via posix_spawnattr) was correct all
// along. The Jul-18 binary was a STALE INCREMENTAL BUILD: the object cache
// carried a pre-patch mod_spawn_sync.o that was never recompiled. A clean
// rebuild (`node scripts/build-tjs.mjs --build-only` after clearing the vendor
// build/ object cache) produced a native-arm64 tjs that no longer leaks —
// quaude now matches node (leaked:false). This test is now active and locks it.
test('a parent-opened fd does not leak into a sync-spawned child (CLOEXEC), matching node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Anchor the oracle: host node must not leak (libuv's default CLOEXEC).
  assert.strictEqual(node.leaked, false, 'host node baseline: fd must not leak into the child');
  assert.notStrictEqual(node.status, 0, 'host node baseline: the child errors on the un-inherited fd');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.leaked, false, 'quaude must not leak the parent fd into a sync-spawned child');
  assert.deepStrictEqual(got, node, 'quaude matches node exactly');
});
