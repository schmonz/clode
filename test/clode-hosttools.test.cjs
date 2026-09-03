'use strict';
// Unit tests for libexec/clode-hosttools.cjs — the JS port of bin/clode's
// host-tool discovery + node-floor enforcement.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findTool, isExecutableFile } = require('../libexec/clode-hosttools.cjs');

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

// These two exercise the REAL filesystem with bare (extension-less) executables +
// X_OK — POSIX host-tool semantics. On win32 findTool resolves via PATHEXT and never
// probes a bare `rg`, so the POSIX form cannot match; skip it there and cover the
// same behavior with the win32 real-FS twins immediately below (write `rg.exe`, expect
// PATHEXT resolution). Real Windows findTool coverage also comes from the
// `provision resolves a real sha256/tar tool` integration tests in host-provision.
test('findTool ignores a non-executable override and walks PATH',
  { skip: process.platform === 'win32' }, () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'notexec'); // never created -> not executable
  const bindir = path.join(dir, 'bin');
  const rg = makeExe(bindir, 'rg');
  const found = findTool('rg', { override: bad, env: { PATH: bindir } });
  assert.strictEqual(found, rg);
});

test('findTool on win32 ignores a non-executable override and walks PATH (PATHEXT)',
  { skip: process.platform !== 'win32' && 'win32-only: exercises PATHEXT resolution, which only exists on Windows' }, () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'notexec'); // never created -> not executable
  const bindir = path.join(dir, 'bin');
  makeExe(bindir, 'rg.exe');             // the real tool ships as rg.exe
  const found = findTool('rg', { override: bad, env: { PATH: bindir } });
  assert.match(found || '', /[\\/]rg\.exe$/i); // PATHEXT resolved rg -> rg.EXE
});

test('findTool walks PATH in order and finds the first match',
  { skip: process.platform === 'win32' }, () => {
  const dir = tmpdir();
  const d1 = path.join(dir, 'a');
  const d2 = path.join(dir, 'b');
  const rg1 = makeExe(d1, 'rg');
  makeExe(d2, 'rg');
  const found = findTool('rg', { env: { PATH: [d1, d2].join(path.delimiter) } });
  assert.strictEqual(found, rg1);
});

test('findTool on win32 walks PATH in order and finds the first match (PATHEXT)',
  { skip: process.platform !== 'win32' && 'win32-only: exercises PATHEXT resolution, which only exists on Windows' }, () => {
  const dir = tmpdir();
  const d1 = path.join(dir, 'a');
  const d2 = path.join(dir, 'b');
  makeExe(d1, 'rg.exe');
  makeExe(d2, 'rg.exe');
  const found = findTool('rg', { env: { PATH: [d1, d2].join(path.delimiter) } });
  assert.ok(found && found.toLowerCase().startsWith(d1.toLowerCase()),
    `expected a match under ${d1}, got ${found}`);
});

test('findTool returns null when nothing is found', () => {
  const dir = tmpdir();
  assert.strictEqual(findTool('definitely-not-a-tool', { env: { PATH: dir } }), null);
});

// --- findTool: Windows resolves bare tool names via PATHEXT -----------------
// On Windows the host tools are certutil.exe / tar.exe; a bare-name PATH walk
// (the POSIX `command -v` behavior) finds nothing, so provision('sha256'|'tar')
// wrongly reports "no tool found" even though certutil/tar ship with Windows.
// Host-independent: inject isWin + isExec, match on basename (path.join's
// separator differs by host).
test('findTool probes PATHEXT for a bare name on win32 (certutil -> certutil.EXE)', () => {
  const isExec = (p) => /[\\/]certutil\.EXE$/.test(p); // only the .EXE exists
  const found = findTool('certutil', {
    isWin: true,
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    isExec,
  });
  assert.match(found || '', /certutil\.EXE$/);
});

test('findTool on win32 leaves a name that already has an extension alone', () => {
  const isExec = (p) => /[\\/]tar\.exe$/.test(p) && !/tar\.exe\./.test(p);
  const found = findTool('tar.exe', {
    isWin: true,
    env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE' },
    isExec,
  });
  assert.match(found || '', /[\\/]tar\.exe$/);
});

