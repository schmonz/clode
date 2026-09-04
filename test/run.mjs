#!/usr/bin/env node
'use strict';
// run.mjs — the cross-platform test runner. Replaces the sh run-all.sh with ONE node
// orchestrator that works identically on Linux/macOS/Windows. `npm test` -> this.
// Offline by default; `--online` opts in. Sets CLODE_NODE, installs+preflights the PTY
// harness, then runs the hermetic guard around `node --test test/*.test.cjs`, exiting
// nonzero on any test failure or hermeticity violation.
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../test
const ROOT = path.dirname(HERE);                           // repo root
process.chdir(ROOT);

// Offline gate: the runner is the single source of truth; an ambient CLODE_OFFLINE never leaks in.
const arg = process.argv[2] || '--offline';
if (arg === '--online') delete process.env.CLODE_OFFLINE;
else if (arg === '--offline') process.env.CLODE_OFFLINE = '1';
else { console.error('usage: node test/run.mjs [--online|--offline]'); process.exit(2); }

// CLODE_NODE = the concrete node running this runner (already the real binary; no shim canonicalization).
process.env.CLODE_NODE = process.execPath;

// Keychain gate: the macOS-keychain EMULATION is gone (BACKLOG.md, 2026-08-28 —
// upstream 2.1.251 already falls back to ~/.claude/.credentials.json on its own,
// so re-implementing that fallback was a redundant divergence that had caused
// six separate bugs). Deleting the emulation does NOT stop the bundle's own
// `security` calls from reaching the REAL binary: reads via
// `execFile("security",["find-generic-password",...])` and writes via
// `security -i` (command on stdin). Under a test-redirected HOME neither call
// has a real login keychain to answer from, and the OS pops a modal on the
// operator's screen reading "Could not find a keychain to store <account>" —
// exactly the failure this gate exists to prevent. So the SUITE must never let
// a spawned child reach the real `security` binary at all.
//
// Shadow it with a stub: a directory holding a `security` script, PREPENDED to
// PATH (not substituted for it) so every other PATH-resolved tool the bundle
// wants (rg/bfs/ugrep/git/sh) still resolves exactly as before. An EMPTY decoy
// dir does NOT work — it shadows nothing, since PATH search just skips past an
// empty directory to the real `security` further down the chain (this sank an
// earlier attempt; see the git history of node-shim-roundtrip-oracle.test.cjs).
// Set here (not per-test) so it flows to every test file's spawns automatically
// via `env: {...process.env, ...}` — this used to be each file's own private
// copy (node-shim-roundtrip-oracle.test.cjs); centralizing it here means a new
// test file gets the shadow for free instead of having to remember it.
//
// Both upstream call shapes are handled: `find-generic-password` (a read) exits
// 44 with the exact stderr real `security` prints for errSecItemNotFound — a
// version-stable, byte-verified string (see KC_NOT_FOUND_STDERR's old home in
// child_process.cjs before the emulation's deletion) — and `-i` (a write, with
// the actual add/update command on stdin) drains stdin and exits 0 quietly,
// touching nothing. `security` is darwin-only; the stub is a no-op elsewhere.
const KC_STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-security-stub-'));
if (process.platform === 'darwin') {
  // Every branch below terminates WITHOUT touching the real `security`, so
  // an unmatched subcommand falling to `*)` is still dialog-safe — this is a
  // plain shell script, not the real binary, regardless of which case fires.
  // add-generic-password/delete-generic-password are covered anyway (not just
  // for safety, already covered by `*)`, but for TEST-BEHAVIOR correctness):
  // upstream's argv-based write fallback (used when the -i stdin payload
  // exceeds its size cap) and the doctor keychain-writability probe's own
  // cleanup both use them directly, and quietly succeeding here — instead of
  // falling to the generic `*) exit 1` — keeps that fallback path and that
  // probe from reporting a spurious keychain failure in a test run.
  const stubBody = '#!/bin/sh\n'
    + 'case "$1" in\n'
    + '  find-generic-password) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." 1>&2; exit 44 ;;\n'
    + '  -i) cat >/dev/null; exit 0 ;;\n'
    + '  add-generic-password) exit 0 ;;\n'
    + '  delete-generic-password) exit 0 ;;\n'
    + '  *) exit 1 ;;\n'
    + 'esac\n';
  const stubPath = path.join(KC_STUB_DIR, 'security');
  fs.writeFileSync(stubPath, stubBody);
  fs.chmodSync(stubPath, 0o755);
}
process.env.PATH = [KC_STUB_DIR, process.env.PATH || ''].join(path.delimiter);
// Exposed so a test can assert the shadow is actually reachable from a spawned
// child (test/central-security-stub.test.cjs), not merely that PATH changed.
process.env.CLODE_TEST_SECURITY_STUB_DIR = KC_STUB_DIR;

