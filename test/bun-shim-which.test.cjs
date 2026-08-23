'use strict';
// Bun.which — PATH resolution, on BOTH platforms, from either.
//
// WHY THIS EXISTS. `which()` walked PATH looking for a file named exactly `bin`
// and accepted it on fs.accessSync(X_OK). On Windows neither half holds: the
// executable is `ugrep.exe`, so the bare-name join never matched, and X_OK is not
// a question Windows answers (under the tjs engine the CRT's _access rejects
// mode 1 outright). Every caller reads a null as "the applet is not installed",
// so a real Windows quaude with ugrep on PATH refused every rg-derived file
// search via _rgAppletMissing — silently, and for a reason no user could guess.
//
// Windows itself is NOT reachable from this box, so the win32 behaviour is
// driven through injected seams (isWin/PATHEXT/isExec) rather than mocked out:
// the code under test is the shipped code, only its platform and its
// "does this file exist" answer come from the test. Same shape as
// test/clode-hosttools.test.cjs's findTool tests. The POSIX half is checked
// against the REAL filesystem, because it can be.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bun = require('../libexec/bun-shim.cjs');
const { which, _whichLeaves, _exeIsPathed } = bun;

const WIN_WORLD = (...files) => {
  const have = new Set(files.map((f) => f.toLowerCase()));
  // Windows filesystems are case-insensitive: model that, or a test would pass
  // for a reason (exact case) that a real Windows box does not enforce.
  return (p) => have.has(String(p).toLowerCase());
};

// ---------------------------------------------------------------- win32 ----

test('win32: a bare name resolves through PATHEXT, extension included', () => {
  const found = which('ugrep', {
    isWin: true,
    PATH: 'C:\\tools',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    isExec: WIN_WORLD('C:\\tools\\ugrep.exe'),
  });
  // The extension is not cosmetic: libuv's path_search_walk_ext tries the exact
  // name only when it HAS one (deps/libuv/src/win/process.c), so the spawn that
  // follows needs it for anything that is not .com/.exe.
  assert.strictEqual(found, 'C:\\tools\\ugrep.exe');
});

test('win32: PATHEXT beyond .exe resolves too (a .cmd shim)', () => {
  const found = which('bfs', {
    isWin: true,
    PATH: 'C:\\tools',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    isExec: WIN_WORLD('C:\\tools\\bfs.cmd'),
  });
  assert.strictEqual(found, 'C:\\tools\\bfs.cmd');
});

test('win32: PATHEXT entries are honoured case-insensitively', () => {
  const found = which('ugrep', {
    isWin: true,
    PATH: 'C:\\tools',
    PATHEXT: '.Com;.ExE',                       // as some machines really spell it
    isExec: WIN_WORLD('C:\\tools\\ugrep.exe'),
  });
  assert.strictEqual(found, 'C:\\tools\\ugrep.exe');
});

test('win32: a name that already carries an extension still resolves', () => {
  const found = which('ugrep.exe', {
    isWin: true,
    PATH: 'C:\\tools',
    PATHEXT: '.COM;.EXE',
    isExec: WIN_WORLD('C:\\tools\\ugrep.exe'),
  });
  assert.strictEqual(found, 'C:\\tools\\ugrep.exe');
  // ...and a name that already spells an executable extension gets no appendices:
  // no ugrep.exe.exe, no ugrep.exe.com.
  assert.deepStrictEqual(_whichLeaves('ugrep.exe', true, '.COM;.EXE'), ['ugrep.exe']);
});

test('win32: a dotted name that is NOT an executable extension is still probed', () => {
  // `python3.11` ends in ".11", which is not in PATHEXT — treating it as
  // "already has an extension" would lose python3.11.exe, which is right there.
  assert.deepStrictEqual(_whichLeaves('python3.11', true, '.COM;.EXE'),
    ['python3.11', 'python3.11.com', 'python3.11.exe']);
});

