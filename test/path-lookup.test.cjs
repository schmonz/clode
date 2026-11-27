'use strict';
// libexec/path-lookup.cjs — THE one PATH search (seven copies before it disagreed; see its header). Its default is
// node's own, libuv's: these tests pin that rule on a real temp-dir fixture for POSIX, and drive win32 through the
// injected platform/env/isExec seams (Windows is not reachable from this box). Each win32 expectation is read from
// libuv's src/win/process.c search_path / path_search_walk_ext; each POSIX one from src/unix/process.c's execvpe
// emulation, and where host node can answer, from node itself (the "node agrees" tests).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PL_SRC = path.join(__dirname, '..', 'libexec', 'path-lookup.cjs');
const { lookPath, pathCandidates, isPathed, leafNames, isExecutableFile } = require(PL_SRC);

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX execute-bit semantics' : false };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-lookup-'));
  const mk = (rel, mode = 0o755, body = '#!/bin/sh\necho "$0"\n') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, { mode });
    fs.chmodSync(p, mode);
    return p;
  };
  return { root, mk };
}

const WIN_WORLD = (...files) => {
  const have = new Set(files.map((f) => f.toLowerCase()));
  return (p) => have.has(String(p).toLowerCase());
};

// ---------------------------------------------------------------- posix ----

test('posix: first match in PATH order wins', posixOnly, () => {
  const { root, mk } = fixture();
  const first = mk('a/tool');
  mk('b/tool');
  assert.strictEqual(lookPath('tool', { env: { PATH: [path.join(root, 'a'), path.join(root, 'b')].join(':') }, platform: 'linux' }), first);
});

test('posix: a non-executable file is skipped, and the walk goes on', posixOnly, () => {
  const { root, mk } = fixture();
  mk('a/tool', 0o644);
  const real = mk('b/tool');
  assert.strictEqual(lookPath('tool', { env: { PATH: `${root}/a:${root}/b` }, platform: 'linux' }), real);
  assert.strictEqual(lookPath('tool', { env: { PATH: `${root}/a` }, platform: 'linux' }), null);
});

test('posix: a directory (even a +x one) is skipped', posixOnly, () => {
  const { root, mk } = fixture();
  fs.mkdirSync(path.join(root, 'a', 'tool'), { recursive: true, mode: 0o755 });
  const real = mk('b/tool');
  assert.strictEqual(lookPath('tool', { env: { PATH: `${root}/a:${root}/b` }, platform: 'linux' }), real);
});

test('posix: an empty PATH entry is the current directory (leading, doubled, trailing, and PATH="")', posixOnly, () => {
  const { root, mk } = fixture();
  mk('tool');
  assert.deepStrictEqual(pathCandidates('tool', { env: { PATH: ':/x::/y:' }, platform: 'linux' }),
    ['./tool', '/x/tool', './tool', '/y/tool', './tool']);
  assert.deepStrictEqual(pathCandidates('tool', { env: { PATH: '' }, platform: 'linux' }), ['./tool']);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.strictEqual(lookPath('tool', { env: { PATH: '/nonexistent:' }, platform: 'linux' }), './tool');
  } finally { process.chdir(cwd); }
  // ...or `cwd`, when the caller names one (a spawn's opts.cwd: relative entries are the child's).
  assert.strictEqual(lookPath('tool', { env: { PATH: ':' }, platform: 'linux', cwd: root }), path.join(root, 'tool'));
});

test('posix: an env with NO PATH searches libuv\'s _PATH_DEFPATH (/usr/bin:/bin)', () => {
  assert.deepStrictEqual(pathCandidates('sh', { env: {}, platform: 'linux' }), ['/usr/bin/sh', '/bin/sh']);
});

test('posix: a name with a slash is not searched; it is the path', posixOnly, () => {
  const { root, mk } = fixture();
  const p = mk('d/tool');
  assert.deepStrictEqual(pathCandidates('./d/tool', { env: { PATH: '/x' }, platform: 'linux' }), ['./d/tool']);
  assert.strictEqual(lookPath(p, { env: { PATH: '/nonexistent' }, platform: 'linux' }), p);
  assert.strictEqual(lookPath(path.join(root, 'd', 'missing'), { env: { PATH: `${root}/d` }, platform: 'linux' }), null);
});

test('posix: PATHEXT never applies, whatever the env says', () => {
  assert.deepStrictEqual(pathCandidates('tool', { env: { PATH: '/x', PATHEXT: '.EXE' }, platform: 'darwin', pathext: true }), ['/x/tool']);
});

test('posix: node agrees — spawn of the bare name runs the same file lookPath answers', posixOnly, () => {
  const { root, mk } = fixture();
  mk('a/tool', 0o644);                       // not executable: node walks past it
  fs.mkdirSync(path.join(root, 'b', 'tool'), { recursive: true }); // a directory: so does node
  const real = mk('c/tool');
  const PATH = ['a', 'b', 'c'].map((d) => path.join(root, d)).join(':');
  const r = spawnSync('tool', [], { env: { PATH, HOME: process.env.HOME }, encoding: 'utf8' });   // the suite's throwaway home
  assert.strictEqual(r.status, 0, String(r.error || r.stderr));
  assert.strictEqual(r.stdout.trim(), real);
  assert.strictEqual(lookPath('tool', { env: { PATH }, platform: process.platform }), real);
});

// ---------------------------------------------------------------- win32 ----

