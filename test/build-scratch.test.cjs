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
  // Portable fixture: create a real file, then try to create a directory under it.
  // mkdirSync fails on both Windows and POSIX when the parent is a regular file,
  // so this exercises the "cannot write" path portably without per-platform skips.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-writable-'));
  const fileNotDir = path.join(baseDir, 'blockfile');
  fs.writeFileSync(fileNotDir, 'not a directory');
  const dirUnderFile = path.join(fileNotDir, 'subdir');

  const r = S.probeExec(dirUnderFile);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cannot write/i);
});

test('probeExec probes win32 with correct interpreter invocation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-probe-'));
  // Verify the win32 branch calls spawnSync with the interpreter (cmd.exe) and
  // arguments ['/c', marker], not a bare marker. This is required since CVE-2024-27980.
  let invokedCorrectly = false;
  const r = S.probeExec(dir, {
    platform: 'win32',
    spawnSync: (interpreter, args, opts) => {
      // Verify this is cmd.exe-style invocation, not bare marker.
      if ((interpreter === 'cmd.exe' || interpreter.endsWith('\\cmd.exe')) &&
          Array.isArray(args) && args[0] === '/c' && args[1].endsWith('.cmd')) {
        invokedCorrectly = true;
        return { status: 42, error: null };
      }
      throw new Error(`unexpected invocation: ${interpreter} ${JSON.stringify(args)}`);
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(invokedCorrectly, true, 'spawnSync must be called with interpreter + [/c, marker]');
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

test('candidate order is CLODE_BUILD_SCRATCH, TMPDIR, tmpdir, cache', () => {
  const names = S.scratchCandidates({
    CLODE_BUILD_SCRATCH: '/a', TMPDIR: '/b', HOME: '/h',
  }).map((c) => c.name);
  assert.deepStrictEqual(names, ['CLODE_BUILD_SCRATCH', 'TMPDIR', 'os.tmpdir()', 'cacheBase']);
});

test('scratchRoot picks the first exec-able candidate outside a checkout', () => {
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'good-'));
  const root = S.scratchRoot({ CLODE_BUILD_SCRATCH: good, HOME: os.homedir() });
  assert.strictEqual(root, good);
});

test('scratchRoot SKIPS a candidate inside a checkout and falls through', () => {
  const inTree = path.join(fakeCheckout(), '.matrix', 'tjs-vendor');
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'fallthrough-'));
  const root = S.scratchRoot({ CLODE_BUILD_SCRATCH: inTree, TMPDIR: good, HOME: os.homedir() });
  assert.strictEqual(root, good);
});

test('scratchRoot throws naming EVERY candidate and its rejection reason', () => {
  const inTree = path.join(fakeCheckout(), '.matrix');
  assert.throws(
    () => S.scratchRoot(
      { CLODE_BUILD_SCRATCH: inTree, TMPDIR: '/no/such/dir', HOME: '/no/such/home' },
      { probe: () => ({ ok: false, reason: 'stubbed noexec' }) },
    ),
    (e) => {
      assert.strictEqual(e.code, 'CLODE_BUILD_SCRATCH');
      assert.match(e.message, /CLODE_BUILD_SCRATCH/);
      assert.match(e.message, /inside a clode source checkout/);
      assert.match(e.message, /TMPDIR/);
      assert.match(e.message, /stubbed noexec/);
      return true;
    },
  );
});

test('buildPath refuses to hand back a path inside the checkout', () => {
  // Belt-and-braces scenario per the design notes: scratchRoot legitimately picks a
  // GOOD root (a sibling of the checkout, not inside it), but the caller's own
  // segments walk back in via '..'. A prior version of this test instead pointed
  // CLODE_BUILD_SCRATCH itself in-checkout with an always-ok probe stub and no
  // TMPDIR: that can never throw, because os.tmpdir() is an unconditional 4th
  // candidate scratchRoot falls through to (proven by direct execution), so the
  // stub accepts it and a legitimate out-of-checkout root is returned. Testing the
  // actual escape path this comment describes is what the design note asked for.
  const checkout = fakeCheckout();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buildpath-root-'));
  const escape = path.relative(scratch, checkout);
  assert.throws(
    () => S.buildPath(escape, 'build', { env: { CLODE_BUILD_SCRATCH: scratch, HOME: os.homedir() } }),
    /CLODE_BUILD_SCRATCH|checkout/,
  );
});

const PT = require('../scripts/platform-tag.cjs');

test('toolchainDir/tjsDir/harnessDir no longer live in the checkout', () => {
  const repo = path.resolve(__dirname, '..');
  for (const fn of ['toolchainDir', 'tjsDir', 'harnessDir']) {
    const d = PT[fn](repo);
    assert.strictEqual(S.isInsideCheckout(d), false, `${fn} returned an in-checkout path: ${d}`);
  }
});

test('artifactDir DOES stay in the checkout — it is the copy-back target', () => {
  const repo = path.resolve(__dirname, '..');
  const d = PT.artifactDir(repo, { version: '0.0.0' });
  assert.strictEqual(d.startsWith(path.join(repo, 'build')), true, `artifactDir moved: ${d}`);
});
