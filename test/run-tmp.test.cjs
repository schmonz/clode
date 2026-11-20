'use strict';
// test/run-tmp.cjs: the per-run temp root, its removal, and the judged check on the original temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RT = require('./run-tmp.cjs');

const REPO = path.resolve(__dirname, '..');

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tmp-'));
  t.after(() => { RT.openUp(d); fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}

test('CONTROL: a file planted in the original temp dir during the run is a named not ok, with its prefix and count', (t) => {
  const original = scratch(t);
  fs.writeFileSync(path.join(original, 'clode-planted-leak-old'), '');
  const before = RT.snapshot(original);
  fs.writeFileSync(path.join(original, 'clode-planted-leak-Ab12Cd'), '');
  fs.mkdirSync(path.join(original, 'clode-planted-leak-Ef34Gh'));
  const found = RT.leaks(before, RT.snapshot(original), { prefixes: ['clode-', 'clode-planted-leak-'] });
  assert.deepStrictEqual(found.map((g) => [g.prefix, g.count]), [['clode-planted-leak-', 2]]);
  const lines = RT.leakLines(found, original);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^not ok - the suite left 2 entries named clode-planted-leak-\* in /);
});

test('a name no repo prefix spells, an ignored name, and the STABLE dirs are not leaks', (t) => {
  const original = scratch(t);
  const before = RT.snapshot(original);
  for (const name of ['com.apple.someone-else', 'clode-run-Ab12Cd', ...Object.keys(RT.STABLE)]) fs.mkdirSync(path.join(original, name));
  assert.deepStrictEqual(RT.leaks(before, RT.snapshot(original), { prefixes: ['clode-', 'harness'], ignore: ['clode-run-Ab12Cd'] }), []);
  assert.deepStrictEqual(RT.leakLines([], original), []);
});

test('repoPrefixes derives the temp-name prefixes this repo spells, and nothing it does not', () => {
  const p = RT.repoPrefixes(REPO);
  for (const known of ['clode-bootstrap-', 'shim-diff-', 'clode-test-state-', 'depscan-fx-', 'clode-test-run-', 'run-tmp-']) {
    assert.ok(p.includes(known), `${known} missing from ${p.length} derived prefixes`);
  }
  assert.ok(!p.some((x) => x.startsWith('com.apple')), 'a macOS daemon name is not ours');
});

test('makeRunRoot points TMPDIR, TMP and TEMP at a clode-run- dir, and the durable-scratch variables at the original', (t) => {
  const original = scratch(t);
  const env = { CLODE_BUILD_SCRATCH: '/operator/set/this' };
  const root = RT.makeRunRoot(original, env, { candidates: [original] });
  assert.strictEqual(path.dirname(root), fs.realpathSync(original));
  assert.ok(path.basename(root).startsWith(RT.ROOT_PREFIX));
  assert.deepStrictEqual([env.TMPDIR, env.TMP, env.TEMP, env[RT.ROOT_ENV]], [root, root, root, root]);
  assert.deepStrictEqual([env[RT.ORIGINAL_ENV], env.CLODE_TJS_LOCAL_ROOT, env.CLODE_BUILD_SCRATCH],
    [original, original, '/operator/set/this']);
});

test('the root goes under the shorter writable candidate, never a missing one', (t) => {
  const long = path.join(scratch(t), 'a-rather-long-directory-name');
  fs.mkdirSync(long);
  const short = scratch(t);
  assert.strictEqual(RT.rootParent(long, { candidates: [long, short] }), fs.realpathSync(short));
  assert.strictEqual(RT.rootParent(long, { candidates: [long, path.join(short, 'absent')] }), fs.realpathSync(long));
});

test('removeRunRoot removes a root holding a chmod 0 directory, which a plain recursive rm cannot', { skip: process.platform === 'win32' || process.getuid() === 0 ? 'mode 0 does not stop this user (Windows, or root)' : false }, (t) => {
  const make = () => {
    const original = scratch(t);
    const root = RT.makeRunRoot(original, {}, { candidates: [original] });
    const shut = path.join(RT.makeFileDir(root, 'x/shim-diff.test.cjs'), 'case');
    fs.mkdirSync(shut);
    fs.writeFileSync(path.join(shut, 'f'), '');
    fs.chmodSync(shut, 0);
    return root;
  };
  // control: the plain removal refuses (macOS says ENOTEMPTY, Linux EACCES)
  const plain = make();
  assert.throws(() => fs.rmSync(plain, { recursive: true, force: true }), /EACCES|EPERM|ENOTEMPTY/);
  const root = make();
  RT.removeRunRoot(root);
  assert.strictEqual(fs.existsSync(root), false);
});

test('under test/run.mjs this file\'s os.tmpdir() is its own dir under the per-run root', {
  skip: process.env[RT.ROOT_ENV] ? false : `not run by test/run.mjs (no ${RT.ROOT_ENV})`,
}, () => {
  const mine = os.tmpdir();
  assert.strictEqual(path.dirname(mine), process.env[RT.ROOT_ENV]);
  assert.ok(path.basename(mine).startsWith('run-tmp-'), mine);
  assert.deepStrictEqual([process.env.TMP, process.env.TEMP], [mine, mine]);
});
