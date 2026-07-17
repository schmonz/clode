'use strict';
// Unit tests for the `clode build` subcommand surface (libexec/clode-fuse.cjs
// + the clode-main dispatch). Cheap paths only — no tjs, no provider, no fuse:
// argv validation, template/provider fail-loud ordering, help text. The real
// fuse (compile + assemble + smoke) is exercised end-to-end in
// test/quaude-build.test.cjs, gated on tjs + CLODE_PROVIDER_BIN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'clode');
const NODE = process.execPath;

// Every spawn here defaults CLODE_WATCH_DIR to a fresh, private temp dir —
// NOT the real ~/.cache/clode (this file's tests inherit process.env, so
// without this override a `clode build` that fires the watch trigger would
// write the real machine's <cache>/clode/last-watch, which is exactly the
// hermeticity violation the repo's guard (test/run.mjs) polices on a clean
// CI runner). Tests that need to inspect the watch dir pass their own
// CLODE_WATCH_DIR via extraEnv, which wins (Object.assign, later key wins).
function runEntry(args, extraEnv) {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fuse-test-watch-'));
  return spawnSync(NODE, [ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '', CLODE_WATCH_DIR: watchDir }, extraEnv || {}),
  });
}

test('clode build: unknown argument fails loudly before any work', () => {
  const r = runEntry(['build', '--frobnicate']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: unknown argument '--frobnicate'/);
  assert.match(r.stderr, /usage: clode build \[--self\] \[--out PATH\]/);
});

// Regression: an invalid `clode build` used to fire the watch trigger — spawning
// a detached network check and writing <cache>/clode/last-watch — BEFORE argv
// validation ever ran, so a build that was about to be REJECTED phoned home and
// mutated the user's cache anyway (the "before any work" contract the test
// above pins by name). clode-main.cjs now calls clode-fuse's parseBuildArgs and
// gates the watch trigger on it succeeding FIRST. This test asserts the
// watch dir stays untouched — no last-watch, and the dir itself never gets
// created — when the build is invalid.
test('clode build <bad arg>: does not fire the watch trigger (a rejected build must not phone home)', () => {
  const watchDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clode-watch-')), 'nested');
  const r = runEntry(['build', '--frobnicate'], { CLODE_WATCH_DIR: watchDir });
  assert.strictEqual(r.status, 1);
  assert.ok(!fs.existsSync(watchDir), 'watch dir must not even be created for a rejected build');
});

// The flip side: a VALID build must still fire the watch (that is the feature
// clode-watch.cjs's header describes — upstream drift is checked at the one
// place it matters). This build fails further downstream (no resolvable
// provider), but argv itself is valid, so the watch trigger must have already
// fired by the time it gets there.
test('clode build: a valid build still fires the watch trigger', () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-watch-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-validwatch-'));
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const r = runEntry(['build'], {
    HOME: home,
    CLODE_STATE_ROOT: home,
    CLODE_TJS: fakeTjs,
    CLODE_CLAUDE_BIN: '',
    CLODE_VERSION_DIR: '',
    PATH: '/nonexistent',
    CLODE_WATCH_DIR: watchDir,
    CLODE_OFFLINE: '1',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: no Claude Code binary found/);
  assert.ok(fs.existsSync(path.join(watchDir, 'last-watch')),
    'a valid build must still fire the watch trigger — do not regress the feature');
});

// The naude branch resolves + extracts the upstream cli.cjs through the SAME
// helper as the quaude branch (stageUpstreamCli), differing only in the error
// prefix it injects. This pins that prefix: a shared helper must not flatten
// `build --naude:` into a bare `build:` — the user has to learn WHICH build
// failed. Paired with the `clode build:` case above; together they are the
// regression guard for the extraction.
test('clode build --naude: no binary fails loudly, prefixed for the naude target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-naude-nobin-'));
  const r = runEntry(['build', '--naude'], {
    HOME: home,
    CLODE_STATE_ROOT: home,
    CLODE_CLAUDE_BIN: '',
    CLODE_VERSION_DIR: '',
    PATH: '/nonexistent',
    CLODE_OFFLINE: '1',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build --naude: no Claude Code binary found/);
  assert.match(r.stderr, /clode fetch/);
});

