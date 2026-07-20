'use strict';
// Host-independent guard for the node-shim's win32 rename-over-existing fix
// (libexec/node-shim/modules/fs.cjs renameReplace). Loads the REAL fs.cjs source
// in a vm context with a mocked `navigator` (to force _isWin) and a mocked
// `__tjs_fs_sync` (FSS) that reproduces tjs's rename semantics — so it runs the
// actual shim code on any platform, like win-shim-guards.test.cjs does for the
// loader.
//
// Why this exists: tjs's FSS.rename is the C library rename(a,b) with no _WIN32
// branch (mod_fs_sync.c). POSIX rename(2) atomically REPLACES an existing target;
// the Windows CRT rename() FAILS with EEXIST when the target exists. The bundle's
// atomic write ends in rename(temp, target) over the existing file, so on Windows
// that step threw and the edit was silently dropped ("Edit did not apply on disk").
// renameReplace emulates POSIX replace on win32 (unlink the target, then rename)
// and leaves POSIX byte-for-byte unchanged.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fsShimSrc = fs.readFileSync(
  path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8');

// A fake __tjs_fs_sync whose rename mirrors the platform under test: on win32 it
// throws EEXIST when the destination exists (the Windows CRT contract); on POSIX it
// replaces. unlink removes a tracked path. Records the call order for assertions.
function makeFSS({ winSemantics }) {
  const files = new Set();
  const calls = [];
  return {
    files, calls,
    add(p) { files.add(p); },
    rename(a, b) {
      calls.push(['rename', a, b]);
      if (!files.has(a)) { const e = new Error(`ENOENT, rename '${a}'`); e.code = 'ENOENT'; throw e; }
      if (winSemantics && files.has(b)) { const e = new Error(`EEXIST, rename '${a}'`); e.code = 'EEXIST'; throw e; }
      files.delete(a); files.add(b); // POSIX: replace
    },
    unlink(p) {
      calls.push(['unlink', p]);
      if (!files.has(p)) { const e = new Error(`ENOENT, unlink '${p}'`); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
    // touched by module eval for other shims; harmless no-ops here
    chmod() {}, stat() { return {}; },
  };
}

// Load the real fs.cjs in an isolated context with mocked platform + FSS.
function loadShim({ win, fss }) {
  const sandbox = {
    module: { exports: {} }, exports: {},
    require, console,
    TextDecoder, TextEncoder, Buffer,
    __tjs_fs_sync: fss,
    // _isWin reads navigator.platform first, then falls back to process.platform.
    navigator: win ? { platform: 'Win32' } : { platform: 'MacIntel' },
    process: { platform: win ? 'win32' : 'linux', env: {} },
  };
  sandbox.globalThis = sandbox; // globalThis.__tjs_fs_sync / globalThis.process resolve here
  vm.createContext(sandbox);
  vm.runInContext(
    `(function (module, exports, require) {\n${fsShimSrc}\n})(module, exports, require);`,
    sandbox, { filename: 'fs.cjs' });
  return sandbox.module.exports;
}

test('win32: renameSync REPLACES an existing target (unlink + retry after EEXIST)', () => {
  const fss = makeFSS({ winSemantics: true });
  fss.add('C:\\proj\\file.tmp.abc'); // the atomic-write temp
  fss.add('C:\\proj\\file');         // the existing target the CRT rename would reject
  const shim = loadShim({ win: true, fss });
  shim.renameSync('C:\\proj\\file.tmp.abc', 'C:\\proj\\file');
  assert.ok(fss.files.has('C:\\proj\\file'), 'target present after replace');
  assert.ok(!fss.files.has('C:\\proj\\file.tmp.abc'), 'temp consumed by the rename');
  assert.deepStrictEqual(fss.calls, [
    ['rename', 'C:\\proj\\file.tmp.abc', 'C:\\proj\\file'], // throws EEXIST
    ['unlink', 'C:\\proj\\file'],                            // drop the existing target
    ['rename', 'C:\\proj\\file.tmp.abc', 'C:\\proj\\file'], // succeeds
  ]);
});

test('win32: promises.rename REPLACES an existing target', async () => {
  const fss = makeFSS({ winSemantics: true });
  fss.add('/t/a'); fss.add('/t/b');
  const shim = loadShim({ win: true, fss });
  await shim.promises.rename('/t/a', '/t/b');
  assert.ok(fss.files.has('/t/b') && !fss.files.has('/t/a'));
});

test('POSIX: renameSync does NOT unlink — a throwing rename propagates (gate holds)', () => {
  // Force win-semantics FSS but POSIX platform: the EEXIST must propagate untouched,
  // proving the unlink+retry fallback is gated to win32 and never runs on POSIX.
  const fss = makeFSS({ winSemantics: true });
  fss.add('/t/a'); fss.add('/t/b');
  const shim = loadShim({ win: false, fss });
  assert.throws(() => shim.renameSync('/t/a', '/t/b'), /EEXIST/);
  assert.deepStrictEqual(fss.calls, [['rename', '/t/a', '/t/b']], 'no unlink on POSIX');
});

test('POSIX: renameSync replaces via the single native rename (no fallback needed)', () => {
  const fss = makeFSS({ winSemantics: false }); // real POSIX rename replaces
  fss.add('/t/a'); fss.add('/t/b');
  const shim = loadShim({ win: false, fss });
  shim.renameSync('/t/a', '/t/b');
  assert.ok(fss.files.has('/t/b') && !fss.files.has('/t/a'));
  assert.deepStrictEqual(fss.calls, [['rename', '/t/a', '/t/b']]);
});