test('win32 default (libuv): cwd first, then PATH; .com then .exe appended; PATHEXT NOT consulted', () => {
  const env = { PATH: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.deepStrictEqual(pathCandidates('ugrep', { env, platform: 'win32' }),
    ['.\\ugrep.com', '.\\ugrep.exe', 'C:\\a\\ugrep.com', 'C:\\a\\ugrep.exe', 'C:\\b\\ugrep.com', 'C:\\b\\ugrep.exe']);
  assert.strictEqual(lookPath('bfs', { env, platform: 'win32', isExec: WIN_WORLD('C:\\a\\bfs.cmd') }), null,
    'node cannot spawn a .cmd by bare name, so the default search does not find one');
});

test('win32: NoDefaultCurrentDirectoryInExePath (any case) turns off the cwd-first search, as it does for libuv', () => {
  assert.deepStrictEqual(pathCandidates('x', { env: { PATH: 'C:\\a', nodefaultcurrentdirectoryinexepath: '' }, platform: 'win32' }),
    ['C:\\a\\x.com', 'C:\\a\\x.exe']);
});

test('win32: the exact name is tried only when it HAS an extension, then the appendices anyway', () => {
  assert.deepStrictEqual(leafNames('ugrep', { platform: 'win32' }), ['ugrep.com', 'ugrep.exe']);
  assert.deepStrictEqual(leafNames('ugrep.exe', { platform: 'win32' }), ['ugrep.exe', 'ugrep.exe.com', 'ugrep.exe.exe']);
  assert.deepStrictEqual(leafNames('python3.11', { platform: 'win32' }), ['python3.11', 'python3.11.com', 'python3.11.exe']);
  assert.deepStrictEqual(leafNames('tool.', { platform: 'win32' }), ['tool.com', 'tool.exe'], 'a trailing dot is no extension');
});

test('win32 pathext: true — the env\'s PATHEXT, lower-cased, deduplicated, malformed entries dropped', () => {
  const env = { PATH: 'C:\\t', PATHEXT: '.Com;EXE;.exe;.CMD;.EXE' };
  assert.deepStrictEqual(leafNames('bfs', { platform: 'win32', env, pathext: true }), ['bfs.com', 'bfs.exe', 'bfs.cmd']);
  assert.strictEqual(lookPath('bfs', { env, platform: 'win32', pathext: true, windowsCwd: false, isExec: WIN_WORLD('C:\\t\\bfs.cmd') }), 'C:\\t\\bfs.cmd');
  // absent PATHEXT -> the documented default's head
  assert.deepStrictEqual(leafNames('x', { platform: 'win32', env: {}, pathext: true }), ['x.com', 'x.exe', 'x.bat', 'x.cmd']);
});

test('win32: PATH and PATHEXT come from the env HANDED to the call (case-insensitive key), never process.env', () => {
  const prev = process.env.PATHEXT;
  process.env.PATHEXT = '.BOGUS';
  try {
    assert.strictEqual(lookPath('ugrep', {
      env: { Path: 'C:\\tools', PathExt: '.EXE' }, platform: 'win32', pathext: true, windowsCwd: false,
      isExec: WIN_WORLD('C:\\tools\\ugrep.exe'),
    }), 'C:\\tools\\ugrep.exe');
  } finally { if (prev === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = prev; }
});

test('win32: PATH slices as libuv slices it — quotes (either kind) stripped, a quoted ; kept, empty slices skipped', () => {
  const env = { PATH: '"C:\\Program Files\\u";;\'C:\\semi;colon\';C:\\t\\' };
  assert.deepStrictEqual(pathCandidates('u', { env, platform: 'win32', windowsCwd: false }), [
    'C:\\Program Files\\u\\u.com', 'C:\\Program Files\\u\\u.exe',
    'C:\\semi;colon\\u.com', 'C:\\semi;colon\\u.exe',
    'C:\\t\\u.com', 'C:\\t\\u.exe',
  ]);
});

test('win32: a backslash, slash or drive colon makes a name pathed — only its own extensions are tried', () => {
  for (const n of ['C:\\t\\ugrep', '.\\ugrep', 'C:ugrep', 'C:/t/ugrep']) assert.strictEqual(isPathed(n, 'win32'), true, n);
  assert.strictEqual(isPathed('C:\\t\\ugrep', 'linux'), false, 'POSIX: a weird bare name');
  assert.strictEqual(isPathed('ugrep.exe', 'win32'), false);
  assert.deepStrictEqual(pathCandidates('C:\\t\\ugrep', { env: { PATH: 'C:\\x' }, platform: 'win32' }), ['C:\\t\\ugrep.com', 'C:\\t\\ugrep.exe']);
});

test('win32 default predicate: a regular file, and X_OK is never asked', () => {
  const calls = [];
  const fsm = {
    statSync: (p) => { calls.push(['stat', p]); return { isFile: () => true }; },
    accessSync: (p, m) => { calls.push(['access', p, m]); throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); },
    constants: { X_OK: 1 },
  };
  assert.strictEqual(isExecutableFile('C:\\t\\u.exe', { isWin: true, fs: fsm }), true);
  assert.deepStrictEqual(calls, [['stat', 'C:\\t\\u.exe']]);
  assert.strictEqual(isExecutableFile('/x', { isWin: false, fs: fsm }), false, 'POSIX does ask X_OK');
});

// ------------------------------------------------- the bootstrap's reach ----

test('evaluates with NO require (quaude\'s bootstrap evaluates it before any module system exists)', () => {
  const mod = { exports: {} };
  (0, new Function('module', 'exports', fs.readFileSync(PL_SRC, 'utf8')))(mod, mod.exports);
  assert.deepStrictEqual(mod.exports.pathCandidates('bwrap', { env: { PATH: '/usr/bin' }, platform: 'linux' }), ['/usr/bin/bwrap']);
});
