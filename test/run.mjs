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

// Keychain gate: default CLODE_KC_MODE so the suite never touches the operator's
// REAL macOS login Keychain. libexec/node-shim/modules/child_process.cjs's
// `_kcDetect()` probes the REAL `security` binary (write/read/update/delete a
// throwaway item named `__clode_kc_probe__`) unless CLODE_KC_MODE is already set —
// node-shim-roundtrip.test.cjs and node-shim-roundtrip-oracle.test.cjs spawn tjs
// with an inherited env and no pinned mode, so an un-pinned run popped "Could not
// find a keychain to store '__clode_kc_probe__'" modal dialogs on every invocation
// (see task-10-report.md; the SEPARATE "naming the operator's real account" dialogs
// came from the naude-model side of node-shim-roundtrip-oracle.test.cjs, which runs
// under real node with no shim at all — CLODE_KC_MODE has no effect there, so that
// half is fixed in that file directly, via a PATH-shadowed `security` stub). Set
// here (not per-test) so it flows to every test file's `env: {...process.env, ...}`
// spawn automatically; an operator can still override by exporting CLODE_KC_MODE
// before invoking this runner — same opt-out shape as CLODE_LIVE_RENDER for the
// live-render TUI tests. Pure decision lives in scripts/kc-mode.cjs so it is
// unit-testable (see test/kc-mode-suite-default.test.cjs).
process.env.CLODE_KC_MODE = require('../scripts/kc-mode.cjs').defaultKcMode(process.env);

// Platform-tagged harness dir + NODE_PATH (path.delimiter, NOT a hardcoded ':').
const { platformTag } = require('../scripts/platform-tag.cjs');
const TAG = platformTag();
const HARNESS = path.join(ROOT, 'test', '.harness', TAG);
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
  console.error(`run: installing PTY test harness deps into test/.harness/${TAG} ...`);
  fs.mkdirSync(HARNESS, { recursive: true });
  fs.copyFileSync(path.join('test', 'package.json'), path.join(HARNESS, 'package.json'));
  const lock = path.join('test', 'package-lock.json');
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(HARNESS, 'package-lock.json'));
  const { patchNodePty } = require('./harness-patch.cjs');
  try {
    execFileSync(process.execPath, [npmCliPath(), 'install', '--ignore-scripts'], { cwd: HARNESS, stdio: 'inherit' });
    patchNodePty(HARNESS);   // idempotent; adds the __NetBSD__ branch before the build
    execFileSync(process.execPath, [npmCliPath(), 'rebuild'], { cwd: HARNESS, stdio: 'inherit' });
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

// Hermetic guard (pure node; required in-process). Watch the real dirs a test must never touch.
const guard = require('./hermetic-guard.cjs');
const home = os.homedir();
const dataBase = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const cacheBase = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
const REAL_STORE = path.join(dataBase, 'clode');
// Two of these watched roots have a build-owned scratch corner INSIDE them that a test
// legitimately (and on purpose) writes to; excluding just that corner, not the whole
// root, is what makes the walking guard (which can see three levels down, unlike the
// old mtimeMs-on-the-named-path version) usable at all. Everything else under each root
// is still watched in full.
const GUARD_WATCH = [
  REAL_STORE,
  // test/tjs-darwin-poll-fixup.test.cjs:29 runs `node scripts/build-tjs.mjs --source-only`
  // on purpose — its own header says it "resets the shared vendor checkout to pristine
  // and re-applies every patch + fixup". Rewriting tjs-vendor/txiki.js IS that test, not
  // a violation of it.
  { path: path.join(cacheBase, 'clode'), ignore: ['tjs-vendor'] },
  path.join(home, '.local', 'bin'),
  // scripts/build-clode-main.mjs:30 sets `build/bundle` as its declared, documented
  // output directory (unkeyed on purpose — see that file's own comment). Writing the
  // bundle there is the build doing its job, not a test touching state it shouldn't.
  { path: path.join(ROOT, 'build'), ignore: ['bundle'] },
];
if (guard.preflight(REAL_STORE).length) {
  console.error(`run: REAL store contaminated with *-clode-test deps under ${REAL_STORE}`);
  process.exit(2);
}
const before = guard.snapshot(GUARD_WATCH);

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

process.exit(fails ? 1 : 0);
