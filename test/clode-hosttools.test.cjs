'use strict';
// Unit tests for libexec/clode-hosttools.cjs — the JS port of bin/clode's
// host-tool discovery + host-environment setup. Mirrors the sh-side coverage in
// test/test_launcher_unit.bats (cert cases) and test/test_argv0_rg.bats (rg).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MIN_NODE_MAJOR,
  findTool,
  checkNodeVersion,
  requireNodeVersionOrExit,
  certStoreDefault,
  applyRipgrepEnv,
  applyNodePath,
} = require('../libexec/clode-hosttools.cjs');

// --- helpers ---------------------------------------------------------------
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-hosttools-'));
}
function makeExe(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
  fs.chmodSync(p, 0o755);
  return p;
}

// --- findTool: override -> PATH-walk -> null --------------------------------
test('findTool returns the override when it is executable', () => {
  const dir = tmpdir();
  const rg = makeExe(dir, 'rg');
  assert.strictEqual(findTool('rg', { override: rg, env: { PATH: '' } }), rg);
});

test('findTool ignores a non-executable override and walks PATH', () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'notexec'); // never created -> not executable
  const bindir = path.join(dir, 'bin');
  const rg = makeExe(bindir, 'rg');
  const found = findTool('rg', { override: bad, env: { PATH: bindir } });
  assert.strictEqual(found, rg);
});

test('findTool walks PATH in order and finds the first match', () => {
  const dir = tmpdir();
  const d1 = path.join(dir, 'a');
  const d2 = path.join(dir, 'b');
  const rg1 = makeExe(d1, 'rg');
  makeExe(d2, 'rg');
  const found = findTool('rg', { env: { PATH: [d1, d2].join(path.delimiter) } });
  assert.strictEqual(found, rg1);
});

test('findTool returns null when nothing is found', () => {
  const dir = tmpdir();
  assert.strictEqual(findTool('definitely-not-a-tool', { env: { PATH: dir } }), null);
});

// --- checkNodeVersion / requireNodeVersionOrExit ---------------------------
test('MIN_NODE_MAJOR matches the sh launcher floor (24)', () => {
  assert.strictEqual(MIN_NODE_MAJOR, 24);
});

test('checkNodeVersion accepts the running node', () => {
  const r = checkNodeVersion();
  assert.strictEqual(r.ok, true);
  assert.ok(r.major >= MIN_NODE_MAJOR);
});

test('checkNodeVersion rejects an old version', () => {
  const r = checkNodeVersion('18.19.0');
  assert.deepStrictEqual(r, { ok: false, major: 18 });
});

test('requireNodeVersionOrExit prints the EXACT too-old message and exits 1', () => {
  const lines = [];
  let code;
  requireNodeVersionOrExit({
    versionString: '18.19.0',
    stderr: { write: (s) => lines.push(s) },
    exit: (c) => { code = c; },
  });
  assert.strictEqual(code, 1);
  assert.strictEqual(lines[0], 'clode: node v18.19.0 is too old; need >= v24\n');
  assert.strictEqual(
    lines[1],
    "clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n",
  );
});

test('requireNodeVersionOrExit prints the EXACT no-usable-node message and exits 1', () => {
  const lines = [];
  let code;
  requireNodeVersionOrExit({
    nodePath: '/no/such/node',
    isExec: () => false,
    stderr: { write: (s) => lines.push(s) },
    exit: (c) => { code = c; },
  });
  assert.strictEqual(code, 1);
  assert.strictEqual(lines[0], "clode: no usable node at '/no/such/node' (set CLODE_NODE)\n");
});

test('requireNodeVersionOrExit is a no-op (returns ok) for a good version', () => {
  const lines = [];
  let code;
  const r = requireNodeVersionOrExit({
    versionString: '24.6.0',
    stderr: { write: (s) => lines.push(s) },
    exit: (c) => { code = c; },
  });
  assert.strictEqual(code, undefined);
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(r.ok, true);
});

// --- certStoreDefault (mirrors test_launcher_unit.bats cert cases) ----------
test('legacy macOS (no trustd) defaults CLAUDE_CODE_CERT_STORE=bundled', () => {
  const env = {};
  certStoreDefault({ platform: 'darwin', exists: () => false, env });
  assert.strictEqual(env.CLAUDE_CODE_CERT_STORE, 'bundled');
});

test('modern macOS (trustd present) leaves CLAUDE_CODE_CERT_STORE unset', () => {
  const env = {};
  certStoreDefault({ platform: 'darwin', exists: () => true, env });
  assert.strictEqual(env.CLAUDE_CODE_CERT_STORE, undefined);
});