// State-root gate: a `clode build` (this suite drives MANY, real and fake) appends
// one trace-log line per build (Task 5, build-trace.cjs) to <clodeDataDir>/
// build-trace.jsonl, which resolves off HOME/XDG when nothing overrides it. Set
// centrally, ONCE, for the same reason the `security` stub above moved from a
// per-file convention to one place here: it started as nine individual tests each
// remembering to pass CLODE_STATE_ROOT, one of them (test/clode-native.test.cjs)
// did not, and it silently appended real build timings into the OPERATOR'S OWN
// ~/.local/share/clode/build-trace.jsonl on every suite run — proven live, 84 -> 85
// lines, before this fix existed. Product code (clodeBuild) must not know it is
// running under test (the user's own correction to an earlier, rejected shape of
// this fix: teaching appendRun to detect a test harness and refuse to write). The
// test RUNNER configuring its own environment, once, for every child it spawns —
// exactly what this file already does for CLODE_NODE and the security stub above
// — is where that knowledge belongs instead. This SUPERSEDES remembering
// CLODE_STATE_ROOT per test: every spawned `clode build` (subprocess) inherits it
// through `env: {...process.env, ...}`, and every IN-PROCESS `clodeBuild()` call
// whose test constructs its own env by spreading `...process.env` inherits it the
// same way — see test/clode-target-build.test.cjs and test/clode-manifest-fetch.
// test.cjs for the two tests that build a bare env object with NO such spread, and
// therefore still carry their own explicit override; this central default cannot
// reach a test that never reads process.env at all.
//
// THE OTHER EDGE, discovered verifying this fix: clode-paths.cjs's OWN documented
// precedence is CLODE_STATE_ROOT > XDG_* > HOME — so this ONE root, shared for the
// WHOLE suite, now outranks any individual test's own XDG_DATA_HOME/XDG_CACHE_HOME
// override, where before it did (because nothing ever set CLODE_STATE_ROOT
// ambiently). A test that relies on a FRESH, per-instance XDG_DATA_HOME to isolate
// something reached via clodeDataDir (host-provision.cjs's tool-discovery cache is
// the concrete case that broke: test/clode-update.test.cjs's "fails LOUD... no
// sha256 digest tool exists" started passing when it should not, because an
// EARLIER test's real tool discovery — now cached under this shared root instead
// of that test's own fixture dir — answered its deliberately-tool-less probe) must
// set its OWN CLODE_STATE_ROOT too (see test/clode-update.test.cjs and
// test/make-min-provider.test.cjs), not rely on XDG_* alone, once this file sets
// one centrally.
process.env.CLODE_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-test-state-'));

