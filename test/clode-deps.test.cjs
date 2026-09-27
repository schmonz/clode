'use strict';
// Unit tests for libexec/clode-deps.cjs — the JS port of bin/clode's ensure_deps
// (runtime npm-dep install into a user-owned dir). Mirrors the sh-side coverage in
// test/test_deps.bats: auto-install on an empty deps dir + sig record; sig-match
// skip; changed-manifest reinstall; missing/failing npm exits loud; a user-managed
// CLODE_DEPS is left alone; deps shipped in clode's own node_modules => no install.
//
// A MOCK spawn (injected via ensureDeps' `spawn` option) stands in for the real
// npm subprocess so tests never hit the network or shell out to a real npm —
// cross-platform, no `#!/bin/sh` fake required (mirrors the CLODE_NPM fake in the
// bats, and the applet-spawn mock pattern from commit bfc6b97).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureDeps } = require('../libexec/clode-deps.cjs');

// --- helpers ---------------------------------------------------------------
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-deps-'));
}

// A standalone package layout: bin/ is HERE, ../deps/claude/package.json is
// the manifest (Claude Code's deps, not clode's own), libexec/ carries no
// manifest (so we exercise the here/../deps/claude/package.json fallback).
// `deps` here is the CLODE_DEPS store (unrelated to the repo's deps/claude —
// this is the user-owned install target, ~/.local/share/clode by default).
function makePkg() {
  const root = tmpdir();
  const here = path.join(root, 'bin');
  const libexec = path.join(root, 'libexec');
  const targetDeps = path.join(root, 'deps', 'claude');
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  fs.mkdirSync(targetDeps, { recursive: true });
  fs.writeFileSync(path.join(targetDeps, 'package.json'), '{"name":"clode-target-deps","dependencies":{}}\n');
  fs.writeFileSync(path.join(targetDeps, 'package-lock.json'), '{"name":"clode-target-deps","lockfileVersion":3,"packages":{}}\n');
  const deps = path.join(root, 'store');
  return { root, here, libexec, deps };
}

// A mock npm `spawn` (replaces the #!/bin/sh fake — cross-platform, no real process).
// Records each invocation to `log.calls`, and on `--prefix` creates
// <prefix>/node_modules/.installed (the fake "successful install" side effect the
// tests check). Return shape matches spawnSync (r.status), same field runNpmQuiet
// reads in libexec/clode-deps.cjs.
function fakeNpmOk(log) {
  return (npm, args) => {
    log.calls.push('npm ' + args.join(' '));
    let prefix = '';
    for (let i = 0; i < args.length - 1; i++) if (args[i] === '--prefix') prefix = args[i + 1];
    if (prefix) fs.mkdirSync(path.join(prefix, 'node_modules', '.installed'), { recursive: true });
    return { status: 0, stdout: '', stderr: '' };
  };
}

// A mock npm `spawn` that fails, like test_deps.bats's npm-fail.
function fakeNpmFail() {
  return (npm, args) => ({ status: 1, stdout: '', stderr: 'boom\n' });
}

// Run ensureDeps with captured stderr + an exit stub that unwinds (like sh `exit`).
function run(opts) {
  let exitCode = null;
  let err = '';
  const stderr = { write: (s) => { err += s; return true; } };
  const exit = (c) => { exitCode = c; throw new Error('__exit__'); };
  try {
    ensureDeps(Object.assign({ stderr, exit }, opts));
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  }
  return { exitCode, err };
}

// --- runtime path: NO host-npm fallback (D2, retire-node-runtime item 2) ----
// The USER runtime must never shell npm. When deps aren't already present it
// fails loud (use the blobulated binary / `clode build` / a managed CLODE_DEPS),
// instead of the old auto-install. `install` defaults to true so the build/CI
// caller (clode-build gathering deps to embed) is unchanged.
test('install:false (runtime) never shells npm — fails loud, installs nothing', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  const { exitCode, err } = run({
    here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), install: false,
    env: { CLODE_DEPS: deps },
  });
  assert.strictEqual(log.calls.length, 0, 'must not invoke npm at runtime');
  assert.strictEqual(exitCode, 1);
  // actionable for the reachable audience: dev checkout -> npm ci; else binary / CLODE_DEPS
  assert.match(err, /npm ci --prefix deps\/claude/);
  assert.match(err, /CLODE_DEPS/);
  assert.ok(!fs.existsSync(path.join(deps, 'node_modules', '.installed')), 'nothing installed');
});

