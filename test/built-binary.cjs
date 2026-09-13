'use strict';
// builtQuaude() -> { path } | { skip: reason }
//
// The umbrella's phase 3 rule: the suite drives the BUILT product, not the source
// tree. This is the ONE seam every gated-on-a-built-quaude test calls through.
//
// Measured on this box 2026-09-13, exact numbers in task-3-report.md: with engine
// + provider already resolvable and deps/claude/node_modules already installed
// in-tree (so this never touches the network), a build here lands in the same
// ballpark as the phase's own 14s finding once the extraction cache below is
// warm. That is nowhere near "every test file pays it" — memoization is what
// keeps one process's whole run of consumers from paying it more than once, and
// the stable cache dir is what keeps successive PROCESSES from each paying the
// upstream-extraction cost that memoization alone can't share across them.
//
// CLODE_QUAUDE wins, unconditionally, on every call — never folded into the memo.
// This is not a convenience: it is how CI (which already builds artifacts it
// could hand over) and the slowest box this project supports (Mavericks, per the
// umbrella) keep this rule from taxing them. A caller that reads process.env
// AFTER an earlier no-override build must still see the override honoured on its
// own call, so the check runs first, every time, ahead of the memo.
//
// NO CONTENT KEY, NO STALENESS HASH — deliberate. "Build once per process,
// memoize the path" is the whole cache-invalidation story here. A second
// hand-rolled key (a source hash, a version string) would repeat the exact
// mistake phase 2 already caught in MERGER_VERSION: a hand-maintained '12'
// standing in for a hash of the merger's own source, because keys here are
// NEVER hand-written. Phase 4 owns derived content keys; until it lands, a
// process that wants a fresh build starts a fresh process (every test-runner
// invocation already does).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'scripts', 'stage0.mjs');

const { resolveProviderBin } = require('./oracle-models.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const { stateRoot } = require('./state-root-helper.cjs');

let memo = null; // { path } | { skip } — set at most once per process, by build()

function build() {
  // Resolve the provider with CLODE_STATE_ROOT stripped from the lookup env.
  // "What provider is really on this machine" is a machine fact, not scoped to
  // any one test's throwaway state root -- but test/run.mjs sets ONE central
  // CLODE_STATE_ROOT for the entire suite before any file runs (its own
  // documented behavior), so by the time this ever runs under a real suite
  // pass, process.env.CLODE_STATE_ROOT is ALREADY SET to a fresh, empty root.
  // resolveClaudeBin's `current` step (clode-resolve.cjs) reads the clode-
  // managed provider pointer under THAT root; a fresh one has none, so
  // resolution falls through past the real, working, pinned provider store to
  // whatever plain `claude` happens to sit in ~/.local/bin -- on this box, a
  // newer native install (2.1.270) that this repo's SCC-merge does not yet
  // absorb, and the build fails outright.
  // Reproduced directly: `resolveProviderBin(process.env)` returns
  // .../providers/2.1.252/claude with no ambient CLODE_STATE_ROOT, and
  // .../claude/versions/2.1.270 with one set -- same process, same real
  // provider store on disk, different answer. An explicit CLODE_PROVIDER_BIN
  // or CLODE_CLAUDE_BIN still wins either way (checked first, unaffected by
  // this), so a caller that wants a SPECIFIC provider is never overridden.
  const providerLookupEnv = { ...process.env };
  delete providerLookupEnv.CLODE_STATE_ROOT;
  let provider = null;
  try { provider = resolveProviderBin(providerLookupEnv); } catch { /* treated as absent below */ }
  if (!provider || !fs.existsSync(provider)) {
    return { skip: 'no resolvable Claude Code provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN / the provider store / PATH) to build a quaude from' };
  }

  const engine = tjsPath();
  if (!engine) {
    return { skip: 'no tjs engine binary (CLODE_TJS, or build one with scripts/build-tjs.mjs) to build a quaude with' };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'built-binary-'));
  const out = path.join(dir, process.platform === 'win32' ? 'quaude.exe' : 'quaude');
  const result = spawnSync(process.execPath, [ENTRY, 'build', '--out', out], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_CLAUDE_BIN: provider,
      CLODE_TJS: engine,
      // A STABLE, shared-across-processes cache dir, off-tree and off the real
      // operator store (~/.cache/clode is never touched) -- same shape as
      // oracle-models.cjs's CLODE_ORACLE_STAGE_ROOT and node-shim-helper.cjs's
      // tjsPath() scratch dir, both of which already persist under TMPDIR across
      // test processes on purpose. This is NOT a second content key: the cache
      // it warms (libexec/clode-extract.cjs, keyed by clode-resolve.cjs's own
      // cacheKey(providerBin)) already exists and is already keyed correctly by
      // the PROVIDER's own version/signature, not by anything this file
      // computes. Pointing CLODE_CACHE at a stable path only lets that
      // pre-existing cache survive across the separate OS processes each
      // `node --test` file runs in -- measured 2026-09-13: ~30s cold, ~9s once
      // this directory is warm (see task-3-report.md). It cannot go stale
      // against a change to clode's OWN build code: the merge/blobulate steps
      // read the current template and extractor fresh every call regardless;
      // only the upstream-provider extraction is skipped when unchanged.
      CLODE_CACHE: path.join(os.tmpdir(), 'clode-built-binary-cache'),
      // Private per-build state root: never the real ~/.local/share/clode, and
      // never a shared one another test's run left behind (stateRoot(dir) falls
      // back to run.mjs's central CLODE_STATE_ROOT when the whole suite already
      // set one, which is the correct thing to share here too).
      CLODE_STATE_ROOT: stateRoot(dir),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
  if (result.status !== 0 || !fs.existsSync(out)) {
    return { skip: `clode build failed (status ${result.status}) building a quaude to drive:\n${result.stdout}\n${result.stderr}` };
  }
  return { path: out };
}

function builtQuaude() {
  if (process.env.CLODE_QUAUDE) return { path: process.env.CLODE_QUAUDE };
  if (memo) return memo;
  memo = build();
  return memo;
}

module.exports = { builtQuaude };
