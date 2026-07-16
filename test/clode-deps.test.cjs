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

// A standalone package layout: bin/ is HERE, ../package.json is the manifest,
// libexec/ carries no manifest (so we exercise the here/../package.json fallback).
function makePkg() {
  const root = tmpdir();
  const here = path.join(root, 'bin');
  const libexec = path.join(root, 'libexec');
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"clode","dependencies":{}}\n');
  const deps = path.join(root, 'deps');
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
// fails loud (use the fused binary / `clode build` / a managed CLODE_DEPS),
// instead of the old auto-install. `install` defaults to true so the build/CI
// caller (clode-fuse gathering deps to embed) is unchanged.
test('install:false (runtime) never shells npm — fails loud, installs nothing', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  const { exitCode, err } = run({
    here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), install: false,
    env: { CLODE_DEPS: deps },
  });
  assert.strictEqual(log.calls.length, 0, 'must not invoke npm at runtime');
  assert.strictEqual(exitCode, 1);
  assert.match(err, /clode build|fused|binary|CLODE_DEPS/);
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
  assert.match(calls, /install/);
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
  assert.doesNotMatch(log.calls.join('\n'), /install/);
});

test('a changed manifest triggers a reinstall', () => {
  const { root, here, libexec, deps } = makePkg();
  const log = { calls: [] };
  const spawn = fakeNpmOk(log);
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  log.calls.length = 0;
  // mutate the manifest -> size (and mtime) change -> sig changes
  fs.appendFileSync(path.join(root, 'package.json'), '\n');
  run({ here, libexec, npmPath: 'npm', spawn, env: { CLODE_DEPS: deps } });
  assert.match(log.calls.join('\n'), /install/);
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
  assert.doesNotMatch(log.calls.join('\n'), /install/);
});

test("deps shipped in clode's own node_modules (npm install -g .) -> no auto-install", () => {
  const { root, here, libexec, deps } = makePkg();
  const log = { calls: [] };
  // what `npm install -g .` leaves next to bin/ ($HERE/../node_modules)
  fs.mkdirSync(path.join(root, 'node_modules', '.shipped'), { recursive: true });
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  assert.doesNotMatch(log.calls.join('\n'), /install/);
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
  assert.doesNotMatch(log.calls.join('\n'), /install/);
});

// --- manifest search order -------------------------------------------------
test('the manifest in libexec/package.json wins over here/../package.json', () => {
  const { here, libexec, deps } = makePkg();
  const log = { calls: [] };
  // put a manifest in libexec too; ensure_deps prefers it (first in search order)
  fs.writeFileSync(path.join(libexec, 'package.json'), '{"name":"clode-libexec"}\n');
  run({ here, libexec, npmPath: 'npm', spawn: fakeNpmOk(log), env: { CLODE_DEPS: deps } });
  const copied = fs.readFileSync(path.join(deps, 'package.json'), 'utf8');
  assert.match(copied, /clode-libexec/);
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