test('install:false still honors the present-deps early returns (no failure)', () => {
  // a user-managed CLODE_DEPS (node_modules, no .deps-sig) must be left alone,
  // NOT treated as "missing" — even on the runtime path.
  const { here, libexec, deps } = makePkg();
  fs.mkdirSync(path.join(deps, 'node_modules'), { recursive: true });
  const log = { calls: [] };
  const { exitCode } = run({
    here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), install: false,
    env: { CLODE_DEPS: deps },
  });
  assert.strictEqual(exitCode, null, 'user-managed deps present -> no failure');
  assert.strictEqual(log.calls.length, 0);
});

// --- auto-install ----------------------------------------------------------
test('auto-install runs when the deps dir is empty, and records a sig', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  const { exitCode } = run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  assert.strictEqual(exitCode, null);
  const calls = log.calls.join('\n');
  assert.match(calls, /^npm ci --prefix /m); // from the lockfile (DEPS_STORE_FROM_LOCKFILE)
  // npm flags carried through, in the sh order.
  assert.match(calls, /--no-audit --no-fund --omit=dev/);
  assert.ok(fs.existsSync(path.join(deps, 'node_modules', '.installed')));
  assert.ok(fs.existsSync(path.join(deps, '.deps-sig')));
});

test('the copied manifest lands at DEPS_ROOT/package.json', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  assert.ok(fs.existsSync(path.join(deps, 'package.json')));
});

test('auto-install is skipped when the manifest sig already matches', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  const spawn = fakeNpmOk(log);
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  log.calls.length = 0; // clear
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  assert.deepStrictEqual(log.calls, [], 'a fresh store must not run npm at all');
});

test('a changed manifest triggers a reinstall', () => {
  const { root, here, libexec, deps } = makePkg();
  const log = { calls: [] };
  const spawn = fakeNpmOk(log);
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  log.calls.length = 0;
  // mutate the manifest -> size (and mtime) change -> sig changes
  fs.appendFileSync(path.join(root, 'deps', 'claude', 'package.json'), '\n');
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  assert.strictEqual(log.calls.length, 1, 'expected exactly one reinstall');
});

// --- fail-loud -------------------------------------------------------------
test('a failing npm exits loud (exit 1) with the dependency-install error', () => {
  const { here, libexec, deps } = makePkg();
  const { exitCode, err } = run({ here, libexec, npmPath: 'npm', spawn: fakeNpmFail(), env: { CLODE_DEPS: deps } });
  assert.strictEqual(exitCode, 1);
  assert.match(err, /dependency install failed/i);
});

test('missing npm exits loud (exit 1) with the need-npm error', () => {
  const { here, libexec, deps } = makePkg();
  // npmPath empty + empty PATH -> no npm discoverable
  const { exitCode, err } = run({ here, libexec, npmPath: '', env: { CLODE_DEPS: deps, PATH: '' } });
  assert.strictEqual(exitCode, 1);
  assert.match(err, /need npm to install runtime dependencies/);
  assert.match(err, /install npm, or set CLODE_DEPS/);
});

// --- early returns ---------------------------------------------------------
test('a user-managed CLODE_DEPS (node_modules, no .deps-sig) is left alone', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  fs.mkdirSync(path.join(deps, 'node_modules', '.user'), { recursive: true });
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  assert.deepStrictEqual(log.calls, [], 'a user-managed store must not run npm at all');
});

test('deps already installed at a sibling deps/claude/node_modules -> no auto-install', () => {
  // what `npm ci --prefix deps/claude` leaves next to bin/
  // ($HERE/../deps/claude/node_modules) — a source checkout that already
  // provisioned Claude Code's deps. This used to check $HERE/../node_modules
  // (`npm install -g .`'s layout) and call it "clode's own node_modules" —
  // that framing was the exact root-vs-target conflation this restructuring
  // removes: clode itself has no runtime deps to ship there.
  const { root, here, libexec, deps } = makePkg();
  const log = { calls: [] };
  fs.mkdirSync(path.join(root, 'deps', 'claude', 'node_modules', '.shipped'), { recursive: true });
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  assert.deepStrictEqual(log.calls, [], 'shipped deps must not run npm at all');
});

