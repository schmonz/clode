'use strict';
// Unit tests for the JS launcher entry: bin/clode (ES5-safe prologue) +
// libexec/clode-main.cjs (the dispatch spine). Covers the print-and-exit paths
// (--version, --help) and the prologue's old-node floor guard. The
// full DEFAULT-launch wiring is smoke-tested separately (see the task's fixture
// smoke); the FULL bats parity gate runs against this same entry.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'clode');
const NODE = process.execPath;
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').replace(/\n+$/, '');

// Run the entry under the current node with a clean-ish env (empty
// DYLD_INSERT_LIBRARIES so the AVX shim never crashes a spawned node on old Macs).
// CLODE_WATCH_DIR defaults to a fresh private temp dir on every call: `clode watch`
// (below) unconditionally mkdir's its watch dir before it does anything else, and
// this file inherits process.env, so without an override a spawned `clode watch`
// would create the REAL ~/.cache/clode on the machine running the suite — exactly
// the hermeticity violation test/run.mjs's guard polices on a clean CI runner.
function runEntry(args, extraEnv) {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-main-test-watch-'));
  return spawnSync(NODE, [ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '', CLODE_WATCH_DIR: watchDir }, extraEnv || {}),
  });
}

test('--version prints "clode <VERSION>" from the VERSION file and exits 0', () => {
  const r = runEntry(['--version']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, `clode ${VERSION}\n`);
  assert.strictEqual(r.stderr, '');
});

test('--help prints clode-specific options and exits 0', () => {
  const r = runEntry(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /clode watch/);
  assert.match(r.stdout, /--verbose/);
  assert.match(r.stdout, /--version/);
  assert.match(r.stdout, /build a standalone Claude Code binary for your machine/);
  assert.match(r.stdout, new RegExp(`clode ${VERSION.replace(/\./g, '\\.')} —`));
  // ends with the last env-override line + trailing newline
  assert.ok(r.stdout.endsWith('post-update signals digest\n'));
});

test('the surface is unprefixed: --version/--help/--verbose', () => {
  // The prefix existed only to dodge Claude's argv under passthrough. No
  // passthrough, no prefix, no aliases.
  assert.match(runEntry(['--version']).stdout, /^clode \d/);
  assert.match(runEntry(['--help']).stdout, /clode build/);
  assert.strictEqual(runEntry(['--clode-version']).status, 2);
  assert.strictEqual(runEntry(['--clode-help']).status, 2);
});

test('watch is a subcommand, not a flag', () => {
  const r = runEntry(['watch']);
  assert.notStrictEqual(r.status, 2, 'watch must dispatch');
  assert.strictEqual(runEntry(['--clode-watch']).status, 2, '--clode-watch must no longer dispatch');
});

test('help advertises the builder surface and never mentions running Claude Code', () => {
  const { stdout } = runEntry(['--help']);
  // Task 7 rewrote the tagline and dropped the CLODE_ENGINE env-override line
  // (the runner they described no longer exists): no runner-framed prose survives.
  assert.doesNotMatch(stdout, /pass(es)? through|launch Claude Code \(|--self\b/i);
  assert.doesNotMatch(stdout, /clode update/, 'update is Phase 4 — do not promise it');
  assert.doesNotMatch(stdout, /CLODE_ENGINE/, 'the retired engine selector must not be advertised');
  assert.doesNotMatch(stdout, /runs? (the )?(latest )?Claude Code|under (a |the )?(host )?(Node|tjs)( runtime)?/i,
    'help must not frame clode as a runner');
  for (const cmd of ['build', 'fetch', 'watch']) assert.match(stdout, new RegExp('clode ' + cmd));
});

test('--help is dispatched only as the outer FIRST arg — not one level in', () => {
  // Proves the first-arg-only dispatch cuts both ways: '--help' only triggers
  // clode's own help when it IS the outer args[0]. Nested one level in (as a `build`
  // sub-argument) it is just an unrecognized build flag — and `build` is clode's own
  // namespace with NO passthrough (unlike a launch, which would forward an unknown
  // flag quietly): an unrecognized argument is a hard, immediate usage error. This
  // replaces the old proof-by-passthrough (running with no bin resolvable to show it
  // "fell through" to the default launch) now that the launch path is gone — `build`
  // gives the same first-arg-only proof without depending on it.
  const r = runEntry(['build', '--help']);
  assert.doesNotMatch(r.stdout || '', /Key environment overrides/);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr || '', /unknown argument '--help'/);
  assert.match(r.stderr || '', /usage: clode build/);
});

test('the ES5 prologue prints the exact floor message + exits 1 on an old node', () => {
  // Fake an old node by redefining process.versions.node BEFORE requiring the
  // entry, so the prologue's own floor check trips (the entry is required, not
  // spawned, so the fake version is in effect at prologue-eval time). The floor
  // is v20 for every command now — clode never runs the extracted bundle under
  // node (that died with the runner), so there is no higher-floor command left
  // to special-case; the old build-only v20/v24 split collapsed into one floor.
  const harness =
    "Object.defineProperty(process.versions,'node',{value:'18.0.0',configurable:true});" +
    `require(${JSON.stringify(ENTRY)});`;
  const r = spawnSync(NODE, ['-e', harness], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '' }),
  });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(
    r.stderr,
    'clode: node v18.0.0 is too old; need >= v20\n' +
    "clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n");
  assert.strictEqual(r.stdout, '');
});