test('clode build --self: missing esbuilt bundle fails loudly and names the fix', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-self-'));
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const r = runEntry(['build', '--self'], {
    CLODE_TJS: fakeTjs,
    CLODE_MAIN_BUNDLE: '/nonexistent/clode-main.bundle.cjs',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build --self: no esbuilt clode-main bundle at '\/nonexistent\/clode-main\.bundle\.cjs'/);
  assert.match(r.stderr, /build-clode-main\.mjs|CLODE_MAIN_BUNDLE/);
});

// Regression coverage for the bootstrap↔clode-main skew (sparc cross-fuse
// campaign hit an 8-day-stale bundle that crashed inside the fused builder's
// extractIfNeeded): a bundle older than libexec sources must fail loud
// instead of silently fusing a WRONG builder, and a fresh one must not be
// blocked by the same gate.
test('clode build --self: stale esbuilt bundle fails loud and names the fix', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-stale-'));
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const bundle = path.join(home, 'clode-main.bundle.cjs');
  fs.writeFileSync(bundle, '// stale stand-in\n');
  // Pin the bundle's mtime to well before any real libexec source, so the
  // gate fires deterministically no matter when this test runs.
  const old = new Date(1000);
  fs.utimesSync(bundle, old, old);
  const r = runEntry(['build', '--self'], {
    CLODE_TJS: fakeTjs,
    CLODE_MAIN_BUNDLE: bundle,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is older than libexec\//);
  assert.match(r.stderr, /build-clode-main\.mjs/);
});

test('clode build --self: fresh esbuilt bundle passes the staleness gate', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-fresh-'));
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const bundle = path.join(home, 'clode-main.bundle.cjs');
  fs.writeFileSync(bundle, '// fresh stand-in\n');
  // Pin the bundle's mtime well into the future so it postdates every real
  // libexec source regardless of when this test runs. The dummy CLODE_TJS
  // is not a real tjs binary, so the run still fails further down the
  // pipeline (e.g. at codesign) — that's expected; this test only asserts
  // the staleness gate itself did not block a fresh bundle.
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 50);
  fs.utimesSync(bundle, future, future);
  const r = runEntry(['build', '--self'], {
    CLODE_TJS: fakeTjs,
    CLODE_MAIN_BUNDLE: bundle,
  });
  assert.doesNotMatch(r.stderr, /is older than libexec\//);
  assert.doesNotMatch(r.stderr, /no esbuilt clode-main bundle/);
});

test('clode build: missing tjs template fails loudly and names the fix', () => {
  const r = runEntry(['build'], { CLODE_TJS: '/nonexistent/tjs' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: no tjs template at '\/nonexistent\/tjs'/);
  assert.match(r.stderr, /build-tjs|CLODE_TJS/);
});

test('clode build: no resolvable provider fails loudly (after the template gate)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-nohome-'));
  // A real file suffices for the template existence gate; resolution then fails.
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const r = runEntry(['build'], {
    HOME: home,
    CLODE_TJS: fakeTjs,
    CLODE_CLAUDE_BIN: '',
    CLODE_VERSION_DIR: '',
    CLODE_STATE_ROOT: home,
    PATH: '/nonexistent',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: no Claude Code binary found/);
});

test('--help documents clode build and CLODE_TJS, but not the undocumented --self', () => {
  const r = runEntry(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /clode build \[--out PATH\]/);
  assert.match(r.stdout, /quaude/);
  assert.match(r.stdout, /CLODE_TJS/);
  // build --self left the user surface (Task 6): dispatch still works (release
  // tooling calls it), but it's no longer documented.
  assert.doesNotMatch(r.stdout, /--self/);
  assert.doesNotMatch(r.stdout, /CLODE_MAIN_BUNDLE/);
});

// codesignAdHoc: ad-hoc sign a Mach-O template; on old macOS (Mavericks) whose
// codesign_allocate cannot sign a fat binary's arm64 slice ("unknown load
// command 5"), thin to the host arch and retry. Modern hosts sign the fat binary
// unchanged (universal output preserved). Injected spawnSync drives each path.
function scriptSpawn(handler) {
  const calls = [];
  const fn = (cmd, args, _o) => { calls.push([cmd, ...(args || [])].join(' ')); return handler(cmd, args || [], calls); };
  fn.calls = calls;
  return fn;
}

