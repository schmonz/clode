'use strict';
// Unit tests for the JS launcher entry: scripts/stage0.mjs (ES5-safe prologue) +
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

// The CLI surface as DATA (task 5): the help assertions below read this table rather
// than pinning the text it renders.
const { SURFACE, TAGLINE, renderHelp, surfaceFor } = require('../libexec/cli-surface.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'stage0.mjs');
const NODE = process.execPath;
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').replace(/\n+$/, '');
const FAKE_VERSION_PRELOAD = path.join(__dirname, 'fixtures', 'fake-node-version-preload.cjs');

// Spawn ENTRY for real (the normal `node <file>` dispatch, not require()), with
// process.versions.node overridden via a --require preload (test/fixtures/
// fake-node-version-preload.cjs) that runs before ENTRY is loaded, regardless
// of ENTRY's module type. This is deliberately NOT `require(ENTRY)` inside a
// `-e` harness: since ENTRY is ESM, require()-ing it depends on the SPAWNING
// node's own require(esm) support (added well after — and unrelated to — the
// v20 floor this exercises), so that technique would silently start testing
// "does the test runner's node support require(esm)" instead of "does the
// floor check work", and would throw a confusing ERR_REQUIRE_ESM on any
// somewhat-older runner rather than the floor message under test. Measured:
// real Node 18.20.8 (this box, via asdf) can run scripts/stage0.mjs directly
// and gets the exact same floor message as the current interpreter; it
// cannot require() it (ERR_REQUIRE_ESM). This helper avoids that gap entirely
// by never using require() on ENTRY.
function runEntryWithFakeVersion(fakeVersion, args, extraEnv) {
  return spawnSync(NODE, ['--require', FAKE_VERSION_PRELOAD, ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      DYLD_INSERT_LIBRARIES: '',
      CLODE_TEST_FAKE_NODE_VERSION: fakeVersion,
    }, extraEnv || {}),
  });
}

// Run the entry under the current node with a clean-ish env (empty
// DYLD_INSERT_LIBRARIES so the AVX shim never crashes a spawned node on old Macs).
// CLODE_WATCH_DIR defaults to a fresh private temp dir on every call: the update-signal
// cycle (`clode read-anthropic-tea-leaves`, below) unconditionally mkdir's its watch dir
// before it does anything else, and this file inherits process.env, so without an
// override a spawned one would create the REAL ~/.cache/clode on the machine running the
// suite — exactly the hermeticity violation test/run.mjs's guard polices on a clean CI
// runner.
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
  // READS THE TABLE, does not pin strings (task 5). Every line of help is rendered
  // from libexec/cli-surface.cjs's SURFACE literal, so pinning the text here would
  // re-create in the test suite exactly the duplication the table removed — and it
  // would pin it WRONG: the strings this test used to name ('clode watch', the
  // trailing env-override line) are the two the table changed.
  for (const verb of Object.keys(SURFACE.verbs)) {
    assert.match(r.stdout, new RegExp(`clode ${verb}`), `help must document ${verb}`);
  }
  for (const global of Object.keys(SURFACE.globals)) {
    assert.ok(r.stdout.includes(global), `help must document the global ${global}`);
  }
  assert.ok(r.stdout.startsWith(`clode ${VERSION} — ${TAGLINE}\n`), 'header = version + tagline');
  for (const entry of SURFACE.env) {
    assert.ok(r.stdout.includes(entry.name), `help must document ${entry.name}`);
  }
  // help ends with the last line of the last block the TABLE defines — the verb-neutral
  // environment overrides when there are any, else the globals — plus a newline.
  const globals = Object.keys(SURFACE.globals);
  const tail = SURFACE.env.length ? SURFACE.env[SURFACE.env.length - 1].name : globals[globals.length - 1];
  const lastLine = r.stdout.replace(/\n$/, '').split('\n').pop();
  assert.match(lastLine, new RegExp(`^\\s*${tail}\\s`));
  assert.ok(r.stdout.endsWith('\n'));
});

