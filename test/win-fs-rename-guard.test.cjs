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
const { defineGuard, guardTests } = require('./guard.cjs');

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

// Load a given fs.cjs-shaped source in an isolated context with mocked platform + FSS.
function loadShim(fsShimSrc, { win, fss }) {
  // fs.cjs takes its constants from the ENGINE (internal/engine-constants.cjs),
  // which refuses to guess and therefore refuses to load outside one. This sandbox
  // already stands in for the engine for __tjs_fs_sync; it stands in here too,
  // handing over host node's real tables. These tests exercise rename semantics,
  // not flag translation, so the host's values are both sufficient and honest —
  // and fabricating a table here rather than in the shim is the point: the guess
  // lives in the test, where being wrong fails a test instead of shipping.
  const engineConstants = {
    REQUIRED_ABI: 1,
    fs: require('node:fs').constants,
    signals: require('node:os').constants.signals,
    errno: require('node:os').constants.errno,
    dlopen: require('node:os').constants.dlopen,
    priority: require('node:os').constants.priority,
    UV_UDP_REUSEADDR: require('node:os').constants.UV_UDP_REUSEADDR,
  };
  const sandboxRequire = (id) =>
    (String(id).includes('internal/engine-constants.cjs') ? engineConstants : require(id));
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: sandboxRequire, console,
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

// PURE: `fsShimSrc` is the already-read shim text; every vm load below is
// deterministic given that text plus the mocked FSS — no filesystem I/O.
function scanRenameGuard({ fsShimSrc }) {
  const findings = [];
  let examined = 0;

  examined++;
  try {
    const TEMP = 'C:\\proj\\file.tmp.abc', TARGET = 'C:\\proj\\file';
    const fss = makeFSS({ winSemantics: true });
    fss.add(TEMP); // the atomic-write temp
    fss.add(TARGET);         // the existing target the CRT rename would reject
    const shim = loadShim(fsShimSrc, { win: true, fss });
    shim.renameSync(TEMP, TARGET);
    if (!fss.files.has(TARGET) || fss.files.has(TEMP)) {
      findings.push('win32 renameSync did not correctly replace the existing target');
    }
    // THE CONTRACT IS THE ORDER, not just the end state: libexec/node-shim/modules/fs.cjs
    // documents the unlink as non-atomic, safe ONLY because it runs after the CRT rename
    // has already thrown EEXIST — i.e. only once we KNOW the temp is otherwise ready to
    // replace the target. A shim that unlinks pre-emptively (no try/EEXIST/retry) reaches
    // the same end state (target present, temp gone) through a window where the target is
    // briefly missing entirely — exactly the non-atomicity the real fix exists to bound.
    // Proven: a mutant that unlinks first, then renames unconditionally, passes the
    // end-state check above with { findings: [], examined: 3 } unless this comparison also
    // runs (see the regression test below).
    const expectedCalls = [['rename', TEMP, TARGET], ['unlink', TARGET], ['rename', TEMP, TARGET]];
    if (JSON.stringify(fss.calls) !== JSON.stringify(expectedCalls)) {
      findings.push('win32 renameSync reached the right end state but NOT via try-rename, '
        + 'EEXIST, unlink, retry — the call order is the contract (the unlink is only safe '
        + `after the CRT rename has already failed); calls were ${JSON.stringify(fss.calls)}`);
    }
  } catch (e) {
    findings.push(`win32 renameSync threw instead of replacing an existing target (${e.message}) — `
      + 'the Windows CRT rename() rejects an existing destination and the shim must unlink+retry');
  }

  examined++;
  try {
    const fss = makeFSS({ winSemantics: true });
    fss.add('/t/a'); fss.add('/t/b');
    const shim = loadShim(fsShimSrc, { win: false, fss });
    assert.throws(() => shim.renameSync('/t/a', '/t/b'), /EEXIST/);
    assert.deepStrictEqual(fss.calls, [['rename', '/t/a', '/t/b']]);
  } catch (e) {
    findings.push(`POSIX renameSync must propagate a throwing rename untouched, with no unlink `
      + `fallback (the fallback must be gated to win32 only): ${e.message}`);
  }

  examined++;
  try {
    const fss = makeFSS({ winSemantics: false }); // real POSIX rename replaces
    fss.add('/t/a'); fss.add('/t/b');
    const shim = loadShim(fsShimSrc, { win: false, fss });
    shim.renameSync('/t/a', '/t/b');
    assert.ok(fss.files.has('/t/b') && !fss.files.has('/t/a'));
    assert.deepStrictEqual(fss.calls, [['rename', '/t/a', '/t/b']]);
  } catch (e) {
    findings.push(`POSIX renameSync must replace via the single native rename, with no `
      + `fallback machinery invoked: ${e.message}`);
  }

  return { findings, examined };
}

const guard = defineGuard({
  name: 'win-fs-rename-guard',
  read: () => ({
    fsShimSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8'),
  }),
  scan: scanRenameGuard,
  // I2 (coordinator, 2026-09-04): table-driven — a fixed set of markers checked in ONE
  // named shim file. Floored at the exact measured count (3).
  floor: 3,
  // Models the ORIGINAL bug: renameSync forwards straight to the mocked FSS
  // rename with no unlink+retry fallback, so on win32 it throws EEXIST instead
  // of replacing — exactly the "Edit did not apply on disk" incident.
  control: () => ({
    fsShimSrc: `
      module.exports.renameSync = function (a, b) { return __tjs_fs_sync.rename(a, b); };
      module.exports.promises = { rename: async function (a, b) { return __tjs_fs_sync.rename(a, b); } };
    `,
  }),
});
guardTests(guard);

// Fix round 1 (coordinator review): the end-state check alone gave { findings: [],
// examined: 3 } against exactly this mutant — same end state (target present, temp
// gone), reached by unlinking the target BEFORE attempting the rename at all, never
// discovering whether the CRT rename would have failed. That is the non-atomicity the
// real fix (try, EEXIST, THEN unlink, THEN retry) exists to bound: the mutant's window
// where the target is briefly missing entirely is unconditional, not gated on the CRT
// actually rejecting the destination. The call-order comparison added above must catch it.
test('regression: a mutant that unlinks PRE-EMPTIVELY (no try/EEXIST/retry) is caught by call order', () => {
  const mutant = `
    module.exports.renameSync = function (a, b) {
      try { __tjs_fs_sync.unlink(b); } catch (e) {}
      return __tjs_fs_sync.rename(a, b);
    };
    module.exports.promises = { rename: async function (a, b) { return module.exports.renameSync(a, b); } };
  `;
  const r = scanRenameGuard({ fsShimSrc: mutant });
  assert.ok(r.findings.some((f) => f.includes('call order is the contract')),
    `expected a call-order finding against the pre-emptive-unlink mutant; got: ${JSON.stringify(r.findings)}`);
});

// The async variant is not folded into the guard above: guard.cjs's scan() contract is
// synchronous, and asserting on a promise's resolution needs an await, which a sync scan()
// cannot give without a microtask-flush hack. Real fs.cjs is still exercised directly here.
test('win32: promises.rename REPLACES an existing target', async () => {
  const fsShimSrc = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8');
  const fss = makeFSS({ winSemantics: true });
  fss.add('/t/a'); fss.add('/t/b');
  const shim = loadShim(fsShimSrc, { win: true, fss });
  await shim.promises.rename('/t/a', '/t/b');
  assert.ok(fss.files.has('/t/b') && !fss.files.has('/t/a'));
});
