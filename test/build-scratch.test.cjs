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

test('probeExec probes win32 with a .cmd file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-probe-'));
  const r = S.probeExec(dir, {
    platform: 'win32',
    spawnSync: (file) => {
      // Simulate successful .cmd execution on Windows
      if (file.endsWith('.cmd')) {
        return { status: 42, error: null };
      }
      throw new Error('unexpected file type on win32');
    },
  });
  assert.strictEqual(r.ok, true);
  assert.match(r.reason, /exec probe ran and returned 42/);
});

test('probeExec leaves nothing behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-clean-'));
  S.probeExec(dir);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('probeExec returns {ok:false} for undefined dir, never throws', () => {
  const r = S.probeExec(undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.reason, 'string');
});

test('probeExec returns {ok:false} for null opts, never throws', () => {
  // Use an invalid directory with null opts to trigger write error (not a throw)
  const r = S.probeExec('/definitely/not/writable/with/null-opts', null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.reason, 'string');
});

test('probeExec fails with error branch coverage (real EACCES)', (t) => {
  // Loud skip: root bypasses permission bits, so exec cannot be denied by them.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: permission bits are bypassed, so exec cannot be denied');
    return;
  }
  // Loud skip: win32 does not use POSIX permission bits.
  if (process.platform === 'win32') {
    t.skip('win32: exec-ability is not a POSIX permission bit');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eacces-real-'));
  // Stub fsm.chmodSync to be a no-op so the probe file stays non-executable.
  // This lets probeExec create a real probe file and run the REAL spawnSync against
  // a non-executable file, triggering the actual OS error (not a mock). The error
  // branch (scripts/build-scratch.cjs line 92-93) is only exercised when spawn fails
  // with an error object, which only happens with real, non-executable files.
  const stubFsm = Object.create(fs);
  stubFsm.chmodSync = () => { /* no-op: leave file non-executable */ };

  // Call probeExec with stubbed fsm but REAL spawnSync, so the OS denies exec.
  // This tests the error branch with actual Node error shape ("spawnSync <path> EACCES").
  const r = S.probeExec(dir, { fsm: stubFsm });
  assert.strictEqual(r.ok, false);
  // Match the real error signal (EACCES), not a made-up message. The error object
  // produced by spawn will have "EACCES" in its message when the file is not executable.
  assert.match(r.reason, /EACCES/);
  // Verify cleanup happened even on failure (the critical case, since the probe runs in
  // directories about to be used).
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('probeExec cleans up after a failed probe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-clean-'));
  const r = S.probeExec(dir, {
    spawnSync: () => ({ status: 126, error: null, stderr: Buffer.from('Permission denied') }),
  });
  assert.strictEqual(r.ok, false);
  // Verify the probe file was cleaned up despite failure.
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