// A provider and an engine, resolved ONCE for the whole suite, the same way the
// central CLODE_STATE_ROOT and `security` stub above are set once here rather than
// remembered per test.
//
// WHY THIS IS HERE. Provider- and engine-gated tests were the suite's largest dark
// surface: 43 of 84 skips. They were not skipping because the artifacts were absent —
// this box has both — but because each test read an environment variable that nothing
// exports. A gate keyed to an undocumented env var is dark BY DEFAULT, and it reports
// that darkness in language ("no CLODE_PROVIDER_BIN", "no engine") that reads like an
// honest unavailability. Two other tests had the identical defect and were fixed the
// same day (test/graph-runner.test.cjs, test/tjs-bytecode-regen.test.cjs); this is the
// same fix, applied where it covers everything at once.
//
// An operator's own value always wins — if you exported one, you meant it. When
// nothing resolves we say so ONCE, here, instead of every gated test repeating a
// paragraph about where it looked.
//
// SEQUENCING, deliberately: setting this was tried once before (phase-2 Task 5) and
// WITHDRAWN, because waking 44 tests surfaced 14 failures from three causes that had
// nothing to do with the provider — zstd unreachable under a deliberately minimal
// PATH, an unbuilt naude bundle, and residual /$bunfs chunk edges. Those are fixed
// now, which is what makes this safe to set. Waking tests before their failures are
// understood buys a red suite and no information.
if (!process.env.CLODE_PROVIDER_BIN) {
  const { providerBin, skipReason, pinnedVersion } = require('./provider-resolve.cjs');
  let p = providerBin();
  // FETCH IF NEEDED. Selection is the pinned version exactly (see provider-resolve.cjs),
  // so a box without it tests nothing rather than testing whatever it happens to have.
  // Fetching once, here, is what makes "exactly the pin" a usable rule instead of a
  // chore — and it is loud, because a test run that reaches the network should say so.
  if (!p && pinnedVersion()) {
    const v = pinnedVersion();
    console.error(`run: pinned provider ${v} not in the store — fetching it once (clode fetch ${v})`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'clode'), 'fetch', v],
      { stdio: 'inherit' });
    if (r.status !== 0) console.error(`run: fetch failed (status ${r.status}); provider-gated tests will skip`);
    p = providerBin({ ...process.env });   // fresh env object: providers() memoises per env
  }
  if (p) {
    process.env.CLODE_PROVIDER_BIN = p;
    console.error(`run: provider ${p}`);
  } else {
    console.error(`run: no Claude provider resolved — ${skipReason()}`);
  }
}
// PRE-WARM THE ORACLE STAGE, ONCE, BEFORE ANY TEST FILE SPAWNS.
//
// test/oracle-models.cjs's stageCli extracts into a SHARED, provider-keyed cache
// (<CLODE_ORACLE_STAGE_ROOT|tmp>/clode-oracle-stage/<cacheKey>), deliberately, so a job
// pays one merge per provider instead of one per test file. But this runner spawns test
// files CONCURRENTLY, and libexec/clode-extract.cjs's extractIfNeeded is not atomic: it
// mkdirs the cache dir and writeFileSyncs straight into it, with no temp-and-rename. Its
// cache-hit guard needs a matching signature, so on a COLD cache two files both miss it
// and both write the same paths at the same time.
//
// That produced two load-only flakes, both green in isolation and both filed before the
// cause was known: node-shim-child-process's "Unexpected end of JSON input" (a read
// beating a write) and agentic-subagent-diff's "graph-meta failed (exit 1)" (a spawn over
// a tree still being written).
//
// Warming it here serialises the one write, so every concurrent reader afterwards takes
// the cache-hit path and nothing races. It also keeps the shared cache's whole point --
// one extraction per provider per run.
//
// This does NOT fix the underlying non-atomic extraction, which two concurrent
// `clode build`s would still hit. That is filed separately; this is the suite's half.
if (process.env.CLODE_PROVIDER_BIN) {
  try {
    const { stageCli } = require('./oracle-models.cjs');
    const t0 = Date.now();
    stageCli(process.env.CLODE_PROVIDER_BIN);
    console.error(`run: oracle stage warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    // Not fatal: a provider that cannot stage is a condition the gated tests report
    // themselves, with a better message than this could give.
    console.error(`run: could not pre-warm the oracle stage (${e && e.message}); `
      + 'provider-gated tests will report it');
  }
}

// A DARWIN-carved provider, for the one test that needs a specific carve rather than
// any provider (the macOS managed-settings branch check). Same reasoning as the two
// above: the artifact is on this box, and the test read an env var nothing sets. Note
// this is about the PROVIDER's carve, not this host's platform — the pinned provider in
// this store is a linux carve on a Mac, so asking process.platform would be wrong.
if (!process.env.CLODE_DARWIN_PROVIDER_BIN) {
  const { providerBinFor } = require('./provider-resolve.cjs');
  const d = providerBinFor('darwin');
  if (d) process.env.CLODE_DARWIN_PROVIDER_BIN = d;
}

if (!process.env.CLODE_TJS) {
  const { tjsPath } = require('./node-shim-helper.cjs');
  const t = tjsPath();
  if (t) process.env.CLODE_TJS = t;
  else console.error('run: no tjs engine resolved (CLODE_TJS unset and no platform-tagged '
    + 'scratch engine) — engine-gated tests will skip. Build one: node scripts/build-tjs.mjs');
}

// Platform-tagged harness dir + NODE_PATH (path.delimiter, NOT a hardcoded ':').
// Resolved through harnessDir(), not hand-joined: every OTHER caller (test/tui-screen.cjs,
// test/node-shim-tty-helper.cjs, scripts/tui-probe.mjs) already resolves node-pty through
// harnessDir(REPO), so installing anywhere else here would silently orphan the install
// this script performs from the location those callers actually look in.
const { harnessDir } = require('../scripts/platform-tag.cjs');
const HARNESS = harnessDir(ROOT);
process.env.NODE_PATH = [path.join(HARNESS, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean).join(path.delimiter);

// npm via its own npm-cli.js under THIS node (cross-platform; no npm/.cmd/shell) — same
// approach as scripts/build-clode-main.mjs.
function npmCliPath() {
  const d = path.dirname(process.execPath);
  const found = [
    path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'),              // Windows dist layout
    path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX dist layout
  ].find((p) => fs.existsSync(p));
  if (!found) throw new Error(`run: could not locate npm-cli.js next to ${process.execPath}`);
  return found;
}

function harnessOk() {
  return spawnSync(process.execPath, [path.join('test', 'harness-preflight.cjs')], { stdio: 'ignore' }).status === 0;
}

// Install the PTY/TUI harness into the tagged dir if preflight fails, then re-check.
// The harness (node-pty, a native addon) is REQUIRED, not optional — a missing
// node-pty must never SILENTLY drop PTY/TUI coverage. node-pty doesn't ship a
// __NetBSD__ forkpty branch, so we install sources WITHOUT the native build
// (--ignore-scripts), patch deps for platforms upstream omits (test/harness-patch.cjs),
// THEN build the addons. If it still can't build, that's a LOUD hard failure to fix,
// not a skip.
if (!harnessOk()) {
  console.error(`run: installing PTY test harness deps into ${HARNESS} ...`);
  fs.mkdirSync(HARNESS, { recursive: true });
  fs.copyFileSync(path.join('test', 'package.json'), path.join(HARNESS, 'package.json'));
  const lock = path.join('test', 'package-lock.json');
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(HARNESS, 'package-lock.json'));
  const { patchNodePty } = require('./harness-patch.cjs');
  // HARNESS resolves off-tree (harnessDir() -> buildPath(), same as the toolchain
  // dir below) — a version-manager shim (asdf/mise/volta) resolving `node` by
  // walking up from cwd finds nothing there and exits 126 partway through npm's own
  // lifecycle/rebuild scripts. envWithRealNodeOnPath sidesteps every manager's shim
  // by putting the ALREADY-RUNNING real node's dir first on PATH — see
  // scripts/lib/npm-cli.cjs for the full rationale and the proof this reproduces on
  // this box (`cd <scratch> && sh -c "node -v"` exits 126; from inside the checkout
  // it does not). node-pty ships prebuilds, so a broken rebuild here degrades
  // silently on most hosts, but NOT everywhere: test/harness-patch.cjs exists
  // precisely because NetBSD has none, where this would be fatal instead.
  const { envWithRealNodeOnPath } = require('../scripts/lib/npm-cli.cjs');
  const harnessEnv = envWithRealNodeOnPath(process.env);
  try {
    execFileSync(process.execPath, [npmCliPath(), 'install', '--ignore-scripts'],
      { cwd: HARNESS, stdio: 'inherit', env: harnessEnv });
    patchNodePty(HARNESS);   // idempotent; adds the __NetBSD__ branch before the build
    execFileSync(process.execPath, [npmCliPath(), 'rebuild'], { cwd: HARNESS, stdio: 'inherit', env: harnessEnv });
  } catch (e) {
    console.error(`run: PTY test harness install/build failed: ${e && e.message}`);
  }
  if (!harnessOk()) {
    console.error('run: PTY test harness (node-pty) is REQUIRED but could not be built.\n' +
      '     Fix the node-pty build for this platform — do NOT skip PTY coverage.\n' +
      '     If upstream lacks a branch for this OS, extend test/harness-patch.cjs.');
    process.exit(2);
  }
}

// Pre-build the esbuilt bundles (build/bundle/{clode-main,naude-entry}.bundle.cjs) that
// test/quaude-naude-updateguard.test.cjs's naude tests require, BEFORE `node --test`
// starts. test/build-clode-main.test.cjs also exercises scripts/build-clode-main.mjs for
// real, as one of the suite's own tests, and used to be this file's only source — but
// node's test runner runs test FILES concurrently with no ordering guarantee, so
// relying on that test having already finished by the time a naude test needs the
// bundle is a race, not a guarantee. It lost that race here: naude tests failed with
// `build-naude: --bundle not found: ... Pre-build it with 'node scripts/build-clode-
// main.mjs'` — a missing prerequisite, not a product defect. Building it up front (fast:
// ~2s once the esbuild toolchain is installed) removes the race instead of hoping to
// win it; build-clode-main.test.cjs still re-derives it for real and is unaffected by
// finding it already fresh.
const NAUDE_BUNDLE = path.join('build', 'bundle', 'naude-entry.bundle.cjs');
const MAIN_BUNDLE = path.join('build', 'bundle', 'clode-main.bundle.cjs');
if (!fs.existsSync(NAUDE_BUNDLE) || !fs.existsSync(MAIN_BUNDLE)) {
  console.error('run: pre-building build/bundle/*.bundle.cjs (node scripts/build-clode-main.mjs) ...');
  execFileSync(process.execPath, [path.join('scripts', 'build-clode-main.mjs')], { stdio: 'inherit' });
}

// Hermetic guard (pure node; required in-process). Watch the real dirs a test must never touch.
const guard = require('./hermetic-guard.cjs');
const tree = require('./tree-guard.cjs');
const { resolveAllowList, sourceContainsWrite } = require('./allow-list.cjs');
const home = os.homedir();
const dataBase = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const cacheBase = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
const REAL_STORE = path.join(dataBase, 'clode');
// The repo's OWN build/ dir used to be watched here too (ignoring only the `bundle`
// sub-corner) — it is now covered instead by the whole-checkout tree-immutability gate
// below, which allows only build/bundle and build/clode-* (the sanctioned copy-back
// targets — narrowed off a bare 'build' in Finding 3, so build/toolchain or build/tjs
// REAPPEARING there is caught, not waved through). Keeping both would just watch the
// same directory twice under two different exclusion shapes. What remains here is
// EXTERNAL real state a test must never touch, which the whole-checkout gate (rooted
// at ROOT) cannot see at all.
//
// Every exclusion below is a RECORD ({ pattern, because, provenBy }), resolved through
// allow-list.cjs, not a bare string — a bare string can only be REPORTED on, never
// independently checked, which is how REAL_STORE/build-trace.jsonl got exempted in
// phase 2's Task 3 BEFORE the writer it exempts existed: from the moment the writer
// landed, every leak into that file was pre-authorised, silently, because we had told
// the guard to be silent about it. A record that can't prove its own exemption is a
// FINDING, and resolveAllowList DROPS it rather than applying it anyway — see
// test/allow-list.test.cjs. A finding here is fatal (resolveOrDie below): a guard
// config that cannot prove its own exemptions is not safe to run at all.
function resolveOrDie(entries, label) {
  const { patterns, findings } = resolveAllowList(entries);
  if (findings.length) {
    console.error(`run: ${label} allow-list entry(ies) failed to prove themselves — dropped, not applied:`);
    for (const f of findings) console.error(`    ${f}`);
    process.exit(2);
  }
  return patterns;
}

// Every *.cjs/*.mjs file under the given top-level dirs (recursively — libexec/ and
// scripts/ both nest subdirs, e.g. libexec/node-shim/, scripts/lib/), relative to ROOT.
// Reuses tree.walk (already required above) instead of a second hand-rolled recursive
// walker, and its `fsm` param so a provenBy can inject a fake tree for testing.
function listSourceFiles(dirs, fsm) {
  const out = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    for (const rel of tree.walk(abs, { fsm }).keys()) {
      if (/\.(cjs|mjs)$/.test(rel)) out.push(path.join(abs, rel));
    }
  }
  return out;
}
const WRITE_FNS = ['writeFileSync', 'symlinkSync', 'copyFileSync', 'cpSync', 'renameSync', 'appendFileSync'];

const CACHE_CLODE_ALLOW = [
  {
    pattern: 'tjs-vendor',
    because: 'test/tjs-darwin-poll-fixup.test.cjs runs `node scripts/build-tjs.mjs '
      + '--source-only` ON PURPOSE — its own header says it "resets the shared vendor '
      + 'checkout to pristine and re-applies every patch + fixup". Rewriting '
      + 'tjs-vendor/txiki.js IS that test, not a violation of it.',
    provenBy: () => {
      const p = path.join(ROOT, 'test', 'tjs-darwin-poll-fixup.test.cjs');
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('--source-only');
    },
  },
  {
    pattern: 'scratch',
    because: "build-scratch.cjs's scratchCandidates() names <cacheBase>/clode/scratch as "
      + 'the last-resort allocator candidate — the one that gets used on exactly the '
      + 'machines that need it (a hardened guest, a noexec /tmp, or no TMPDIR at all). '
      + 'Without this, a suite run on such a machine would report a HERMETICITY '
      + 'VIOLATION for the allocator doing precisely what this phase told it to do — '
      + 'silent today only because TMPDIR wins the candidate race on every box that has '
      + 'run this suite so far.',
    provenBy: () => {
      const p = path.join(ROOT, 'scripts', 'build-scratch.cjs');
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes("'clode', 'scratch'");
    },
  },
];
// REAL_STORE itself carries NO exclusion: phase 2's central CLODE_STATE_ROOT (set once,
// above) means nothing legitimately appends to the real store during a suite run — including
// clode-paths.cjs's traceLog(), which resolves through clodeDataDir() and therefore
// honors CLODE_STATE_ROOT like every other state path. A leak here is real and must
// fail loud, not be waved through by an exemption written before its writer existed.
const LOCAL_BIN_ALLOW = [
  {
    pattern: 'claude',
    because: 'clode never creates or modifies ~/.local/bin/claude — this project\'s '
      + 'standing rule is that our command is `clode`; we never install, name, or '
      + 'replace anything called `claude` (see BACKLOG.md/"always clode, never '
      + 'claude"). That path is owned by the OPERATOR\'S OWN native Claude Code '
      + 'launcher, which auto-updates on its own schedule, independent of anything '
      + 'this repo does — observed directly: this box\'s native install went '
      + '2.1.260 (2026-09-03 19:58) -> 2.1.261 (2026-09-04 16:08:18) DURING a full '
      + 'suite run, re-pointing the symlink mid-run (mtime 16:27) and tripping a '
      + 'HERMETICITY VIOLATION that named no leak in this repo\'s code — a red '
      + 'carrying no information about us, from watching a file we do not own.',
    provenBy: (fsm) => {
      // Scans libexec/ and scripts/ (recursively — see listSourceFiles) for a file
      // that BOTH calls one of WRITE_FNS AND spells out '.local', 'bin', and
      // 'claude' as literal strings — the shape an obvious future writer of this
      // exact path would take. This is sourceContainsWrite's heuristic (see its own
      // header in allow-list.cjs for what it does and does NOT cover: it misses a
      // leaf built from a variable/constant, a write done via a spawned external
      // command instead of an fs.* call, and anything outside libexec/+scripts/).
      // It cannot prove clode will never gain such a writer; it CAN and WILL flip
      // this entry's provenBy to false — dropping the exemption — the moment one is
      // added in the naive, literal-path shape, which is the realistic case: no
      // code in this repo has ever had a reason to hardcode the string 'claude'
      // next to a write call, because our command is 'clode'.
      const files = listSourceFiles(['libexec', 'scripts'], fsm);
      const hit = sourceContainsWrite(files, {
        writeFns: WRITE_FNS,
        pathLiterals: ["'.local'", "'bin'", "'claude'"],
        fsm,
      });
      return !hit.found;
    },
  },
];
const GUARD_WATCH = [
  REAL_STORE,
  { path: path.join(cacheBase, 'clode'), ignore: resolveOrDie(CACHE_CLODE_ALLOW, 'GUARD_WATCH cache/clode') },
  { path: path.join(home, '.local', 'bin'), ignore: resolveOrDie(LOCAL_BIN_ALLOW, 'GUARD_WATCH .local/bin') },
];
if (guard.preflight(REAL_STORE).length) {
  console.error(`run: REAL store contaminated with *-clode-test deps under ${REAL_STORE}`);
  process.exit(2);
}
const before = guard.snapshot(GUARD_WATCH);

// Whole-checkout tree-immutability gate (Task 8): the property under test is "a
// build/test writes nothing into the source tree", and watching only the directory
// we happen to expect writes in (as GUARD_WATCH's old build/ entry did) is how a
// guard ends up structurally unable to fail anywhere else. This walks the ENTIRE
// checkout — libexec/, scripts/, deps/, spike/, everything — not just build/.
//
// Every TREE_ALLOW entry is an intentional, individually-justified exception; an
// unexplained entry here is exactly the exempt-by-name pattern this phase exists to
// remove, so a reviewer must be able to tell an intentional exclusion from a
// swept-under-the-rug one without archaeology (`tree` itself is required once, above,
// alongside the other guard modules):
// Every TREE_ALLOW entry is a RECORD ({ pattern, because, provenBy }) resolved through
// allow-list.cjs, not a bare string — an unexplained or unprovable entry here is exactly
// the exempt-by-name pattern this phase exists to remove, so a reviewer must be able to
// tell an intentional exclusion from a swept-under-the-rug one without archaeology, and
// resolveOrDie (defined above) refuses to run at all if one can't prove itself.
const TREE_ALLOW_ENTRIES = [
  {
    pattern: '.git',
    because: 'git refreshes its own index on plain read-only commands (status, diff, log); '
      + 'that is git doing its job, not a test/build writing into the checkout.',
    provenBy: () => fs.existsSync(path.join(ROOT, '.git')),
  },
  {
    pattern: 'build/bundle',
    because: "The sanctioned copy-back target for a FINISHED, shippable artifact — see "
      + "scripts/platform-tag.cjs's file header and artifactDir(): \"if it's in "
      + "build/clode-*, it's shippable\" is the whole contract that dir exists to serve. "
      + 'Everything else that used to live under build/ (the toolchain cache, the tjs '
      + 'engine template, the harness) is SCRATCH and has moved off through buildPath() '
      + 'as of this task — build/ now holds only artifact dirs (and build/bundle, the '
      + 'platform-independent esbuilt bundle scripts/build-clode-main.mjs declares as its '
      + 'own documented output dir).',
    provenBy: () => {
      const p = path.join(ROOT, 'scripts', 'build-clode-main.mjs');
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes("'build', 'bundle'");
    },
  },
  {
    pattern: 'build/clode-*',
    because: "Named ONLY the two shapes that are actually real outputs on disk (Finding 3): "
      + "build/clode-* (one dir per host/version — artifactName()'s local shape, or CI's "
      + "CLODE_ASSET_NAME override, both always prefixed 'clode-', see canonical-name.cjs's "
      + 'assetName()) and build/bundle (the unkeyed esbuilt bundle). A bare \'build\' here '
      + "was blind to build/toolchain/ or build/tjs/ REAPPEARING — a regression of THIS "
      + "PHASE'S OWN migration off of them, which is the single thing this gate most ought "
      + 'to catch. naude/quaude are NOT separate top-level build/ dirs — they are files '
      + "INSIDE a build/clode-*/ artifact dir (seaOut()), already covered by this entry.",
    provenBy: () => typeof require('../scripts/platform-tag.cjs').artifactDir === 'function',
  },
  {
    pattern: 'node_modules',
    because: 'A developer/editor-tooling install target (this project ships zero runtime '
      + 'dependencies — see the repo\'s "Zero dependencies" doctrine — so clode itself never '
      + 'populates a root node_modules/, but the directory is gitignored and excluded here '
      + 'defensively so an incidental local `npm install` for tooling never trips the gate). '
      + 'Always true — there is no writer to prove, only a promise the repo itself never '
      + 'creates one.',
    provenBy: () => true,
  },
  {
    pattern: '.superpowers',
    because: 'Scratch for the plan-execution machinery: reports and ledger entries under '
      + '.superpowers/sdd/. It hides from git via a self-planted .superpowers/sdd/.gitignore '
      + 'containing `*` — worth knowing, because `git check-ignore` on the top directory '
      + 'reports NOT ignored and the mechanism is otherwise unguessable. This gate walks the '
      + 'FILESYSTEM, not git, so the entry is required whenever a plan is being executed, and '
      + 'a plan can be executed at any time — it is a standing exception, not a temporary '
      + 'one. Moving the workspace out of the checkout would desync the tooling\'s own '
      + 'scripts from where they read and write it.',
    provenBy: () => fs.existsSync(path.join(ROOT, '.superpowers')),
  },
  {
    pattern: 'test/.harness',
    because: 'The PTY/TUI native-addon test-harness cache. harnessDir() itself resolves '
      + 'through buildPath() (out of the checkout), so a fresh install no longer lands here '
      + '— but this directory predates that move and may still exist on disk (gitignored) '
      + "from before it, on any box that ran the suite pre-migration. Excluded so the gate's "
      + 'verdict never depends on whether that leftover directory happens to be present. '
      + 'Always true — it is a pre-migration leftover, not something a current run creates.',
    provenBy: () => true,
  },
  // 'docs' was considered and DELIBERATELY NOT added here (round 1 of this task added
  // it, then reverted it — see BACKLOG.md/task-5-report.md, 2026-09-04). It has the
  // exact build-trace.jsonl shape this task exists to eliminate: no writer under
  // docs/ ever runs during a suite (grep across test/, libexec/, scripts/ turns up
  // only prose mentioning the path in comments, never a write), its `because` argued
  // from a hypothetical ("a plan might be written mid-run"), and its `provenBy` could
  // only prove the directory exists — which it always will, so it could never drop.
  // An exemption for a writer that doesn't exist, with a proof that can't fail, is an
  // exemption that's already lying before the first suite run. If a plan is ever
  // authored into docs/ while this suite is running, the resulting tree-immutability
  // violation is CORRECT — the fix is to not write there mid-run, not to re-add this.
];
const TREE_ALLOW = resolveOrDie(TREE_ALLOW_ENTRIES, 'TREE_ALLOW');
const treeBefore = tree.walk(ROOT, { ignore: TREE_ALLOW });

// Run the node tests: discover test/**/*.test.cjs (no shell glob) and run under THIS
// node. Recurses into subdirectories so test/fidelity/ is GATED like everything else —
// it was silently unreachable while the RECIPE audit reported its rows as guarded,
// which is precisely the "we ship it, so CI gates it" rule being violated in the dark.
// Exclude dotfiles (leading '.') to match the POSIX glob's default — e.g. gitignored
// AppleDouble `._*.test.cjs` sidecars must NOT be picked up as test modules — and
// dot-directories (test/.harness) for the same reason.
function discoverTests(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...discoverTests(p)); }
    else if (e.name.endsWith('.test.cjs')) out.push(p);
  }
  return out;
}
const files = discoverTests('test').sort();