test('findTool on non-win32 does NOT append extensions (POSIX bare name)', () => {
  // isWin:false must resolve the BARE name with no PATHEXT probing. Host-independent:
  // inject isExec keyed on basename (path.join's separator differs by host) and use a
  // synthetic POSIX PATH — a real Windows tmpdir path would break the POSIX ':' split
  // on the drive-letter colon, and X_OK is a no-op on Windows.
  const isExec = (p) => /[\\/]rg$/.test(p); // only a bare `rg` (no appended extension)
  const found = findTool('rg', { isWin: false, env: { PATH: '/opt/bin' }, isExec });
  assert.match(found || '', /[\\/]rg$/);
});

// --- win32: X_OK is not a question Windows can answer ----------------------
//
// MEASURED, on the windows-amd64 and windows-arm64 legs of CI run 33245690046: the fused builder
// reported `[tried: zstd: not found; unzstd: not found; zstdcat: not found]` while a `zstd` was
// demonstrably on PATH in that same job (actions/cache ran `tar --use-compress-program "zstd -d"`
// seconds earlier). Nothing was missing; the PREDICATE was answering no.
//
// `isExecutableFile` asked `accessSync(p, X_OK)`. Under quaude/tjs that is __tjs_fs_sync.access ->
// the CRT's `_access`, which validates its mode as `(mode & ~6) == 0` and so rejects X_OK (1) with
// EINVAL for EVERY path, existing or not. Under Node/libuv the identical call is a no-op that
// succeeds — which is why every Node-side test passed and only the shipped tjs binary failed.
// libexec/bun-shim.cjs:825-843 had already reasoned this out and answers with a stat on win32; it
// noted the claim was "UNVERIFIED ON WINDOWS". These two legs verified it.
//
// So on win32 the honest question is "is it a regular file" — there is no execute bit to ask
// about, and the PATHEXT probing above is what makes the name mean an executable. POSIX is
// unchanged, byte for byte.
// Host-independent, like the PATHEXT rows above: `path.join` uses THIS host's separator, so the
// fake keys on the leaf name rather than the full path (a posix host builds `C:\tools/zstd.EXE`).
function winAccessFs(leafRe) {
  return {
    statSync: (p) => { if (!leafRe.test(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
                       return { isFile: () => true }; },
    // The CRT's _access, faithfully: any mode with a bit outside 0o6 is EINVAL.
    accessSync: (p, m) => { if ((m & ~6) !== 0) { const e = new Error('EINVAL'); e.code = 'EINVAL'; throw e; } },
    constants: { X_OK: 1, F_OK: 0 },
  };
}

test('isExecutableFile on win32 asks for a regular file, not X_OK (which _access rejects)', () => {
  const fsm = winAccessFs(/zstd\.EXE$/);
  assert.strictEqual(isExecutableFile('C:\\tools\\zstd.EXE', { fs: fsm, isWin: true }), true,
    'a real .EXE must resolve even though _access(X_OK) is EINVAL for every path');
  assert.strictEqual(isExecutableFile('C:\\tools\\absent.EXE', { fs: fsm, isWin: true }), false,
    'and a missing file must still answer no');
});

test('isExecutableFile on POSIX still requires the execute bit', () => {
  const fsm = {
    statSync: () => ({ isFile: () => true }),
    accessSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    constants: { X_OK: 1, F_OK: 0 },
  };
  assert.strictEqual(isExecutableFile('/usr/bin/rg', { fs: fsm, isWin: false }), false,
    'POSIX behaviour is unchanged: no +x, no.');
});

// The end-to-end shape of the CI failure: a tool that IS on PATH, on a host whose access()
// rejects X_OK. Before the fix findTool returns null here and provision reports "not found".
test('findTool resolves a real .EXE on a win32 host whose access() rejects X_OK', () => {
  const found = findTool('zstd', {
    isWin: true, fs: winAccessFs(/zstd\.EXE$/),
    env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  });
  assert.match(found || '', /zstd\.EXE$/);
});