test('win32: PATH is split on ; and walked in order', () => {
  const found = which('ugrep', {
    isWin: true,
    PATH: 'C:\\first;C:\\second',
    PATHEXT: '.EXE',
    isExec: WIN_WORLD('C:\\first\\ugrep.exe', 'C:\\second\\ugrep.exe'),
  });
  assert.strictEqual(found, 'C:\\first\\ugrep.exe');
});

test('win32: a quoted PATH element is unquoted before the join', () => {
  const found = which('ugrep', {
    isWin: true,
    PATH: '"C:\\Program Files\\ugrep";C:\\other',
    PATHEXT: '.EXE',
    isExec: WIN_WORLD('C:\\Program Files\\ugrep\\ugrep.exe'),
  });
  assert.strictEqual(found, 'C:\\Program Files\\ugrep\\ugrep.exe');
  // libuv accepts either quote character when it walks the same PATH, so we do
  // too — otherwise which() and the spawn that follows it disagree.
  assert.strictEqual(which('ugrep', {
    isWin: true,
    PATH: "'C:\\Program Files\\ugrep'",
    PATHEXT: '.EXE',
    isExec: WIN_WORLD('C:\\Program Files\\ugrep\\ugrep.exe'),
  }), 'C:\\Program Files\\ugrep\\ugrep.exe');
});

test('win32: an empty PATH element does NOT search the current directory', () => {
  // Windows would; we decline. `ugrep.exe` (relative) is exactly what an empty
  // element joins to, and it must never be returned.
  const found = which('ugrep', {
    isWin: true,
    PATH: ';;',
    PATHEXT: '.EXE',
    isExec: WIN_WORLD('ugrep.exe', 'ugrep'),
  });
  assert.strictEqual(found, null);
});

test('win32: a PATHEXT entry without a leading dot is ignored, not concatenated', () => {
  assert.deepStrictEqual(_whichLeaves('ugrep', true, 'EXE;.exe'), ['ugrep', 'ugrep.exe']);
});

test('win32: nothing on PATH -> null', () => {
  assert.strictEqual(which('ugrep', {
    isWin: true, PATH: 'C:\\tools', PATHEXT: '.EXE', isExec: WIN_WORLD(),
  }), null);
});

