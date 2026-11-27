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
const { which } = bun;
// The walk itself is libexec/path-lookup.cjs's (the one PATH search); its own rules are pinned in
// test/path-lookup.test.cjs. These tests pin what Bun.which asks of it: pathext: true, windowsCwd: false.

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
});

test('win32: a dotted name that is NOT an executable extension is still probed', () => {
  // `python3.11` ends in ".11": tried as spelled, and as python3.11.exe, which is right there.
  assert.strictEqual(which('python3.11', {
    isWin: true, PATH: 'C:\\py', PATHEXT: '.COM;.EXE', isExec: WIN_WORLD('C:\\py\\python3.11.exe'),
  }), 'C:\\py\\python3.11.exe');
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

test('posix default predicate: one candidate, the bare name — a regular file, then X_OK', () => {
  // stat first (a +x DIRECTORY is not runnable, so node walks past it, and so does this now), X_OK only for a file.
  const { out, calls } = spyFs(() => which('ugrep', { isWin: false, PATH: '/opt/bin' }));
  assert.strictEqual(out, null);
  assert.deepStrictEqual(calls.stat, ['/opt/bin/ugrep'], 'POSIX must probe exactly one candidate, no extensions');
  assert.deepStrictEqual(calls.access, [], 'nothing there: no X_OK asked');
});

test('posix: PATHEXT is never consulted, whatever the environment says', () => {
  const asked = [];
  const prev = process.env.PATHEXT;
  process.env.PATHEXT = '.COM;.EXE';
  try {
    which('ugrep', { isWin: false, PATH: '/opt/bin', PATHEXT: '.COM;.EXE', isExec: (p) => { asked.push(p); return false; } });
    which('ugrep', { isWin: false, PATH: '/opt/bin', isExec: (p) => { asked.push(p); return false; } });
  } finally {
    if (prev === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = prev;
  }
  assert.deepStrictEqual(asked, ['/opt/bin/ugrep', '/opt/bin/ugrep']);
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

test('posix (real FS): a +x DIRECTORY named like the tool is not a match (node walks past it too)', posixOnly, () => {
  const root = tmpbin();
  fs.mkdirSync(path.join(root, 'a', 'ugrep'), { recursive: true, mode: 0o755 });
  const real = mkexe(path.join(root, 'b'), 'ugrep');
  assert.strictEqual(which('ugrep', { PATH: [path.join(root, 'a'), path.join(root, 'b')].join(':') }), real);
});

test('posix (real FS): an empty PATH element means cwd (node\'s rule), answered as a path', posixOnly, () => {
  // (`PATH: ''` would not even reach the walk: an empty string is falsy, so Bun.which falls back to the
  // process's PATH, as Bun does when the caller names none.)
  const dir = tmpbin();
  mkexe(dir, 'ugrep');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.strictEqual(which('ugrep', { PATH: ':' }), './ugrep');
  } finally { process.chdir(cwd); }
});

test('a pathed name is not searched: it answers itself when executable', posixOnly, () => {
  const p = mkexe(tmpbin(), 'ugrep');
  assert.strictEqual(which(p, { PATH: '/nonexistent' }), p);
  assert.strictEqual(which(p + '-missing', { PATH: path.dirname(p) }), null);
});

// ------------------------------------------------------- pathed vs bare ----

test('win32: a pathed name is checked as itself (and its extension spellings), never hunted for on PATH', () => {
  assert.strictEqual(which('C:\\tools\\ugrep', {
    isWin: true, PATH: 'C:\\elsewhere', PATHEXT: '.EXE', isExec: WIN_WORLD('C:\\tools\\ugrep.exe', 'C:\\elsewhere\\C:\\tools\\ugrep.exe'),
  }), 'C:\\tools\\ugrep.exe');
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

// ------------------------------------------------ rg: quaude's own path ----
// grep-native Task 10b (user ruling 2026-10-03: a PATH STRING ONLY, no file created). The bundle resolves rg as
// `Bun.which('rg') ?? 'rg'` (2.1.283's nm/bQ), and its Grep tool (djn) refuses a target outside the working directory
// when that is not absolute: "...ripgrep was found only by name on PATH... Install ripgrep at an absolute path or
// search under the working directory." With a host rg on PATH the bundle got its absolute path and searched; without
// one it refused. So quaude was host-dependent, and told the model to install ripgrep. Bun.which('rg') now answers
// ONE absolute path whatever PATH holds: `rg` beside the binary that runs the bundle (rg.exe on Windows). Nothing is
// ever written there: every rg spawn is answered by quaude's rg by basename (libexec/rg-native.cjs isRgExe), and
// anything that execs the path for real meets ENOENT, never a host rg.
const QUAUDE_RG = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg');
const tripwireDir = () => {
  const dir = tmpbin();
  fs.writeFileSync(path.join(dir, 'rg'), '#!/bin/sh\necho TRIPWIRE-HOST-RG-RAN\nexit 99\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'rg.exe'), 'TRIPWIRE\n');
  return dir;
};

test('rg: Bun.which(\'rg\') answers quaude\'s own absolute path beside the binary, on a host with no rg', () => {
  assert.strictEqual(bun.RG_PATH, QUAUDE_RG, 'stated once, in bun-shim');
  assert.strictEqual(which('rg', { PATH: tmpbin() }), QUAUDE_RG);
  assert.ok(path.isAbsolute(QUAUDE_RG));
  assert.strictEqual(path.basename(QUAUDE_RG), process.platform === 'win32' ? 'rg.exe' : 'rg');
  assert.ok(!fs.existsSync(QUAUDE_RG), `nothing is written at ${QUAUDE_RG}`);
});

test('rg: with a tripwire rg first on PATH, Bun.which(\'rg\') still answers quaude\'s own path, never the host\'s', () => {
  const trip = tripwireDir();
  assert.strictEqual(which('rg', { PATH: trip }), QUAUDE_RG);
  const prev = process.env.PATH;
  process.env.PATH = `${trip}${path.delimiter}${prev}`;
  try { assert.strictEqual(bun.which('rg'), QUAUDE_RG); } finally { process.env.PATH = prev; }
});

test('rg: Bun.which of quaude\'s own path answers itself (the sandbox asks Bun.which(<its rg command>))', () => {
  assert.strictEqual(which(QUAUDE_RG, { PATH: tmpbin() }), QUAUDE_RG);
});

test('rg: a route that execs quaude\'s own path for real meets ENOENT, never a host rg', posixOnly, () => {
  const trip = tripwireDir();
  const r = require('node:child_process').spawnSync('/bin/sh', ['-c', 'exec "$0"', QUAUDE_RG], { encoding: 'utf8', env: { PATH: trip, HOME: process.env.HOME } });
  // the shell's `exec` of a missing file: 127 (dash, zsh), 126 (bash as /bin/sh); ENOENT's own words either way
  assert.ok(r.status === 126 || r.status === 127, `${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /No such file or directory|not found/);
  assert.doesNotMatch(r.stdout + r.stderr, /TRIPWIRE/);
});

test('rg: under tjs, Bun.which(\'rg\') answers the engine\'s own path, with or without a tripwire rg on PATH', (t) => {
  const { tjsPath, runLoader } = require('./node-shim-helper.cjs');
  if (!tjsPath()) { t.skip('no tjs engine'); return; }
  const trip = tripwireDir();
  const probe = path.join(tmpbin(), 'probe.cjs');
  fs.writeFileSync(probe, `const Bun = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'bun-shim.cjs'))});
    process.stdout.write(JSON.stringify({ execPath: process.execPath, RG_PATH: Bun.RG_PATH, none: Bun.which('rg', { PATH: ${JSON.stringify(tmpbin())} }),
      trip: Bun.which('rg', { PATH: ${JSON.stringify(trip)} }), env: Bun.which('rg'), self: Bun.which(Bun.RG_PATH) }));`);
  const r = runLoader(probe, [], { env: { PATH: `${trip}${path.delimiter}${process.env.PATH}` } });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  const want = path.join(path.dirname(o.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg');
  assert.deepStrictEqual(o, { execPath: o.execPath, RG_PATH: want, none: want, trip: want, env: want, self: want });
  assert.ok(!fs.existsSync(want), `nothing is written at ${want}`);
});