test('the surface is unprefixed: --version/--help/--verbose', () => {
  // The prefix existed only to dodge Claude's argv under passthrough. No
  // passthrough, no prefix, no aliases.
  assert.match(runEntry(['--version']).stdout, /^clode \d/);
  assert.match(runEntry(['--help']).stdout, /clode build/);
  assert.strictEqual(runEntry(['--clode-version']).status, 2);
  assert.strictEqual(runEntry(['--clode-help']).status, 2);
});

test('reading the tea leaves is a subcommand, not a flag — and `watch` is neither', () => {
  // It was `--clode-watch`, then `clode watch`, and task 6 renamed it to what it
  // actually does. All three statements are here because each retired spelling has
  // been a live regression at some point: the flag, the short verb, and (the one this
  // test would otherwise stop checking) that the verb still DISPATCHES at all.
  const r = runEntry(['read-anthropic-tea-leaves'], { CLODE_CHANGELOG_URL: 'file:///nonexistent/CHANGELOG.md' });
  assert.notStrictEqual(r.status, 2, 'read-anthropic-tea-leaves must dispatch');
  assert.strictEqual(runEntry(['--clode-watch']).status, 2, '--clode-watch must no longer dispatch');
  assert.strictEqual(runEntry(['watch']).status, 2, '`watch` is gone (task 6)');
});

test('help advertises the builder surface and never mentions running Claude Code', () => {
  const { stdout } = runEntry(['--help']);
  // Task 7 rewrote the tagline and dropped the CLODE_ENGINE env-override line
  // (the runner they described no longer exists): no runner-framed prose survives.
  assert.doesNotMatch(stdout, /pass(es)? through|launch Claude Code \(|--self\b/i);
  assert.doesNotMatch(stdout, /clode update/, 'update is Phase 4 — do not promise it');
  // Word-boundary, not a bare substring: phase 3b task 2 absorbed CLODE_ENGINE_RECIPE (a
  // real, currently-read build input, unrelated to the retired runner-engine selector this
  // assertion guards against) onto the surface, and `_` is a word character — \b does not
  // match between CLODE_ENGINE and _RECIPE, so this still fires only for the exact retired
  // name.
  assert.doesNotMatch(stdout, /\bCLODE_ENGINE\b/, 'the retired engine selector must not be advertised');
  assert.doesNotMatch(stdout, /runs? (the )?(latest )?Claude Code|under (a |the )?(host )?(Node|tjs)( runtime)?/i,
    'help must not frame clode as a runner');
  // Task 5: the verbs come from the table, so this cannot go stale when one is
  // renamed (it did: `watch` is `read-anthropic-tea-leaves` now).
  for (const verb of Object.keys(SURFACE.verbs)) assert.match(stdout, new RegExp('clode ' + verb));
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
  assert.ok(!(r.stdout || '').includes(TAGLINE), "clode's own help must not be printed");
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr || '', /unknown argument '--help'/);
  assert.match(r.stderr || '', /usage: clode build/);
});

// FIX ROUND 1 (coordinator, Important 3): the four spellings --help started advertising
// in task 5 had NO committed test that they dispatch. Help promising a command that does
// not route is worse than not promising it, and "the table matches the accepted argv" was
// only asserted against parseArgv in isolation — while the CLI deliberately discards
// parseArgv's flag-level error (each verb's module owns its own argv). These drive the
// real entry point, and each fails fast on a controlled error rather than doing the work:
// no network, no cache writes, no build.