// The default predicate matters as much as the extension probing: an X_OK probe
// is the OTHER half of why a Windows quaude found nothing. Spy on the fs the shim
// actually calls (require('fs') is one shared module object).
function spyFs(fn) {
  const realStat = fs.statSync, realAccess = fs.accessSync;
  const calls = { stat: [], access: [] };
  fs.statSync = (p) => { calls.stat.push(p); if (String(p).toLowerCase().endsWith('ugrep.exe')) return { isFile: () => true }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  fs.accessSync = (p, m) => { calls.access.push([p, m]); const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  try { return { out: fn(), calls }; } finally { fs.statSync = realStat; fs.accessSync = realAccess; }
}

test('win32 default predicate: stats the candidate, never asks for X_OK', () => {
  const { out, calls } = spyFs(() => which('ugrep', { isWin: true, PATH: 'C:\\tools', PATHEXT: '.EXE' }));
  assert.strictEqual(out, 'C:\\tools\\ugrep.exe');
  assert.deepStrictEqual(calls.access, [],
    'X_OK on Windows answers nothing (and under tjs the CRT rejects mode 1 with EINVAL)');
  assert.ok(calls.stat.length >= 1, 'the win32 predicate must stat');
});

// ---------------------------------------------------------------- posix ----

test('posix default predicate: X_OK on the bare name, and no extension probing', () => {
  const { out, calls } = spyFs(() => which('ugrep', { isWin: false, PATH: '/opt/bin' }));
  assert.strictEqual(out, null);
  assert.deepStrictEqual(calls.access, [['/opt/bin/ugrep', fs.constants.X_OK]],
    'POSIX must probe exactly one candidate, with X_OK — unchanged');
  assert.deepStrictEqual(calls.stat, [], 'POSIX must not have grown a stat');
});

test('posix: PATHEXT is never consulted, whatever the environment says', () => {
  assert.deepStrictEqual(_whichLeaves('ugrep', false, '.COM;.EXE'), ['ugrep']);
  const prev = process.env.PATHEXT;
  process.env.PATHEXT = '.COM;.EXE';
  try {
    assert.deepStrictEqual(_whichLeaves('ugrep', false, undefined), ['ugrep']);
  } finally {
    if (prev === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = prev;
  }
});

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX X_OK semantics' : false };

function tmpbin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-which-'));
  return dir;
}
function mkexe(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

test('posix (real FS): finds the first executable of that exact name on PATH', posixOnly, () => {
  const root = tmpbin();
  const d1 = path.join(root, 'a'), d2 = path.join(root, 'b');
  const first = mkexe(d1, 'ugrep');
  mkexe(d2, 'ugrep');
  assert.strictEqual(which('ugrep', { PATH: [d1, d2].join(':') }), first);
});

test('posix (real FS): a non-executable file is not a match', posixOnly, () => {
  const dir = tmpbin();
  fs.writeFileSync(path.join(dir, 'ugrep'), 'not executable\n', { mode: 0o644 });
  assert.strictEqual(which('ugrep', { PATH: dir }), null);
});

test('posix (real FS): a ugrep.exe does NOT satisfy `ugrep`', posixOnly, () => {
  const dir = tmpbin();
  mkexe(dir, 'ugrep.exe');
  assert.strictEqual(which('ugrep', { PATH: dir }), null,
    'PATHEXT probing must not leak onto POSIX');
});

test('posix (real FS): an empty PATH element still means cwd, as it always did', posixOnly, () => {
  // Not a property worth having — it is just the property this function HAS, and
  // "fix which() for Windows" is not the commit that gets to change it on POSIX.
  // (`PATH: ''` would not even reach the walk: an empty string is falsy, so the
  // caller's PATH falls back to the environment's. That, too, is pre-existing.)
  const dir = tmpbin();
  mkexe(dir, 'ugrep');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.strictEqual(which('ugrep', { PATH: ':' }), 'ugrep');
  } finally { process.chdir(cwd); }
});

// ------------------------------------------------------- pathed vs bare ----

test('_exeIsPathed: win32 counts a backslash and a drive letter; POSIX does not', () => {
  assert.strictEqual(_exeIsPathed('ugrep', false), false);
  assert.strictEqual(_exeIsPathed('/usr/bin/ugrep', false), true);
  assert.strictEqual(_exeIsPathed('C:\\tools\\ugrep.exe', false), false); // POSIX: a weird bare name
  assert.strictEqual(_exeIsPathed('C:\\tools\\ugrep.exe', true), true);
  assert.strictEqual(_exeIsPathed('.\\ugrep.exe', true), true);
  assert.strictEqual(_exeIsPathed('C:ugrep.exe', true), true);           // drive-relative
  assert.strictEqual(_exeIsPathed('ugrep.exe', true), false);
  assert.strictEqual(_exeIsPathed('C:/tools/ugrep.exe', true), true);
});

test('spawn (posix): a bare command absent from PATH throws synchronously', posixOnly, () => {
  const prev = process.env.PATH;
  process.env.PATH = tmpbin();
  try {
    assert.throws(() => bun.spawn(['definitely-not-a-tool-xyz']),
      /Executable not found in \$PATH/);
  } finally { process.env.PATH = prev; }
});

test('spawn (posix): a pathed non-executable throws the pathed message', posixOnly, () => {
  const dir = tmpbin();
  const p = path.join(dir, 'nope');
  fs.writeFileSync(p, 'x\n', { mode: 0o644 });
  assert.throws(() => bun.spawn([p]), /Executable not found: /);
});
