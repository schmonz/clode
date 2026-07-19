'use strict';
// Unit tests for libexec/clode-hosttools.cjs — the JS port of bin/clode's
// host-tool discovery + node-floor enforcement.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findTool } = require('../libexec/clode-hosttools.cjs');

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

test('findTool ignores a non-executable override and walks PATH', () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'notexec'); // never created -> not executable
  const bindir = path.join(dir, 'bin');
  const rg = makeExe(bindir, 'rg');
  const found = findTool('rg', { override: bad, env: { PATH: bindir } });
  assert.strictEqual(found, rg);
});

test('findTool walks PATH in order and finds the first match', () => {
  const dir = tmpdir();
  const d1 = path.join(dir, 'a');
  const d2 = path.join(dir, 'b');
  const rg1 = makeExe(d1, 'rg');
  makeExe(d2, 'rg');
  const found = findTool('rg', { env: { PATH: [d1, d2].join(path.delimiter) } });
  assert.strictEqual(found, rg1);
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
  const dir = tmpdir();
  const rg = makeExe(dir, 'rg');
  assert.strictEqual(findTool('rg', { isWin: false, env: { PATH: dir } }), rg);
});