// Discovery floor: zero files means the glob/path logic itself regressed (e.g. a
// `discoverTests` bug, or test/ moved) — spawning bare `node --test` with no file
// args would silently fall back to Node's OWN default test-file discovery instead
// of failing, masking exactly the kind of regression this check exists to catch.
// Distinct message from "tests failed" on purpose (see the floor check below).
if (files.length === 0) {
  console.error('run: test discovery found ZERO files under test/**/*.test.cjs — this is a '
    + 'DISCOVERY regression (a glob/path bug), not "no tests to run". Fix discoverTests() '
    + 'or the test/ layout before trusting any exit code from this runner.');
  process.exit(2);
}

// EVIDENCE floor (as opposed to every other ratchet in this repo, which checks
// SHAPE): tonight `npm test` exited 126 having run ZERO tests — an asdf Node pin
// Renovate had bumped wasn't installed locally, so `node --test ...` itself never
// executed a single test — and that superficially read as success because nothing
// downstream checked the COUNT, only glanced at "did it blow up". A suite that
// never ran must be exactly as loud as a suite that failed, and the message must
// say WHICH one happened — silently treating "nothing ran" as "nothing failed" is
// the bug. Ask Node's own test-reporter for a parseable summary (a 2nd `tap`
// reporter writing to a tmp file) alongside the SAME reporter+destination Node
// would have picked with plain `stdio:'inherit'` (spec on a TTY, tap otherwise) —
// so a human sees byte-identical output to before, and we additionally get a
// `# tests N` line to floor-check without changing what anyone sees on a healthy
// run.
const tapCopy = path.join(os.tmpdir(), `clode-test-run-${process.pid}.tap`);
const res = spawnSync(process.execPath, [
  '--test',
  '--test-reporter', process.stdout.isTTY ? 'spec' : 'tap',
  '--test-reporter-destination', 'stdout',
  '--test-reporter', 'tap',
  '--test-reporter-destination', tapCopy,
  ...files,
], { stdio: 'inherit' });
let fails = res.status === 0 ? 0 : 1;

