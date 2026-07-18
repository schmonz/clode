'use strict';
// Unit test for `clode fetch --naude`: the CLI-level branch in clode-main.cjs
// that fetches the pinned Node (via clode-node.cjs's ensurePinnedNode) into
// the local store, so a later `clode build --naude` can run without the user
// having Node installed. clode is invoked as a SUBPROCESS here, so we cannot
// inject ensurePinnedNode directly — instead we PRE-SEED the store at the
// exact path nodeBinPath() computes, so ensurePinnedNode finds it already
// present and returns with NO network access (see clode-node.cjs:106-108).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'clode');
const NODE = process.execPath;

const { nodeBinPath } = require('../libexec/clode-node.cjs');

// Mirrors test/clode-fuse.test.cjs's runEntry: spawnSync bin/clode with
// DYLD_INSERT_LIBRARIES cleared (asdf/system shims break under it) and a
// fresh CLODE_WATCH_DIR (never the real ~/.cache/clode) so this test cannot
// mutate real machine state.
function runEntry(args, extraEnv) {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-naude-test-watch-'));
  return spawnSync(NODE, [ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '', CLODE_WATCH_DIR: watchDir }, extraEnv || {}),
  });
}

test('clode fetch --naude: pre-seeded store -> reports the path, no network, exit 0', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-naude-state-'));
  const binPath = nodeBinPath({ CLODE_STATE_ROOT: stateRoot });
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/bin/sh\n');
  fs.chmodSync(binPath, 0o755);

  const r = runEntry(['fetch', '--naude'], { CLODE_STATE_ROOT: stateRoot });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /clode: pinned node ready at/);
  assert.ok(r.stdout.includes(binPath), r.stdout);
});