test('no manifest anywhere -> nothing to ensure (no install, no exit)', () => {
  const root = tmpdir();
  const here = path.join(root, 'bin');
  const libexec = path.join(root, 'libexec');
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  const log = { calls: [] };
  const { exitCode } = run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: path.join(root, 'deps') } });
  assert.strictEqual(exitCode, null);
  assert.deepStrictEqual(log.calls, [], 'no manifest must not run npm at all');
});

// --- manifest search order -------------------------------------------------
test('the manifest in libexec/deps/claude/package.json wins over here/../deps/claude/package.json', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  // put a manifest in libexec's own deps/claude too; ensure_deps prefers it
  // (first in search order) — an alternate packaging layout where
  // CLODE_LIBEXEC ships its own deps/claude alongside the libexec scripts.
  fs.mkdirSync(path.join(libexec, 'deps', 'claude'), { recursive: true });
  fs.writeFileSync(path.join(libexec, 'deps', 'claude', 'package.json'), '{"name":"clode-libexec-target-deps"}\n');
  fs.writeFileSync(path.join(libexec, 'deps', 'claude', 'package-lock.json'), '{"name":"clode-libexec-target-lock"}\n');
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  const copied = fs.readFileSync(path.join(deps, 'package.json'), 'utf8');
  assert.match(copied, /clode-libexec-target-deps/);
  // the lockfile travels with ITS manifest, never mixed with the other layout's
  assert.match(fs.readFileSync(path.join(deps, 'package-lock.json'), 'utf8'), /clode-libexec-target-lock/);
});

// --- DEPS_ROOT resolution --------------------------------------------------
test('DEPS_ROOT defaults to XDG_DATA_HOME/clode when CLODE_DEPS is unset', () => {
  const { root, here, libexec } = makePkg();
  const log = { calls: [] };
  const xdg = path.join(root, 'xdg');
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { XDG_DATA_HOME: xdg } });
  assert.ok(fs.existsSync(path.join(xdg, 'clode', 'node_modules', '.installed')));
  assert.ok(fs.existsSync(path.join(xdg, 'clode', '.deps-sig')));
});

test('DEPS_ROOT defaults to HOME/.local/share/clode when neither is set', () => {
  const { root, here, libexec } = makePkg();
  const log = { calls: [] };
  const home = path.join(root, 'home');
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { HOME: home } });
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'clode', 'node_modules', '.installed')));
});

// --- THE STORE IS INSTALLED FROM THE LOCKFILE --------------------------------
// The rule (DEPS_STORE_FROM_LOCKFILE, libexec/clode-deps.cjs): the deps store gets the
// manifest's own package-lock.json beside it and is installed with `npm ci`, so it holds
// exactly what the lock pins — the same bytes `npm ci --prefix deps/claude` gives CI.
//
// Before, only package.json was copied and the store ran `npm install`: a FRESH store
// resolved every range anew, and on 2026-09-26 the registry had moved on
// (get-east-asian-width 1.7.0, published 2026-09-17, vs the lock's 1.6.0), so `clode
// build`'s own lockfile gate refused the build it had just installed for. The NetBSD
// spike found it; nothing here could have, because every test's fake npm "succeeded"
// by touching a marker file — it could not say WHAT got installed.
//
// So this fake npm keeps npm's documented contract, and the assertion is the build's
// own gate (assertClosureMatchesLockfile) run over what landed in the store:
//   npm ci       installs exactly package-lock.json's versions; with no lockfile it
//                refuses (npm: "can only install with an existing package-lock.json").
//   npm install  honours a lockfile it can see; with none, it resolves every range
//                afresh, and the registry has moved on: it lands NEWER than the lock.
const { computeDepClosure, readDirectDeps, assertClosureMatchesLockfile } = require('../libexec/clode-build.cjs');

