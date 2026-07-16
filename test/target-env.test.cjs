'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shapeTargetEnv, probePaths } = require('../libexec/target-env.cjs');

// Every primitive is injected: this module must run under tjs (quaude's
// bootstrap, pre-node-shim) as well as node (naude), so it may not require
// node:fs or node:path.
function opts(over = {}) {
  return Object.assign({
    env: {},
    platform: 'linux',
    delimiter: ':',
    exists: () => false,
    dirname: (p) => p.slice(0, p.lastIndexOf('/')) || '/',
  }, over);
}

test('sets the bundle env defaults', () => {
  const env = shapeTargetEnv(opts());
  assert.strictEqual(env.DISABLE_INSTALLATION_CHECKS, '1');
  assert.strictEqual(env.NODE_USE_ENV_PROXY, '1');
});

test('set-if-unset: never clobbers a value the user chose (empty counts as unset)', () => {
  const env = shapeTargetEnv(opts({ env: { DISABLE_INSTALLATION_CHECKS: '0', NODE_USE_ENV_PROXY: '' } }));
  assert.strictEqual(env.DISABLE_INSTALLATION_CHECKS, '0', 'an explicit user value wins');
  assert.strictEqual(env.NODE_USE_ENV_PROXY, '1', 'empty is treated as unset');
});

test('cert store: only on darwin, only when the modern trust stack is absent', () => {
  const old = shapeTargetEnv(opts({ platform: 'darwin', exists: () => false }));
  assert.strictEqual(old.CLAUDE_CODE_CERT_STORE, 'bundled');
  const modern = shapeTargetEnv(opts({ platform: 'darwin', exists: (p) => p === '/usr/libexec/trustd' }));
  assert.strictEqual(modern.CLAUDE_CODE_CERT_STORE, undefined, 'modern trustd: leave the app default');
  const linux = shapeTargetEnv(opts({ platform: 'linux', exists: () => false }));
  assert.strictEqual(linux.CLAUDE_CODE_CERT_STORE, undefined);
});

test('ripgrep: a real rg on PATH switches off the builtin and stays reachable', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin:/opt/rg/bin' },
    exists: (p) => p === '/opt/rg/bin/rg',
  }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '0');
  assert.strictEqual(env.PATH, '/opt/rg/bin:/usr/bin:/opt/rg/bin', 'rg dir is prepended so the bundle resolves `rg` by name');
});

test('ripgrep: CLODE_RG wins verbatim over PATH discovery', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin', CLODE_RG: '/custom/rg' },
    exists: () => true,
  }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '0');
  assert.strictEqual(env.PATH, '/custom:/usr/bin');
});

test('ripgrep: no rg anywhere leaves the search config untouched (rg is OPTIONAL)', () => {
  const env = shapeTargetEnv(opts({ env: { PATH: '/usr/bin' }, exists: () => false }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, undefined);
  assert.strictEqual(env.PATH, '/usr/bin');
});

test('ripgrep: an rg dir already on PATH is not duplicated', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/opt/rg/bin:/usr/bin' },
    exists: (p) => p === '/opt/rg/bin/rg',
  }));
  assert.strictEqual(env.PATH, '/opt/rg/bin:/usr/bin');
});

test('CLODE_SELF points at the clode builder, so the in-TUI updater can call back', () => {
  const env = shapeTargetEnv(opts({ self: '/usr/local/bin/clode' }));
  assert.strictEqual(env.CLODE_SELF, '/usr/local/bin/clode');
});

test('CLODE_SELF: absent builder leaves it unset (the updater then fails loud, not wrong)', () => {
  assert.strictEqual(shapeTargetEnv(opts({ self: null })).CLODE_SELF, undefined);
  assert.strictEqual(shapeTargetEnv(opts({})).CLODE_SELF, undefined);
});

test('windows: PATH uses the caller-supplied delimiter', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: 'C:\\bin', CLODE_RG: 'C:\\rg\\rg.exe' },
    delimiter: ';',
    dirname: (p) => p.slice(0, p.lastIndexOf('\\')),
    exists: (p) => p === 'C:\\rg\\rg.exe',
    platform: 'win32',
  }));
  assert.strictEqual(env.PATH, 'C:\\rg;C:\\bin');
});

// probePaths exists because tjs has NO statSync — quaude's bootstrap must
// resolve every candidate with async tjs.stat BEFORE calling shapeTargetEnv,
// then answer from the result.
test('probePaths lists every path shapeTargetEnv might test', () => {
  const p = probePaths({ env: { PATH: '/usr/bin:/opt/rg/bin' }, platform: 'darwin', delimiter: ':' });
  assert.deepStrictEqual(p, ['/usr/libexec/trustd', '/usr/bin/rg', '/opt/rg/bin/rg']);
  const lin = probePaths({ env: { PATH: '/usr/bin' }, platform: 'linux', delimiter: ':' });
  assert.deepStrictEqual(lin, ['/usr/bin/rg'], 'trustd is a darwin-only question');
  const win = probePaths({ env: { PATH: 'C:\\bin' }, platform: 'win32', delimiter: ';' });
  assert.deepStrictEqual(win, ['C:\\bin\\rg.exe']);
});

// The drift guard: if shapeTargetEnv ever tests a path probePaths did not
// predict, quaude answers "false" for it and silently loses the feature. Fail
// loud here instead.
test('shapeTargetEnv never probes a path probePaths did not predict', () => {
  const env = { PATH: '/usr/bin:/opt/rg/bin' };
  const predicted = new Set(probePaths({ env, platform: 'darwin', delimiter: ':' }));
  shapeTargetEnv(opts({
    env, platform: 'darwin',
    exists: (p) => {
      assert.ok(predicted.has(p), `probed an unpredicted path: ${p}`);
      return false;
    },
  }));
});
