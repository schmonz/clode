'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { shapeTargetEnv, probePaths, mapPlatform } = require('../libexec/target-env.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

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

// Auto-update is notify-only now (a version check, no rebuild), so a built
// target no longer bakes a builder path or its own kind/path into the env.
// These vars are RETIRED — shapeTargetEnv must never set them, even if a stale
// caller still passes the old opts.
test('no rebuild env baked: CLODE_SELF / CLODE_TARGET_KIND / CLODE_TARGET are never set', () => {
  const env = shapeTargetEnv(opts({ self: '/usr/local/bin/clode', targetKind: 'quaude', targetPath: '/usr/local/bin/quaude' }));
  assert.ok(!('CLODE_SELF' in env), 'CLODE_SELF is retired');
  assert.ok(!('CLODE_TARGET_KIND' in env), 'CLODE_TARGET_KIND is retired');
  assert.ok(!('CLODE_TARGET' in env), 'CLODE_TARGET is retired');
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
function scanRequireFree({ src }) {
  const findings = [];
  // Coordinator fix round 1: a hardcoded `const examined = 1` reads OK even against an
  // EMPTY file (src === '') — floor 1 can never fire because 1 is never less than 1,
  // whatever src actually contains. Tying examined to whether there is any source at
  // all (0 for an emptied file, 1 otherwise) makes floor 1 mean something: a
  // target-env.cjs truncated/emptied to '' now reads BROKEN, not a clean OK.
  const examined = src.length > 0 ? 1 : 0;
  if (src.includes('require(')) {
    findings.push('target-env.cjs contains require(...) — it is evaluated pre-node-shim under '
      + 'tjs via `new Function`, before require exists');
  }
  return { findings, examined };
}

const requireFreeGuard = defineGuard({
  name: 'target-env-require-free',
  read: () => ({ src: fs.readFileSync(path.join(__dirname, '..', 'libexec', 'target-env.cjs'), 'utf8') }),
  scan: scanRequireFree,
  // I2 (coordinator, 2026-09-04): CANNOT be usefully floored above the default 1, and
  // this is a fact about the check, not an oversight — scanRequireFree's own `examined`
  // is a whole-file boolean (1 if the file has any content, 0 if empty), because the
  // property under test ("this ONE file contains no require(...) anywhere") has no
  // smaller unit to count; it is not a table of N markers that could partially regress.
  // Floor 1 already sits at its own ceiling: the only thing a higher floor could ever
  // distinguish is "the file is empty" (examined 0) from "the file has content"
  // (examined 1), which floor 1 already does. Documented here rather than left silently
  // at the default, per the whole-branch review's instruction not to fake a floor this
  // guard genuinely cannot have.
  floor: 1,
  control: () => ({ src: "const fs = require('node:fs');\n" }),
});
guardTests(requireFreeGuard);