let tapText = null;
try { tapText = fs.readFileSync(tapCopy, 'utf8'); } catch { /* runner never wrote it — handled below */ }
finally { try { fs.unlinkSync(tapCopy); } catch { /* best-effort cleanup */ } }
const testsRan = tapText ? tapText.match(/^# tests (\d+)/m) : null;
if (!testsRan) {
  console.error('run: could not read a test-run summary at all (no "# tests N" from node:test) — '
    + 'the runner may not have executed ANYTHING. Treating this as a hard failure, not a pass.');
  fails = 1;
} else if (Number(testsRan[1]) === 0) {
  console.error(`run: ZERO tests executed (discovered ${files.length} file(s) to run) — this is `
    + `a "nothing ran" failure, NOT the same thing as "tests failed" and NOT a pass. Check that `
    + `\`node\` (${process.execPath}) actually runs and that node:test can load these files — `
    + `e.g. an unbuilt asdf/nvm pin bump can make the whole invocation silently no-op.`);
  fails = 1;
}

// Postflight: no watched real dir changed, and the store still has no fake deps.
//
// DEV-BOX BLIND SPOT (cost a CI round-trip 2026-08-01, worth knowing before you
// trust a green local run): the sharpest violation this catches is
// `ABSENT -> created` on ~/.local/share/clode — and it can only catch that where
// the store does NOT already exist. On any machine that has ever run clode the
// store IS there, so a test that provisions into it (e.g. calling the real
// gunzipBuffer/sha256Of, which cache a resolved host tool there) changes nothing
// detectable and passes locally, then fails every fresh CI runner.
// Reproduce the CI condition before blaming CI:
//     HOME=$(mktemp -d) npm test
// then check the store did not appear:
//     ls -d "$HOME/.local/share/clode"
// (Unrelated fallout to expect from a fake HOME: the poll-backend fixup tests
// need the cached txiki tree and will fail; that is the harness, not your change.)
// The durable fix in a test is to INJECT the tool (see the `gunzip` injections in
// test/clode-templates.test.cjs and test/templates-blob-pack.test.cjs), never to
// widen the guard.
const after = guard.snapshot(GUARD_WATCH);
const changed = guard.diffSnapshots(before, after);
if (changed.length) {
  console.error('HERMETICITY VIOLATION — a test changed a real dir:');
  for (const c of changed) console.error('    ' + c);
  fails = 1;
}
if (guard.preflight(REAL_STORE).length) {
  console.error('HERMETICITY VIOLATION — a test seeded *-clode-test deps into the real store');
  fails = 1;
}

// Whole-checkout tree-immutability gate, after: anything created/modified/deleted
// under ROOT outside TREE_ALLOW is a build/test writing where the phase-1 property
// says it must not. Distinct exit code (2) from a plain test failure (1) so CI and a
// human glancing at `echo $?` can tell "the checkout got dirty" apart from "a test
// assertion failed" without re-reading the log.
const treeChanged = tree.diff(treeBefore, tree.walk(ROOT, { ignore: TREE_ALLOW }));
if (treeChanged.length) {
  console.error('run: the suite WROTE INTO THE CHECKOUT — a build/test must not:');
  for (const c of treeChanged.slice(0, 40)) console.error(`  ${c.kind} ${c.path}`);
  if (treeChanged.length > 40) console.error(`  … and ${treeChanged.length - 40} more`);
  process.exitCode = 2;
}

// Print the environment stamp WITH the verdict, on both the pass and fail paths — a
// stamp printed only at startup scrolls off before a multi-minute run's verdict prints,
// so the two are never quoted together. This is the exact defect that let two agents
// disagree about a baseline on identical commits for an afternoon (see
// test/environment-stamp.cjs's header). Best-effort fields: a value this process cannot
// determine reads as `unknown`, never omitted (environmentStamp's own contract).
{
  const { environmentStamp } = require('./environment-stamp.cjs');
  const { pinnedVersion } = require('./provider-resolve.cjs');
  let providerCarve = null;
  if (process.env.CLODE_PROVIDER_BIN) {
    try {
      providerCarve = require('../libexec/extract-claude-js.cjs')
        .providerPlatformOf(process.env.CLODE_PROVIDER_BIN);
    } catch { /* unreadable binary: stays unknown */ }
  }
  console.error(environmentStamp({
    execPath: process.execPath,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    pin: pinnedVersion(),
    providerCarve,
    engine: process.env.CLODE_TJS || null,
    gates: {
      ...(process.env.CLODE_OFFLINE ? { CLODE_OFFLINE: process.env.CLODE_OFFLINE } : {}),
      ...(process.env.CLODE_LIVE_RENDER ? { CLODE_LIVE_RENDER: process.env.CLODE_LIVE_RENDER } : {}),
      ...(process.env.CLODE_PROVIDER_BIN ? { CLODE_PROVIDER_BIN: process.env.CLODE_PROVIDER_BIN } : {}),
      ...(process.env.CLODE_DARWIN_PROVIDER_BIN
        ? { CLODE_DARWIN_PROVIDER_BIN: process.env.CLODE_DARWIN_PROVIDER_BIN } : {}),
      ...(process.env.CLODE_TJS ? { CLODE_TJS: process.env.CLODE_TJS } : {}),
    },
  }));
}
process.exit(process.exitCode === 2 ? 2 : (fails ? 1 : 0));