test('a user-set CLAUDE_CODE_CERT_STORE is respected on legacy macOS', () => {
  const env = { CLAUDE_CODE_CERT_STORE: 'system' };
  certStoreDefault({ platform: 'darwin', exists: () => false, env });
  assert.strictEqual(env.CLAUDE_CODE_CERT_STORE, 'system');
});

test('certStoreDefault is a no-op off macOS', () => {
  const env = {};
  certStoreDefault({ platform: 'linux', exists: () => false, env });
  assert.strictEqual(env.CLAUDE_CODE_CERT_STORE, undefined);
});

test('certStoreDefault honors the CLODE_TRUSTD-style probe path override', () => {
  const dir = tmpdir();
  const trustd = makeExe(dir, 'trustd'); // exists -> modern stack -> leave default
  const env = {};
  certStoreDefault({ platform: 'darwin', trustdPath: trustd, env });
  assert.strictEqual(env.CLAUDE_CODE_CERT_STORE, undefined);
});

// --- applyRipgrepEnv (mirrors test_argv0_rg.bats) --------------------------
test('applyRipgrepEnv forces system rg and prepends its dir when rg exists on PATH', () => {
  const dir = tmpdir();
  const bindir = path.join(dir, 'bin');
  makeExe(bindir, 'rg');
  const env = { PATH: [bindir, '/usr/bin', '/bin'].join(path.delimiter) };
  applyRipgrepEnv({ env });
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '0');
  assert.ok(env.PATH.split(path.delimiter).includes(bindir));
});

test('applyRipgrepEnv honors the CLODE_RG override and prepends its dir to PATH', () => {
  const dir = tmpdir();
  const rgdir = path.join(dir, 'rgdir');
  const rg = makeExe(rgdir, 'rg');
  const env = { PATH: '/usr/bin:/bin' };
  applyRipgrepEnv({ env, override: rg });
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '0');
  assert.strictEqual(env.PATH, `${rgdir}${path.delimiter}/usr/bin:/bin`);
});

test('applyRipgrepEnv leaves USE_BUILTIN_RIPGREP unset when no rg is found', () => {
  const dir = tmpdir();
  const env = { PATH: dir };
  applyRipgrepEnv({ env, override: '' });
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, undefined);
});

test('applyRipgrepEnv respects a user-set USE_BUILTIN_RIPGREP', () => {
  const dir = tmpdir();
  const rg = makeExe(dir, 'rg');
  const env = { PATH: '/usr/bin', USE_BUILTIN_RIPGREP: '1' };
  applyRipgrepEnv({ env, override: rg });
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '1');
});

test('applyRipgrepEnv does not duplicate the rg dir already on PATH', () => {
  const dir = tmpdir();
  const rg = makeExe(dir, 'rg');
  const env = { PATH: [dir, '/usr/bin'].join(path.delimiter) };
  applyRipgrepEnv({ env, override: rg });
  const count = env.PATH.split(path.delimiter).filter((d) => d === dir).length;
  assert.strictEqual(count, 1);
});

// --- applyNodePath ---------------------------------------------------------
test('applyNodePath appends existing dep dirs, preserving the user NODE_PATH', () => {
  const dir = tmpdir();
  const nm1 = path.join(dir, 'a', 'node_modules');
  const nm2 = path.join(dir, 'b', 'node_modules');
  fs.mkdirSync(nm1, { recursive: true });
  fs.mkdirSync(nm2, { recursive: true });
  const env = { NODE_PATH: '/user/np' };
  applyNodePath({ env, dirs: [nm1, nm2, path.join(dir, 'nope', 'node_modules')] });
  assert.strictEqual(env.NODE_PATH, `/user/np${path.delimiter}${nm1}${path.delimiter}${nm2}`);
});

test('applyNodePath skips a dir already present in NODE_PATH', () => {
  const dir = tmpdir();
  const nm1 = path.join(dir, 'node_modules');
  fs.mkdirSync(nm1, { recursive: true });
  const env = { NODE_PATH: nm1 };
  applyNodePath({ env, dirs: [nm1] });
  assert.strictEqual(env.NODE_PATH, nm1);
});

test('applyNodePath sets NODE_PATH from scratch when the user had none', () => {
  const dir = tmpdir();
  const nm1 = path.join(dir, 'node_modules');
  fs.mkdirSync(nm1, { recursive: true });
  const env = {};
  applyNodePath({ env, dirs: [nm1] });
  assert.strictEqual(env.NODE_PATH, nm1);
});

test('applyNodePath builds candidates from here/depsRoot/node when dirs omitted', () => {
  const dir = tmpdir();
  const here = path.join(dir, 'clode', 'bin');
  const ownNm = path.join(dir, 'clode', 'node_modules');
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(ownNm, { recursive: true });
  const env = {};
  applyNodePath({ env, here });
  assert.strictEqual(env.NODE_PATH, ownNm);
});
