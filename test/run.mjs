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
const GUARD_WATCH = [
  // 'build-trace.jsonl' is ignored here: clode-paths.cjs's traceLog() names
  // <dataBase>/clode/build-trace.jsonl as the durable per-build timing log (Task 3,
  // 2026-09-02-phase2-name-the-steps) — it MUST survive across builds, so it lives in
  // the real HOME/XDG state dir on purpose, not in build scratch or the checkout.
  // Without this, a build appending a timing line to it (once Task 5 wires the writer
  // in) would report a HERMETICITY VIOLATION for doing precisely what this log exists
  // to do.
  { path: REAL_STORE, ignore: ['build-trace.jsonl'] },
  // test/tjs-darwin-poll-fixup.test.cjs:29 runs `node scripts/build-tjs.mjs --source-only`
  // on purpose — its own header says it "resets the shared vendor checkout to pristine
  // and re-applies every patch + fixup". Rewriting tjs-vendor/txiki.js IS that test, not
  // a violation of it.
  //
  // 'scratch' is ALSO ignored here: build-scratch.cjs's scratchCandidates() names
  // <cacheBase>/clode/scratch as the last-resort allocator candidate — the one that
  // gets used on exactly the machines that need it (a hardened guest, a noexec
  // /tmp, or no TMPDIR at all). Without this, a suite run on such a machine would
  // report a HERMETICITY VIOLATION for the allocator doing precisely what this
  // phase told it to do — silent today only because TMPDIR wins the candidate race
  // on every box that has run this suite so far.
  { path: path.join(cacheBase, 'clode'), ignore: ['tjs-vendor', 'scratch'] },
  path.join(home, '.local', 'bin'),
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
// swept-under-the-rug one without archaeology:
const tree = require('./tree-guard.cjs');
const TREE_ALLOW = [
  // git refreshes its own index on plain read-only commands (status, diff, log);
  // that is git doing its job, not a test/build writing into the checkout.
  '.git',
  // The sanctioned copy-back target for a FINISHED, shippable artifact — see
  // scripts/platform-tag.cjs's file header and artifactDir(): "if it's in
  // build/clode-*, it's shippable" is the whole contract that dir exists to serve.
  // Everything else that used to live under build/ (the toolchain cache, the tjs
  // engine template, the harness) is SCRATCH and has moved off through buildPath()
  // as of this task — build/ now holds only artifact dirs (and build/bundle, the
  // platform-independent esbuilt bundle scripts/build-clode-main.mjs declares as
  // its own documented output dir).
  //
  // Named ONLY the two shapes that are actually real outputs on disk (Finding 3):
  // build/clode-* (one dir per host/version — artifactName()'s local shape, or
  // CI's CLODE_ASSET_NAME override, both always prefixed 'clode-', see
  // canonical-name.cjs's assetName()) and build/bundle (the unkeyed esbuilt
  // bundle). A bare 'build' here was blind to build/toolchain/ or build/tjs/
  // REAPPEARING — a regression of THIS PHASE'S OWN migration off of them, which is
  // the single thing this gate most ought to catch. naude/quaude are NOT separate
  // top-level build/ dirs (grep confirms no build/naude, build/quaude path exists
  // anywhere in the tree) — they are files INSIDE a build/clode-*/ artifact dir
  // (seaOut()), already covered by the clode-* entry, so they get no entry of
  // their own.
  'build/bundle',
  'build/clode-*',
  // A developer/editor-tooling install target (this project ships zero runtime
  // dependencies — see the repo's "Zero dependencies" doctrine — so clode itself
  // never populates a root node_modules/, but the directory is gitignored and
  // excluded here defensively so an incidental local `npm install` for tooling
  // never trips the gate).
  'node_modules',
  // Scratch for the plan-execution machinery: reports and ledger entries under
  // .superpowers/sdd/. It hides from git via a self-planted .superpowers/sdd/
  // .gitignore containing `*` — worth knowing, because `git check-ignore` on the
  // top directory reports NOT ignored and the mechanism is otherwise unguessable.
  // This gate walks the FILESYSTEM, not git, so the entry is required whenever a
  // plan is being executed, and a plan can be executed at any time — it is a
  // standing exception, not a temporary one. (An earlier version of this comment
  // promised the directory was "deleted when the plan finishes"; that made the
  // entry look stale the moment a plan ended, which is how a named exception
  // decays into an unexplained one.) Moving the workspace out of the checkout
  // would desync the tooling's own scripts from where they read and write it.
  '.superpowers',
  // The PTY/TUI native-addon test-harness cache. As of this task harnessDir()
  // itself resolves through buildPath() (out of the checkout), so a fresh install
  // no longer lands here — but this directory predates that move and may still
  // exist on disk (gitignored) from before it, on any box that ran the suite
  // pre-migration. Excluded so the gate's verdict never depends on whether that
  // leftover directory happens to be present.
  'test/.harness',
];
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

process.exit(process.exitCode === 2 ? 2 : (fails ? 1 : 0));
