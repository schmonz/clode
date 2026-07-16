'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { shapeTargetEnv, probePaths, mapPlatform } = require('../libexec/target-env.cjs');

// Every primitive is injected: this module must run under tjs (quaude's
// bootstrap, pre-node-shim) as well as node (naude), so it may not require
// node:fs or node:path.
function opts(over = {}) {
  return Object.assign({
    env: {},
    platform: 'linux',
    delimiter: ':',
    exists: () => false,
    isExec: () => false,
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

// Every rg test below poisons `exists` (throws if called) so a regression that
// goes back to asking "does it exist?" for an rg candidate fails LOUD, not
// silently — that is exactly how this bug hid the first time (target-env.cjs's
// findOnPath must consult isExec, never exists; see the comment there).
const poisonedExists = () => { throw new Error('exists() must never be consulted for an rg candidate'); };

test('ripgrep: a real rg on PATH switches off the builtin and leaves PATH ALONE', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin:/opt/rg/bin' },
    exists: poisonedExists,
    isExec: (p) => p === '/opt/rg/bin/rg',
  }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '0');
  // Discovery only ever finds rg in a PATH dir, so that dir is ALREADY reachable.
  // Prepending it would reorder PATH and change which binary wins for every other
  // tool in it — applyRipgrepEnv's whole-segment membership test exists to avoid
  // exactly that, so honor it: PATH is untouched.
  assert.strictEqual(env.PATH, '/usr/bin:/opt/rg/bin');
});

test('ripgrep: an rg dir at the FRONT of PATH is not duplicated either', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/opt/rg/bin:/usr/bin' },
    exists: poisonedExists,
    isExec: (p) => p === '/opt/rg/bin/rg',
  }));
  assert.strictEqual(env.PATH, '/opt/rg/bin:/usr/bin');
});

test('ripgrep: CLODE_RG wins verbatim over PATH discovery', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin', CLODE_RG: '/custom/rg' },
    exists: poisonedExists,
    isExec: () => true,
  }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, '0');
  assert.strictEqual(env.PATH, '/custom:/usr/bin');
});

test('ripgrep: no rg anywhere leaves the search config untouched (rg is OPTIONAL)', () => {
  const env = shapeTargetEnv(opts({ env: { PATH: '/usr/bin' }, exists: poisonedExists, isExec: () => false }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, undefined);
  assert.strictEqual(env.PATH, '/usr/bin');
});

test('ripgrep: CLODE_RG already on PATH is not duplicated', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin:/opt/rg/bin', CLODE_RG: '/opt/rg/bin/rg' },
    exists: poisonedExists,
    isExec: () => true,
  }));
  assert.strictEqual(env.PATH, '/usr/bin:/opt/rg/bin', 'membership is whole-segment ANYWHERE in PATH, not just the front');
});

// THE BUG: a DIRECTORY (or a non-executable file) named `rg` sitting earlier on
// PATH than a real rg must NOT win. The retired sh launcher's `[ -x ]` rejected
// both; the port that replaced it with a bare existence check would have let
// either "win" a PATH slot the embedded-search fallback then never got — this
// is the on-box repro from the review, pinned as a regression test.
test('ripgrep: a DIRECTORY named rg on PATH does not win — existence is not runnability', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin' },
    exists: (p) => p === '/usr/bin/rg', // a directory named rg EXISTS at that path
    isExec: () => false,                // but it is not a regular executable file
  }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, undefined, 'a directory must not disable the embedded-search fallback');
  assert.strictEqual(env.PATH, '/usr/bin', 'PATH must not be rewritten for an unrunnable candidate');
});

test('ripgrep: a non-executable FILE named rg on PATH does not win either', () => {
  const env = shapeTargetEnv(opts({
    env: { PATH: '/usr/bin' },
    exists: (p) => p === '/usr/bin/rg',
    isExec: () => false, // exists, is a regular file, but lacks +x
  }));
  assert.strictEqual(env.USE_BUILTIN_RIPGREP, undefined);
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
  const guard = (p) => {
    assert.ok(predicted.has(p), `probed an unpredicted path: ${p}`);
    return false;
  };
  // Both predicates are covered: trustd goes through `exists`, rg candidates
  // through `isExec` — a probePaths drift on either seam must fail loud here.
  shapeTargetEnv(opts({ env, platform: 'darwin', exists: guard, isExec: guard }));
});

// mapPlatform is the userAgentData->node switch quaude-bootstrap.mjs's
// tjsPlatform and the node-shim's detectPlatform both used to duplicate
// (character-for-character). It lives here — the one require-free member
// both a pre-shim tjs bootstrap and the node-shim can evaluate early — so
// there is exactly one copy of the mapping to keep honest across the release
// matrix. It does NOT include detectPlatform's navigator.platform regex
// fallback for an empty ua; that stays local to the node-shim, which has a
// second signal (navigator.platform) quaude's bootstrap never gets to see.
test('mapPlatform: the five named platforms', () => {
  assert.strictEqual(mapPlatform('macOS'), 'darwin');
  assert.strictEqual(mapPlatform('Windows'), 'win32');
  assert.strictEqual(mapPlatform('Linux'), 'linux');
  assert.strictEqual(mapPlatform('FreeBSD'), 'freebsd');
  assert.strictEqual(mapPlatform('OpenBSD'), 'openbsd');
});

test('mapPlatform: an unknown non-empty platform lowercases verbatim', () => {
  assert.strictEqual(mapPlatform('SunOS'), 'sunos');
});

// The quaude-critical default: tjs.system.platform is EMPTY, so
// navigator.userAgentData.platform can itself come back empty/undefined —
// tjsPlatform's fallback for that case is 'linux', not the unknown-platform
// lowercase branch. mapPlatform must preserve it exactly.
test('mapPlatform: empty/undefined input defaults to linux (the quaude fallback)', () => {
  assert.strictEqual(mapPlatform(''), 'linux');
  assert.strictEqual(mapPlatform(undefined), 'linux');
});

// target-env.cjs is evaluated as a fused member under tjs via `new Function`,
// BEFORE the node-shim (and its require) exists. Adding mapPlatform must not
// smuggle in a dependency that breaks that.
test('target-env.cjs stays require-free (evaluated pre-node-shim under tjs)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'target-env.cjs'), 'utf8');
  assert.ok(!src.includes('require('), 'target-env.cjs must not require(...) anything');
});