test('the table spelling `build quaude` reaches the quaude build', () => {
  // CLODE_TJS points at a nonexistent template, so the quaude path fails FAST and
  // CONTROLLED — and that message is only reachable from the quaude blobulate path (a
  // naude build resolves pinned NODEs, never a tjs template), so it IS the proof of
  // where the subject routed. CLODE_NO_WATCH keeps the (valid) build from phoning home.
  const r = runEntry(['build', 'quaude'], {
    CLODE_TJS: '/nonexistent/clode-test-tjs-template',
    CLODE_NO_WATCH: '1',
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bq-state-')),
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr || '', /no tjs template at/);
  assert.doesNotMatch(r.stderr || '', /unknown argument 'quaude'/,
    'the subject must be consumed by dispatch, never forwarded to the build parser');
});

test('the table spelling `build naude` reaches the naude build, and `quaude` is not a flag', () => {
  // TASK 6 rewrote this test's MECHANISM, not its claim. It used to prove the routing
  // with the `--self and --naude are different build targets` conflict; both flags are
  // gone, and so is the conflict (one product parameter cannot contradict itself). The
  // proof now is the message PREFIX, which names the product the build resolved to —
  // 'build naude' only ever comes from the naude branch — reached by a controlled
  // failure (no binary to build from) before any work, network or cache write.
  const controlled = () => ({
    CLODE_CLAUDE_BIN: '/nonexistent/clode-test-claude',
    CLODE_NO_WATCH: '1',
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bn-state-')),
    CLODE_CACHE: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bn-cache-')),
  });
  const naude = runEntry(['build', 'naude'], controlled());
  assert.strictEqual(naude.status, 1);
  assert.match(naude.stderr || '', /^clode: build naude: /m);
  assert.doesNotMatch(naude.stderr || '', /--naude/, 'the flag is gone from the messages too');

  // `quaude` is the DEFAULT subject, not a second flag: the same argv with the
  // positional spelled out, and with it omitted, fail identically.
  const quaude = runEntry(['build', 'quaude'], controlled());
  const bare = runEntry(['build'], controlled());
  assert.doesNotMatch(quaude.stderr || '', /build naude:/);
  assert.strictEqual(quaude.stderr, bare.stderr);
});

test('the table spelling `fetch claude` names the INGREDIENT, not the channel', () => {
  // An EMPTY local releases repo (file://, no network at all): clodeUpdate cannot
  // resolve a version and says which CHANNEL it tried. `fetch claude` must report the
  // DEFAULT channel (latest) — proof that `claude` was consumed as the ingredient — and
  // the legacy positional must still land in the channel slot. This is the one case
  // where the table spelling CHANGED an accepted argv's meaning: `clode fetch claude`
  // used to ask for a channel named "claude".
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-releases-empty-'));
  const common = {
    CLODE_RELEASES_URL: 'file://' + repo,
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-home-')),
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-state-')),
  };
  const ingredient = runEntry(['fetch', 'claude'], common);
  assert.strictEqual(ingredient.status, 1);
  assert.match(ingredient.stderr, /couldn't resolve a version for 'latest'/);
  assert.doesNotMatch(ingredient.stderr, /for 'claude'/,
    "'claude' is the ingredient; it must never be passed through as a channel");
  // The release positional (SURFACE.verbs.fetch.tail) now comes AFTER the ingredient:
  // `clode fetch stable` was the old spelling and is a usage error (task 6).
  const channel = runEntry(['fetch', 'claude', 'stable'], common);
  assert.match(channel.stderr, /couldn't resolve a version for 'stable'/);
  const legacy = runEntry(['fetch', 'stable'], common);
  assert.strictEqual(legacy.status, 2);
  assert.match(legacy.stderr, /unknown ingredient 'stable'/);
});

test('a print-and-exit global wins over a verb, in the order argv gave it', () => {
  // Nonsense argv that nonetheless had an answer before the table existed, and keeps it:
  // the first print-and-exit global wins (clode-main.cjs step 4 walks globalOrder).
  assert.ok(runEntry(['--help', '--version']).stdout.startsWith(`clode ${VERSION} — `));
  assert.strictEqual(runEntry(['--version', '--help']).stdout, `clode ${VERSION}\n`);
  assert.strictEqual(runEntry(['--version', 'build']).stdout, `clode ${VERSION}\n`);
});

test('the ES5 prologue prints the exact floor message + exits 1 on an old node', () => {
  // Fake an old node's reported version via a --require preload (see
  // runEntryWithFakeVersion above), so the prologue's own floor check trips
  // when ENTRY is actually run. The floor is v20 for every command now —
  // clode never runs the extracted bundle under node (that died with the
  // runner), so there is no higher-floor command left to special-case; the
  // old build-only v20/v24 split collapsed into one floor.
  const r = runEntryWithFakeVersion('18.0.0', []);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(
    r.stderr,
    'clode: node v18.0.0 is too old; need >= v20\n' +
    "clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n");
  assert.strictEqual(r.stdout, '');
});

test('the prologue floor is v20 end-to-end for `clode build` (blobulate runs under tjs, not node)', () => {
  // `clode build` never runs the extracted bundle under node — the blobulate
  // worker and the blobulated artifacts exec under tjs; node only orchestrates
  // file work. OpenIndiana packages node 20 and OpenBSD 7.9 node 22 (matrix
  // legs, dispatches #6/#14 2026-07-10) — the build path must clear the
  // prologue on both. CLODE_TJS points at a nonexistent template so the run
  // fails FAST and CONTROLLED after the gate (proof it got past the check).
  const r = runEntryWithFakeVersion('20.0.0', ['build'], {
    CLODE_TJS: '/nonexistent/clode-test-tjs-template',
    // This is a valid `clode build` (past argv validation), so it fires the
    // watch trigger — not what this test is about, and without an override
    // it would phone home / touch the real cache dir (this harness inherits
    // process.env, unlike runEntry above). CLODE_NO_WATCH keeps it hermetic.
    CLODE_NO_WATCH: '1',
  });
  assert.strictEqual(r.status, 1);
  assert.doesNotMatch(r.stderr || '', /too old/);
  assert.match(r.stderr || '', /no tjs template at/);
});

test('the prologue keeps a floor for `clode build` too — v18 is refused', () => {
  const r = runEntryWithFakeVersion('18.19.0', ['build']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr || '', /node v18\.19\.0 is too old; need >= v20/);
});

test('--clode-internal-update is retired: an unknown command, never a fetch/rebuild', () => {
  // The old patched-updater rebuild callback dispatched here (fetch a newer
  // Claude Code, rebuild the target, swap in place). That whole path is RETIRED
  // — auto-update is notify-only now. clode must treat --clode-internal-update
  // as any other unknown command: usage error (exit 2), no fetch, no rebuild.
  // State dirs are still redirected into tmp so a regression that resurrects a
  // fetch can never touch the real ~/.local/share/clode or this repo's signals/.
  const r = runEntry(['--clode-internal-update'], {
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-state-')),
    CLODE_SIGNALS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-signals-')),
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-iu-home-')),
  });
  assert.strictEqual(r.status, 2, 'a retired command is a usage error, exit 2');
  assert.match(r.stderr, /unknown command/);
  assert.doesNotMatch(r.stdout + r.stderr, /now the active provider|rebuilt/,
    'a retired command must neither fetch a provider nor rebuild anything');
});

test('clodeHelp() interpolates the version and is newline-terminated', () => {
  const { clodeHelp } = require('../libexec/clode-main.cjs');
  const text = clodeHelp('9.9.9');
  assert.ok(text.startsWith('clode 9.9.9 — '));
  assert.ok(text.endsWith('\n'));
  // clodeHelp IS renderHelp(version, surfaceFor('shipped')) — one literal, one
  // renderer — so the assertion is that identity, not a copy of the text.
  assert.strictEqual(text, renderHelp('9.9.9', surfaceFor('shipped')));
  assert.doesNotMatch(text, /--clode-watch|--self/);
});

test('the checkout entry point is scripts/stage0.mjs, and bin/ holds no script', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'stage0.mjs')), 'scripts/stage0.mjs must exist');
  assert.ok(!fs.existsSync(path.join(ROOT, 'bin', 'clode')),
    'bin/ holds a built binary or nothing — a script there is the bug this move fixes');
});

