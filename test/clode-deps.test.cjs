'use strict';
// Unit tests for libexec/clode-deps.cjs — the JS port of bin/clode's ensure_deps
// (runtime npm-dep install into a user-owned dir). Mirrors the sh-side coverage in
// test/test_deps.bats: auto-install on an empty deps dir + sig record; sig-match
// skip; changed-manifest reinstall; missing/failing npm exits loud; a user-managed
// CLODE_DEPS is left alone; deps shipped in clode's own node_modules => no install.
//
// A FAKE npm (a tiny sh stub written to disk, passed as npmPath) stands in for the
// real one so tests never hit the network — mirroring the CLODE_NPM fake in the bats.
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
  const npmlog = path.join(root, 'npmlog');
  return { root, here, libexec, deps, npmlog };
}

// Fake npm: append the invocation to a log, and (a "successful" install) create
// node_modules under --prefix. Mirrors test_deps.bats's npm-ok.
function fakeNpmOk(dir, npmlog) {
  const p = path.join(dir, 'npm-ok');
  fs.writeFileSync(
    p,
    '#!/bin/sh\n' +
      `echo "npm $*" >> "${npmlog}"\n` +
      'p=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && p="$2"; shift; done\n' +
      '[ -n "$p" ] && mkdir -p "$p/node_modules/.installed"\n' +
      'exit 0\n',
  );
  fs.chmodSync(p, 0o755);
  return p;
}

// Fake npm that fails, like test_deps.bats's npm-fail.
function fakeNpmFail(dir) {
  const p = path.join(dir, 'npm-fail');
  fs.writeFileSync(p, '#!/bin/sh\necho "boom" >&2\nexit 1\n');
  fs.chmodSync(p, 0o755);
  return p;
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

function readLog(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// --- auto-install ----------------------------------------------------------
test('auto-install runs when the deps dir is empty, and records a sig', () => {
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  const { exitCode } = run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  assert.strictEqual(exitCode, null);
  const log = readLog(npmlog);
  assert.match(log, /install/);
  // npm flags carried through, in the sh order.
  assert.match(log, /--no-audit --no-fund --omit=dev/);
  assert.ok(fs.existsSync(path.join(deps, 'node_modules', '.installed')));
  assert.ok(fs.existsSync(path.join(deps, '.deps-sig')));
});

test('the copied manifest lands at DEPS_ROOT/package.json', () => {
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  assert.ok(fs.existsSync(path.join(deps, 'package.json')));
});

test('auto-install is skipped when the manifest sig already matches', () => {
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  fs.writeFileSync(npmlog, ''); // clear
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  assert.doesNotMatch(readLog(npmlog), /install/);
});

test('a changed manifest triggers a reinstall', () => {
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  fs.writeFileSync(npmlog, '');
  // mutate the manifest -> size (and mtime) change -> sig changes
  fs.appendFileSync(path.join(root, 'package.json'), '\n');
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  assert.match(readLog(npmlog), /install/);
});

// --- fail-loud -------------------------------------------------------------
test('a failing npm exits loud (exit 1) with the dependency-install error', () => {
  const { root, here, libexec, deps } = makePkg();
  const npm = fakeNpmFail(root);
  const { exitCode, err } = run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
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
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  fs.mkdirSync(path.join(deps, 'node_modules', '.user'), { recursive: true });
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  assert.doesNotMatch(readLog(npmlog), /install/);
});

test("deps shipped in clode's own node_modules (npm install -g .) -> no auto-install", () => {
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  // what `npm install -g .` leaves next to bin/ ($HERE/../node_modules)
  fs.mkdirSync(path.join(root, 'node_modules', '.shipped'), { recursive: true });
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  assert.doesNotMatch(readLog(npmlog), /install/);
});

test('no manifest anywhere -> nothing to ensure (no install, no exit)', () => {
  const root = tmpdir();
  const here = path.join(root, 'bin');
  const libexec = path.join(root, 'libexec');
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  const npmlog = path.join(root, 'npmlog');
  const npm = fakeNpmOk(root, npmlog);
  const { exitCode } = run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: path.join(root, 'deps') } });
  assert.strictEqual(exitCode, null);
  assert.doesNotMatch(readLog(npmlog), /install/);
});

// --- manifest search order -------------------------------------------------
test('the manifest in libexec/package.json wins over here/../package.json', () => {
  const { root, here, libexec, deps, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  // put a manifest in libexec too; ensure_deps prefers it (first in search order)
  fs.writeFileSync(path.join(libexec, 'package.json'), '{"name":"clode-libexec"}\n');
  run({ here, libexec, npmPath: npm, env: { CLODE_DEPS: deps } });
  const copied = fs.readFileSync(path.join(deps, 'package.json'), 'utf8');
  assert.match(copied, /clode-libexec/);
});

// --- DEPS_ROOT resolution --------------------------------------------------
test('DEPS_ROOT defaults to XDG_DATA_HOME/clode when CLODE_DEPS is unset', () => {
  const { root, here, libexec, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  const xdg = path.join(root, 'xdg');
  run({ here, libexec, npmPath: npm, env: { XDG_DATA_HOME: xdg } });
  assert.ok(fs.existsSync(path.join(xdg, 'clode', 'node_modules', '.installed')));
  assert.ok(fs.existsSync(path.join(xdg, 'clode', '.deps-sig')));
});

test('DEPS_ROOT defaults to HOME/.local/share/clode when neither is set', () => {
  const { root, here, libexec, npmlog } = makePkg();
  const npm = fakeNpmOk(root, npmlog);
  const home = path.join(root, 'home');
  run({ here, libexec, npmPath: npm, env: { HOME: home } });
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'clode', 'node_modules', '.installed')));
});