test('codesignAdHoc: non-darwin is a no-op (no spawn at all)', () => {
  const { codesignAdHoc } = require('../libexec/clode-fuse.cjs');
  const sp = scriptSpawn(() => { throw new Error('should not spawn'); });
  assert.deepStrictEqual(codesignAdHoc('/t', { platform: 'linux', spawnSync: sp }), { ok: true });
  assert.strictEqual(sp.calls.length, 0);
});

test('codesignAdHoc: one-shot when codesign succeeds (no lipo, universal preserved)', () => {
  const { codesignAdHoc } = require('../libexec/clode-fuse.cjs');
  const sp = scriptSpawn((cmd) => (cmd === 'codesign' ? { status: 0 } : { status: 1 }));
  assert.deepStrictEqual(codesignAdHoc('/t', { platform: 'darwin', arch: 'arm64', spawnSync: sp }), { ok: true });
  assert.deepStrictEqual(sp.calls, ['codesign -s - --force /t']);
});

test('codesignAdHoc: fat-template sign failure thins IN PLACE to host arch and retries (Mavericks)', () => {
  const { codesignAdHoc } = require('../libexec/clode-fuse.cjs');
  let signs = 0;
  const sp = scriptSpawn((cmd) => {
    if (cmd === 'codesign') { signs += 1; return signs === 1 ? { status: 1, stderr: 'malformed object (unknown load command 5)' } : { status: 0 }; }
    if (cmd === 'lipo') return { status: 0 }; // fat with the host slice -> thin succeeds
    return { status: 1 };
  });
  const logged = [];
  const r = codesignAdHoc('/tmp/template-tjs', { platform: 'darwin', arch: 'x64', spawnSync: sp, log: (m) => logged.push(m) });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(signs, 2);
  // in-place thin: -output == input, no `-archs` probe (old lipo lacks it)
  assert.ok(sp.calls.includes('lipo /tmp/template-tjs -thin x86_64 -output /tmp/template-tjs'), sp.calls.join('\n'));
  assert.ok(!sp.calls.some((c) => /-archs/.test(c)), 'must not use the -archs flag (absent on old lipo)');
  assert.ok(logged.some((m) => /thinned fat template to x86_64/.test(m)), logged.join('\n'));
});

test('codesignAdHoc: sign fails and thin fails (single-arch / no host slice) — stays failed, no false success', () => {
  const { codesignAdHoc } = require('../libexec/clode-fuse.cjs');
  let signs = 0;
  const sp = scriptSpawn((cmd) => {
    if (cmd === 'codesign') { signs += 1; return { status: 1, stderr: 'boom' }; }
    if (cmd === 'lipo') return { status: 1, stderr: 'must be a fat file' }; // already thin / missing slice
    return { status: 1 };
  });
  const r = codesignAdHoc('/t', { platform: 'darwin', arch: 'x64', spawnSync: sp });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /boom/);
  assert.strictEqual(signs, 1); // no second sign after the failed thin
  assert.ok(sp.calls.some((c) => /-thin x86_64/.test(c)), 'attempts the thin directly');
});

test('timeoutScale: default 1, integer >= 1 honored, junk rejected', () => {
  // TCG-emulated guests run 10-20x slower than metal; CI's VM legs scale
  // every build-pipeline hang guard via CLODE_TIMEOUT_SCALE (dispatch #14:
  // the 5-min fuse-worker guard killed a healthy freebsd-arm64 compile).
  const { timeoutScale } = require('../libexec/clode-fuse.cjs');
  assert.strictEqual(timeoutScale({}), 1);
  assert.strictEqual(timeoutScale(undefined), 1);
  assert.strictEqual(timeoutScale({ CLODE_TIMEOUT_SCALE: '10' }), 10);
  assert.strictEqual(timeoutScale({ CLODE_TIMEOUT_SCALE: '0' }), 1);
  assert.strictEqual(timeoutScale({ CLODE_TIMEOUT_SCALE: '-3' }), 1);
  assert.strictEqual(timeoutScale({ CLODE_TIMEOUT_SCALE: 'lots' }), 1);
});