// ---------------------------------------------------------------------------
// Phase 3a task 6: THE HARD BREAK. The old spellings stop working in the same
// commit that moves every in-repo caller, and a removed spelling gets a GENERIC
// usage message — not a mapping to the new form (user's decision: "if the
// vocabulary is tight enough, there won't be enough choices to merit anything
// other than a generic usage message", and three verbs with four positionals is
// tight enough).

// The SHIPPED spine: libexec/clode-main.cjs run as its own main module, which is
// exactly what the esbuilt bundle inside a built clode binary does (and what
// `scripts/stage0.mjs`, the CHECKOUT entry point, is NOT). The two differ by one
// thing — the table each composes — so the difference is testable without
// building a binary.
const SPINE = path.join(ROOT, 'libexec', 'clode-main.cjs');
function runShipped(args, extraEnv) {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-main-test-shipped-'));
  return spawnSync(NODE, [SPINE, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '', CLODE_WATCH_DIR: watchDir }, extraEnv || {}),
  });
}

const EMPTY_RELEASES = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-break-releases-'));

test('the old spellings are gone, and produce a plain usage error', () => {
  for (const argv of [['fetch'], ['watch'], ['build', '--naude'], ['build', '--self'], ['fetch', '--naude']]) {
    const r = runEntry(argv, {
      // Hermetic AND offline: an EMPTY local releases repo (file://) so that a
      // regression which resurrects one of these spellings fails to resolve a
      // version instead of downloading a ~240MB provider off the network.
      CLODE_RELEASES_URL: 'file://' + EMPTY_RELEASES,
      CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-break-state-')),
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-break-home-')),
    });
    assert.strictEqual(r.status, 2, `${argv.join(' ')} must be a usage error, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr || '', /is now|renamed|use instead/i,
      'a generic usage message, not a mapping — the vocabulary is small enough');
  }
});

test('the new spellings reach the right product and ingredient', () => {
  assert.match(runEntry(['build', 'naude', '--help']).stderr || '', /unknown argument/);  // argv still validated
  const { SURFACE: table } = require('../libexec/cli-surface.cjs');
  assert.deepStrictEqual(Object.keys(table.verbs.build.subjects), ['quaude', 'naude']);
  assert.deepStrictEqual(Object.keys(table.verbs.fetch.subjects), ['claude', 'node']);
});

test('a shipped clode refuses bootstrap with a reason', () => {
  const r = runShipped(['bootstrap']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr || '', /checkout/i, 'the refusal should say where bootstrap runs');
});

test('the checkout entry point HAS bootstrap, and it is the builder, not a product', () => {
  // Not a build: a bootstrap-specific argv error, which only the bootstrap branch can
  // print (its usage line names bootstrap, never `clode build`). It names it the way the
  // verb is actually TYPED — `node scripts/stage0.mjs bootstrap` — because there is no
  // `clode` that accepts bootstrap; this used to assert the non-existent `clode
  // bootstrap`, the same false invocation --help was rendering.
  const r = runEntry(['bootstrap', '--bogus']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr || '', /unknown argument '--bogus'/);
  assert.match(r.stderr || '', /usage: node scripts\/stage0\.mjs bootstrap/);
  assert.doesNotMatch(r.stderr || '', /usage: clode bootstrap/);
  assert.doesNotMatch(r.stderr || '', /unknown command/, 'the checkout table carries bootstrap');
});

test('`build quaude --naude` can no longer silently build a naude', () => {
  // The defect this removal kills BY CONSTRUCTION: the legacy sniff was guarded by
  // `!cmd.subject`, so an explicit `quaude` positional was kept and then IGNORED
  // while `--naude` passed through to the build parser and won. With no --naude
  // flag anywhere, the only way to name a product is the positional.
  // CLODE_CLAUDE_BIN points nowhere, so even a REGRESSION that mis-routes again
  // fails at the resolve step instead of running a real (2-minute) naude build —
  // and the message it fails with names the product it reached, which is the
  // evidence either way.
  const r = runEntry(['build', 'quaude', '--naude'], {
    CLODE_CLAUDE_BIN: '/nonexistent/clode-test-claude',
    CLODE_NO_WATCH: '1',
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-misroute-state-')),
    CLODE_CACHE: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-misroute-cache-')),
  });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr || '', /unknown argument '--naude'/);
  assert.doesNotMatch(r.stdout + r.stderr, /build naude|build --naude/,
    'it must never reach the naude product');
});

