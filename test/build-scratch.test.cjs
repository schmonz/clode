// test/build-scratch.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../scripts/build-scratch.cjs');

function fakeCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-clode-'));
  fs.mkdirSync(path.join(root, 'libexec'), { recursive: true });
  fs.writeFileSync(path.join(root, 'libexec', 'clode-fuse.cjs'), '// marker');
  fs.writeFileSync(path.join(root, 'VERSION'), '0.0.0\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'clode' }));
  return root;
}

test('findCheckoutRoot finds the real repo from a nested path', () => {
  const here = path.join(__dirname, '..', 'libexec', 'node-shim');
  assert.strictEqual(S.findCheckoutRoot(here), fs.realpathSync(path.resolve(__dirname, '..')));
});

test('findCheckoutRoot walks up from deep inside a fake checkout', () => {
  const root = fakeCheckout();
  const deep = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(S.findCheckoutRoot(deep), fs.realpathSync(root));
});

test('an unrelated directory is not a checkout', () => {
  assert.strictEqual(S.findCheckoutRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'))), null);
});

test('a directory with only a VERSION file is not a checkout', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'versiononly-'));
  fs.writeFileSync(path.join(d, 'VERSION'), '1\n');
  assert.strictEqual(S.findCheckoutRoot(d), null);
});

test('a package.json named something else is not a clode checkout', () => {
  const root = fakeCheckout();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'not-clode' }));
  assert.strictEqual(S.findCheckoutRoot(root), null);
});

test('isInsideCheckout is true inside, false outside', () => {
  const root = fakeCheckout();
  assert.strictEqual(S.isInsideCheckout(path.join(root, 'build', 'x')), true);
  assert.strictEqual(S.isInsideCheckout(os.tmpdir()), false);
});

const cp = require('node:child_process');

test('probeExec succeeds in an ordinary temp dir', () => {
  const r = S.probeExec(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-ok-')));
  assert.strictEqual(r.ok, true, `expected exec-able, got: ${r.reason}`);
});

test('probeExec fails when the script cannot run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-no-'));
  const r = S.probeExec(dir, {
    spawnSync: () => ({ status: 126, error: null, stderr: Buffer.from('Permission denied') }),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /exit 126|Permission denied/);
});

test('probeExec fails when the dir is not writable', () => {
  const r = S.probeExec('/definitely/not/a/real/dir/anywhere');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cannot write/i);
});

test('probeExec is skipped on win32, with the reason stated', () => {
  const r = S.probeExec(os.tmpdir(), { platform: 'win32' });
  assert.strictEqual(r.ok, true);
  assert.match(r.reason, /win32/);
});

test('probeExec leaves nothing behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-clean-'));
  S.probeExec(dir);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
