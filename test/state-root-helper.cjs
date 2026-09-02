'use strict';
// CLODE_STATE_ROOT for a single test file, standalone-safe.
//
// test/run.mjs sets ONE CLODE_STATE_ROOT centrally for the whole suite (see its
// comment there) -- every child a test spawns with `...process.env` inherits it.
// That covers a test run THROUGH `node test/run.mjs`, but not:
//   - `HOME=<tmp> node --test test/foo.test.cjs` run standalone (run.mjs never
//     executes, so process.env.CLODE_STATE_ROOT is simply unset), or
//   - CI, which invokes several of these files directly, not through run.mjs
//     (.github/workflows/ci.yml runs test/clode-native.test.cjs and
//     test/e2e-tui-tjs.test.cjs by name).
// In both cases `...process.env` alone silently falls through to the real
// HOME/XDG state dir -- clode-paths.cjs's own documented precedence is
// CLODE_STATE_ROOT > XDG_* > HOME -- and a `clode build` that reaches
// clodeBuild's finally (libexec/clode-fuse.cjs) appends a real line to
// <clodeDataDir>/build-trace.jsonl, plus re-acquires a dependency on the real
// deps store, provider store and cache that a private root would otherwise cut.
//
// Respect an ambient root (never fight run.mjs's central one, and never fight
// a caller that legitimately wants CLODE_STATE_ROOT unset -- see
// test/clode-update.test.cjs, which deletes it explicitly per-fixture); when
// none is set, use the caller's own private dir if it has one already, else
// mint a fresh one. ONE helper, called by every file that needs this, rather
// than nine copies that can silently drift.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stateRoot(privateDir) {
  if (process.env.CLODE_STATE_ROOT) return process.env.CLODE_STATE_ROOT;
  if (privateDir) return privateDir;
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-test-state-'));
}

module.exports = { stateRoot };
