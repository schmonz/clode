'use strict';
// Node-native successor to test_argv0_shadow.bats. Exercises the shell-snapshot
// grep/find/rg SHADOW rewrite (libexec/bun-shim.cjs rewriteSnapshot): Claude Code's
// upstream shadow bodies invoke the provider under a custom argv0 (`ARGV0=ugrep …`
// / `exec -a ugrep …`) so the native binary dispatches its bundled multiplexer.
// Under clode that argv0 trick can't dispatch, so rewriteSnapshot replaces the body
// with `exec "$ugrep" <upstream-flags> "$@"` routed to the REAL host applet, guarded
// fail-loud when the applet is absent. We render the rewritten snapshot, source it in
// a POSIX shell, and confirm `grep` execs the host ugrep (test 1) or fails loud
// (test 2). The argv0 mechanism lives inside the generated shell text, not in how we
// spawn — so this test drives /bin/sh, matching the bats which used `sh -c`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO, NODE } = require('./e2e.cjs');

const BUN_SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'snapshot-execpath.sh');

// The bats rewrote the fixture in a SEPARATE node subprocess (so bun-shim.cjs's
// require-time side effects — Module._load / child_process patching, globalThis
// mutation — never touch the test runner). Replicate that isolation verbatim: same
// `-e` program, same argv[1]=shim / argv[2]=fixture positional args.
const REWRITE_SRC =
  'const fs=require("fs"), {rewriteSnapshot}=require(process.argv[1]);' +
  'process.stdout.write(rewriteSnapshot(fs.readFileSync(process.argv[2],"utf8")));';

function rewriteSnap(sbx) {
  const r = spawnSync(NODE, ['-e', REWRITE_SRC, BUN_SHIM, FIXTURE], {
    encoding: 'utf8', env: sbx.env, cwd: REPO,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const snap = path.join(sbx.dir, 'snap.sh');
  fs.writeFileSync(snap, r.stdout);
  return snap;
}

// Render a rewritten snapshot, then source it with a stub `ugrep` on PATH and
// confirm `grep` (the shadow) execs the stub with the upstream flags.
test('rewritten grep shadow execs the real ugrep with upstream flags', (t) => {
  const sbx = sandbox(t);
  const snap = rewriteSnap(sbx);

  // a stub ugrep that records argv
  const binDir = path.join(sbx.dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ugrep = path.join(binDir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\necho "ugrep-called: $*"\n');
  fs.chmodSync(ugrep, 0o755);

  const r = spawnSync('/bin/sh', ['-c', `. '${snap}'; grep needle`], {
    encoding: 'utf8',
    env: { ...sbx.env, PATH: `${binDir}:${sbx.env.PATH}` },
    cwd: REPO,
  });
  const output = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 0);
  assert.match(output, /ugrep-called:/);
  assert.match(output, /--ignore-files/);
  assert.match(output, /needle/);
});

test('rewritten grep shadow fails loud when ugrep is absent', (t) => {
  const sbx = sandbox(t);
  const snap = rewriteSnap(sbx);

  // Use a minimal PATH that has sh (/bin/sh) but no ugrep, and clear CLODE_UGREP.
  // The intended exit is 127 (the fail-loud path) — bats declared it via `run -127`.
  const binDir = path.join(sbx.dir, 'bin');   // never created — matches the bats
  const r = spawnSync('/bin/sh', ['-c', `. '${snap}'; grep needle`], {
    encoding: 'utf8',
    env: { ...sbx.env, PATH: `${binDir}:/bin:/usr/bin`, CLODE_UGREP: '' },
    cwd: REPO,
  });
  const output = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 127);
  assert.match(output, /clode: grep needs 'ugrep'/);
});