const LOCKED = '1.6.0';
const NEWER = '1.7.0';
function fakeNpmRegistry(log) {
  return (npm, args) => {
    log.calls.push({ args });
    const prefix = args[args.indexOf('--prefix') + 1];
    const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8')); } catch { /* none */ }
    if (args[0] === 'ci' && !lock) {
      return { status: 1, stdout: '', stderr: 'npm error The `npm ci` command can only install with an existing package-lock.json\n' };
    }
    for (const name of Object.keys(manifest.dependencies || {})) {
      const entry = lock && lock.packages && lock.packages[`node_modules/${name}`];
      const version = entry ? entry.version : NEWER;
      const dir = path.join(prefix, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

// A package whose manifest ranges a dependency the lock pins OLDER than the registry's
// newest — the exact shape of the spike's failure.
function makeLockedPkg() {
  const p = makePkg();
  const claude = path.join(p.root, 'deps', 'claude');
  fs.writeFileSync(path.join(claude, 'package.json'),
    JSON.stringify({ name: 'clode-target-deps', dependencies: { 'get-east-asian-width': '^1.0.0' } }));
  fs.writeFileSync(path.join(claude, 'package-lock.json'), JSON.stringify({
    name: 'clode-target-deps', lockfileVersion: 3,
    packages: { '': { name: 'clode-target-deps' }, 'node_modules/get-east-asian-width': { version: LOCKED } },
  }));
  return { ...p, claude };
}

test('a fresh deps store holds exactly what the lockfile pins (the build\'s own gate passes)', () => {
  const { here, libexec, deps, claude } = makeLockedPkg();
  const log = { calls: [] };
  const { exitCode, err } = run({ here, libexec, npmPath: 'npm', spawn: fakeNpmRegistry(log), env: { CLODE_DEPS: deps } });
  assert.strictEqual(exitCode, null, err);
  const versions = new Map();
  computeDepClosure(path.join(deps, 'node_modules'), readDirectDeps(path.join(claude, 'package.json')), { versions });
  assert.deepStrictEqual([...versions], [['get-east-asian-width', LOCKED]]);
  assert.doesNotThrow(() => assertClosureMatchesLockfile(versions, path.join(claude, 'package-lock.json')));
});

test('the store install is `npm ci` from the copied lockfile, with the flags it always had', () => {
  const { here, libexec, deps, claude } = makeLockedPkg();
  const log = { calls: [] };
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmRegistry(log), env: { CLODE_DEPS: deps } });
  assert.strictEqual(log.calls.length, 1);
  assert.deepStrictEqual(log.calls[0].args, ['ci', '--prefix', deps, '--no-audit', '--no-fund', '--omit=dev']);
  assert.strictEqual(fs.readFileSync(path.join(deps, 'package-lock.json'), 'utf8'),
    fs.readFileSync(path.join(claude, 'package-lock.json'), 'utf8'));
});

test('a changed lockfile alone (manifest untouched) re-installs the store', () => {
  const { here, libexec, deps, claude } = makeLockedPkg();
  const log = { calls: [] };
  const spawn = fakeNpmRegistry(log);
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  log.calls.length = 0;
  // a transitive bump lands in the lock only — the store must follow it, or the
  // build's gate refuses a store that was "fresh" by the manifest's signature
  const lockPath = path.join(claude, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/get-east-asian-width'].version = '1.6.1';
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  assert.strictEqual(log.calls.length, 1, 'expected a reinstall after the lockfile changed');
  const got = JSON.parse(fs.readFileSync(path.join(deps, 'node_modules', 'get-east-asian-width', 'package.json'), 'utf8'));
  assert.strictEqual(got.version, '1.6.1');
});

test('a manifest with no lockfile beside it fails loud instead of resolving afresh', () => {
  const { here, libexec, deps, claude } = makeLockedPkg();
  fs.rmSync(path.join(claude, 'package-lock.json'));
  const log = { calls: [] };
  const { exitCode, err } = run({ here, libexec, npmPath: 'npm', spawn: fakeNpmRegistry(log), env: { CLODE_DEPS: deps } });
  assert.strictEqual(exitCode, 1);
  assert.strictEqual(log.calls.length, 0, 'must not install without the lockfile');
  assert.match(err, /package-lock\.json/);
});