test('the prologue floor is v20 end-to-end for `clode build` (fuse runs under tjs, not node)', () => {
  // `clode build` never runs the extracted bundle under node — the fuse
  // worker and the fused artifacts exec under tjs; node only orchestrates
  // file work. OpenIndiana packages node 20 and OpenBSD 7.9 node 22 (matrix
  // legs, dispatches #6/#14 2026-07-10) — the build path must clear the
  // prologue on both. CLODE_TJS points at a nonexistent template so the run
  // fails FAST and CONTROLLED after the gate (proof it got past the check).
  const harness =
    "Object.defineProperty(process.versions,'node',{value:'20.0.0',configurable:true});" +
    "process.argv=[process.argv[0],'clode','build'];" +
    `require(${JSON.stringify(ENTRY)});`;
  const r = spawnSync(NODE, ['-e', harness], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      DYLD_INSERT_LIBRARIES: '',
      CLODE_TJS: '/nonexistent/clode-test-tjs-template',
      // This is a valid `clode build` (past argv validation), so it fires the
      // watch trigger — not what this test is about, and without an override
      // it would phone home / touch the real cache dir (this harness inherits
      // process.env, unlike runEntry above). CLODE_NO_WATCH keeps it hermetic.
      CLODE_NO_WATCH: '1',
    }),
  });
  assert.strictEqual(r.status, 1);
  assert.doesNotMatch(r.stderr || '', /too old/);
  assert.match(r.stderr || '', /no tjs template at/);
});

test('the prologue keeps a floor for `clode build` too — v18 is refused', () => {
  const harness =
    "Object.defineProperty(process.versions,'node',{value:'18.19.0',configurable:true});" +
    "process.argv=[process.argv[0],'clode','build'];" +
    `require(${JSON.stringify(ENTRY)});`;
  const r = spawnSync(NODE, ['-e', harness], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '' }),
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr || '', /node v18\.19\.0 is too old; need >= v20/);
});

test('--clode-internal-update refuses when the environment has no target to update', () => {
  // A real, LOCAL (file://) releases fixture — the bug this guards against is that
  // clodeUpdate can genuinely SUCCEED (fetch + verify + re-point `current`) and
  // still leave a baked target's old bytecode running. Proving the refusal fires
  // means proving it fires even when the fetch it preempts would have worked.
  // Here bare `clode` (not a built quaude/naude) invokes --clode-internal-update:
  // CLODE_TARGET_KIND / CLODE_TARGET are unset, so targetUpdate must refuse
  // BEFORE ever touching the fetch/build/swap path. Every piece of clode state
  // (providers store, signals snapshot dir, settings HOME) is redirected into
  // this test's own tmpdirs — a fetch that "succeeds" here must never touch the
  // real ~/.local/share/clode or this repo's signals/.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-'));
  const releases = path.join(tmp, 'repo');
  const V = '9.9.9';
  const PLAT = 'linux-x64';
  const platDir = path.join(releases, V, PLAT);
  fs.mkdirSync(platDir, { recursive: true });
  const providerSrc = path.join(platDir, 'claude');
  fs.writeFileSync(providerSrc, 'clode-test fixture provider, never executed\n');
  const sum = crypto.createHash('sha256').update(fs.readFileSync(providerSrc)).digest('hex');
  fs.writeFileSync(path.join(releases, 'latest'), V + '\n');
  fs.writeFileSync(path.join(releases, V, 'manifest.json'),
    `{"platforms":{"${PLAT}":{"checksum":"${sum}"}}}\n`);

  const r = runEntry(['--clode-internal-update'], {
    CLODE_RELEASES_URL: pathToFileURL(releases).href,
    CLODE_FETCH_PLATFORM: PLAT,
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-state-')),
    CLODE_SIGNALS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-signals-')),
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-home-')),
    CLODE_TARGET_KIND: '',
    CLODE_TARGET: '',
  });
  assert.notStrictEqual(r.status, 0, 'must not report success for an update it cannot perform');
  assert.match(r.stderr, /CLODE_TARGET_KIND/);
  // The bug being prevented: fetching a provider is NOT updating a baked target.
  assert.doesNotMatch(r.stdout + r.stderr, /now the active provider/,
    'a baked target still runs its OLD bytecode after a fetch — never claim otherwise');
});

test('clodeHelp() interpolates the version and is newline-terminated', () => {
  const { clodeHelp } = require('../libexec/clode-main.cjs');
  const text = clodeHelp('9.9.9');
  assert.ok(text.startsWith('clode 9.9.9 — '));
  assert.ok(text.endsWith('post-update signals digest\n'));
  assert.match(text, /clode watch/);
  assert.doesNotMatch(text, /--clode-watch|--self/);
});
