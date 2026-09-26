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
// own call, so the check runs first, every time, ahead of the memo. Its value is
// still EXISTENCE-CHECKED: a stale path must skip with a reason naming the
// variable, never hand a consumer a spawnSync on a file that isn't there.
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

// provider-resolve.cjs, NOT oracle-models.cjs's resolveProviderBin. The latter is
// filed (BACKLOG.md) as NOT pin-capped: under an ambient CLODE_STATE_ROOT pointed
// at a fresh tmpdir -- which ordinary standalone use of this file can produce, even
// though test/run.mjs itself never does (it sets CLODE_PROVIDER_BIN centrally,
// via THIS SAME resolver, before any test file spawns; resolveProviderBin then
// short-circuits on it and never falls through) -- it falls through
// resolveClaudeBin's `current` step to whatever plain `claude` sits on PATH,
// which can be many versions past UPSTREAM_PIN and incompatible with this repo's
// SCC merge. provider-resolve.cjs's providerBin()/skipReason() never consult
// CLODE_STATE_ROOT at all (storeDir() reads env.HOME directly) and cap selection
// at UPSTREAM_PIN by construction, so there is no strip-the-env workaround to
// maintain here — the resolver itself cannot produce the wrong answer.
const { providerBin, skipReason: providerSkipReason } = require('./provider-resolve.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const { stateRoot } = require('./state-root-helper.cjs');

let memo = null; // { path } | { skip } — set at most once per process, by build()

// The STABLE extraction cache every build here shares (see CLODE_CACHE in build() below).
const STABLE_CACHE = path.join(os.tmpdir(), 'clode-built-binary-cache');

// Every build's private scratch dir, so exit-cleanup can remove exactly what THIS
// process created and nothing another concurrent process is still using.
const builtDirs = [];
let cleanupRegistered = false;
function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', () => {
    for (const d of builtDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort on exit */ } }
  });
}

// build({ cache }) -> { path } | { skip }. `cache` is the CLODE_CACHE the build stages the
// provider in: STABLE_CACHE unless a caller hands it a scratch copy it has changed (the
// reset-invisibility gate builds from a carve whose reset thresholds it lowered, and must never
// write that carve where an ordinary build would pick it up).
function build({ cache = STABLE_CACHE } = {}) {
  const provider = providerBin(process.env);
  if (!provider) {
    return { skip: providerSkipReason(process.env) };
  }

  const engine = tjsPath();
  if (!engine) {
    return { skip: 'no tjs engine binary (CLODE_TJS, or build one with scripts/build-tjs.cjs) to build a quaude with' };
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
      // `cache` (STABLE_CACHE unless the caller passed its own, see above). The default is
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
      CLODE_CACHE: cache,
      // Private per-build state root: never the real ~/.local/share/clode, and
      // never a shared one another test's run left behind (stateRoot(dir) falls
      // back to run.mjs's central CLODE_STATE_ROOT when the whole suite already
      // set one, which is the correct thing to share here too).
      CLODE_STATE_ROOT: stateRoot(dir),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
  if (result.error || result.status !== 0 || !fs.existsSync(out)) {
    let why;
    if (result.error) why = `clode build could not even be spawned: ${result.error.message}`;
    else if (result.status === null && result.signal) {
      why = `clode build was killed by ${result.signal} (likely the 300000ms timeout) before finishing`;
    } else {
      why = `clode build failed (status ${result.status}) building a quaude to drive:\n${result.stdout}\n${result.stderr}`;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { skip: why };
  }
  builtDirs.push(dir);
  registerCleanup();
  return { path: out };
}

function builtQuaude() {
  if (process.env.CLODE_QUAUDE) {
    if (!fs.existsSync(process.env.CLODE_QUAUDE)) {
      return { skip: `CLODE_QUAUDE=${process.env.CLODE_QUAUDE} does not exist` };
    }
    return { path: process.env.CLODE_QUAUDE };
  }
  if (memo) return memo;
  memo = build();
  return memo;
}

module.exports = { builtQuaude, buildQuaude: build, STABLE_CACHE };
