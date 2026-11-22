'use strict';
// node-shim's exclusive create on Windows, reproduced on any host. fs.cjs's createExclusive claims a new path with
// symlink(2) and renames a moded file over its own claim: atomic on POSIX. On Windows the CRT rename() refuses an
// existing destination (the claim) and an open file, so once txiki-sync-links.patch made symlink work there, every
// new file failed "EACCES: unknown error, rename '...\.clode-create-...\f' -> '...'" and left the claim dangling at
// the path (CI 44977529851, windows-arm64-tests: Edit did not apply, the Bash tool's output file, sessions/<pid>.json).
// Windows now creates with the engine's O_EXCL (txiki-sync-open-excl.patch: open(O_CREAT|O_EXCL), CreateFile
// CREATE_NEW, the call node makes for 'wx'), its mode only the read-only attribute as node sets it.
//
// The real fs.cjs runs in a vm sandbox (test/fs-shim-sandbox.cjs) loaded as win32 over an in-memory stand-in for the
// engine whose rename and open answer as the Windows CRT does. The same stand-in under a POSIX load checks the other
// half: a claim the rename could not complete is removed, never left dangling.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const FS_SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8');

// An in-memory filesystem with the Windows CRT's rename and open contracts. Paths are compared as given.
function crtFSS({ openFlags }) {
  const files = new Map(); // path -> { kind: 'file'|'dir'|'symlink', mode, target }
  const open = new Map();  // fd -> path
  let nextFd = 3;
  const calls = [];
  const err = (code, op, p) => Object.assign(new Error(`${code}, ${op} '${p}'`),
    { code, errno: os.constants.errno[code], syscall: op, path: p });
  const st = (e) => ({ size: 0, mode: (e.kind === 'dir' ? 0o40000 : e.kind === 'symlink' ? 0o120000 : 0o100000) | e.mode,
    uid: 0, gid: 0, mtimeMs: 0, kind: e.kind, ino: 1n, dev: 1n });
  const parentOk = (p) => { const d = path.dirname(p); return d === p || d === '/' || (files.get(d) || {}).kind === 'dir'; };
  const fss = {
    calls, files,
    open(p, flags) {
      calls.push(['open', p, flags]);
      let f = flags.replace(/n$/, '');
      const excl = /x$/.test(f); f = f.replace(/x$/, '');
      if (excl && !String(fss.openFlags || '').includes('x')) throw new TypeError('fs_sync.open: bad flags');
      const e = files.get(p);
      if (e && excl) throw err('EEXIST', 'open', p);
      if (!e) {
        if (f === 'r' || f === 'r+') throw err('ENOENT', 'open', p);
        if (!parentOk(p)) throw err('ENOENT', 'open', p);
        files.set(p, { kind: 'file', mode: 0o666 });
      }
      const fd = nextFd++; open.set(fd, p); return fd;
    },
    close(fd) { calls.push(['close', fd]); if (!open.delete(fd)) throw err('EBADF', 'close', String(fd)); },
    fstat(fd) { const p = open.get(fd); return st(files.get(p)); },
    lstat(p) { calls.push(['lstat', p]); const e = files.get(p); if (!e) throw err('ENOENT', 'lstat', p); return st(e); },
    stat(p) { calls.push(['stat', p]); const e = files.get(p); if (!e) throw err('ENOENT', 'stat', p); return st(e); },
    readlink(p) { const e = files.get(p); if (!e || e.kind !== 'symlink') throw err('EINVAL', 'readlink', p); return e.target; },
    mkdir(p) { calls.push(['mkdir', p]); if (files.has(p)) throw err('EEXIST', 'mkdir', p); files.set(p, { kind: 'dir', mode: 0o777 }); },
    rmdir(p) { calls.push(['rmdir', p]); files.delete(p); },
    unlink(p) { calls.push(['unlink', p]); if (!files.delete(p)) throw err('ENOENT', 'unlink', p); },
    chmod(p, m) { calls.push(['chmod', p, m]); const e = files.get(p); if (e) e.mode = m & 0o7777; },
    symlink(t, p) { calls.push(['symlink', t, p]); if (files.has(p)) throw err('EEXIST', 'symlink', p); files.set(p, { kind: 'symlink', mode: 0o777, target: t }); },
    // The CRT contract: an existing destination, or a source still open, is refused (EACCES, as the CI log says).
    rename(a, b) {
      calls.push(['rename', a, b]);
      if (files.has(b) || [...open.values()].includes(a)) throw err('EACCES', 'rename', a);
      files.set(b, files.get(a)); files.delete(a);
    },
    write(fd, buf) { return buf.byteLength; },
    readdir() { return []; },
    realpath(p) { return p; },
    access() {},
  };
  if (openFlags) fss.openFlags = openFlags;
  files.set('/w', { kind: 'dir', mode: 0o777 });
  return fss;
}

// What node-shim's engine-floor-log would append to CLODE_ENGINE_FLOOR_LOG (it writes through the real engine, which
// this sandbox has none of), recorded instead.
const floorLines = [];
function loadShim({ platform, fss, env = {} }) {
  let sandboxRequire = null;
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: (id) => sandboxRequire(id), console,
    TextDecoder, TextEncoder, Buffer, queueMicrotask,
    __tjs_fs_sync: fss,
    navigator: { platform: platform === 'win32' ? 'Win32' : 'MacIntel' },
    process: { platform, pid: 4242, env: {} },
    tjs: { env },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const req = require('./fs-shim-sandbox.cjs').shimRequire(sandbox);
  // the shim's own path is per platform; a win32 load must not get this host's
  sandboxRequire = (id) => {
    if (/^(node:)?path$/.test(String(id))) return path[platform === 'win32' ? 'win32' : 'posix'];
    if (/engine-floor-log\.cjs$/.test(String(id))) return { engineFloorLog: (line) => floorLines.push(line) };
    return req(id);
  };
  vm.runInContext(`(function (module, exports, require) {\n${FS_SRC}\n})(module, exports, require);`, sandbox, { filename: 'fs.cjs' });
  return sandbox.module.exports;
}

test('win32: a new file is created with the engine\'s O_EXCL, never the symlink claim and rename the CRT refuses', () => {
  const fss = crtFSS({ openFlags: 'rwa+xn' });
  const shim = loadShim({ platform: 'win32', fss });
  const fd = shim.openSync('/w/f.txt', 'w');
  shim.closeSync(fd);
  assert.strictEqual((fss.files.get('/w/f.txt') || {}).kind, 'file', 'the file is there');
  assert.deepStrictEqual(fss.calls.filter((c) => c[0] === 'open').map((c) => c[2]), ['wx']);
  assert.ok(!fss.calls.some((c) => c[0] === 'symlink' || c[0] === 'rename' || c[0] === 'mkdir'),
    `no claim, no rename, no staging directory: ${JSON.stringify(fss.calls)}`);
});

test('win32: \'wx\' over an existing file is EEXIST, from the kernel\'s claim, and the file is untouched', () => {
  const fss = crtFSS({ openFlags: 'rwa+xn' });
  const shim = loadShim({ platform: 'win32', fss });
  shim.closeSync(shim.openSync('/w/f.txt', 'wx'));
  assert.throws(() => shim.openSync('/w/f.txt', 'wx'), (e) => e.code === 'EEXIST');
  assert.strictEqual(fss.files.get('/w/f.txt').kind, 'file');
});

test('win32: a mode without owner-write sets the read-only attribute, as node does; one with it sets nothing', () => {
  const fss = crtFSS({ openFlags: 'rwa+xn' });
  const shim = loadShim({ platform: 'win32', fss });
  shim.closeSync(shim.openSync('/w/ro.txt', 'wx', 0o444));
  shim.closeSync(shim.openSync('/w/rw.txt', 'wx', 0o600));
  assert.deepStrictEqual(fss.calls.filter((c) => c[0] === 'chmod'), [['chmod', '/w/ro.txt', 0o444]]);
});

// An engine without 'x' (every released one), two ways. Neither ever takes the symlink claim.
// SHIPPED RUNTIME (no CLODE_ENGINE_FLOOR_LOG; a quaude never has it): refused by name, as the utime and rusage floors
// refuse. An exclusive create is a security property, so a non-exclusive one is never handed out in its place.
test('win32, shipped runtime: an engine without the exclusive open is REFUSED by name; nothing is created', () => {
  floorLines.length = 0;
  const fss = crtFSS({ openFlags: null });
  const shim = loadShim({ platform: 'win32', fss });
  assert.throws(() => shim.openSync('/w/f.txt', 'w'),
    (e) => e.code === 'ERR_CLODE_ENGINE_FLOOR' && /txiki-sync-open-excl\.patch/.test(e.message) && !/check-then-open/.test(e.message));
  assert.ok(!fss.files.has('/w/f.txt'), 'nothing created');
  assert.ok(!fss.calls.some((c) => c[0] === 'open' || c[0] === 'symlink'), JSON.stringify(fss.calls));
});

// BOOTSTRAP (CLODE_ENGINE_FLOOR_LOG set: build-leg sets it on exactly the steps that run on the bootstrap engine, and
// fails the leg on any line): check-then-open, the route released engines always took there, and the line logged.
test('win32, bootstrap engine: without the exclusive open it creates check-then-open and logs it', () => {
  floorLines.length = 0;
  const fss = crtFSS({ openFlags: null });
  const shim = loadShim({ platform: 'win32', fss, env: { CLODE_ENGINE_FLOOR_LOG: '/w/floor.log' } });
  shim.closeSync(shim.openSync('/w/f.txt', 'w'));
  assert.strictEqual((fss.files.get('/w/f.txt') || {}).kind, 'file', 'a file, not a link');
  assert.ok(!fss.calls.some((c) => c[0] === 'symlink' || c[0] === 'rename'), JSON.stringify(fss.calls));
  assert.strictEqual(floorLines.length, 1);
  assert.match(floorLines[0], /no exclusive open .*txiki-sync-open-excl\.patch.*bootstrap engine.*check-then-open/);
});

test('posix: a claim whose rename fails is removed, not left dangling at the path', () => {
  const fss = crtFSS({ openFlags: 'rwa+xn' });
  const shim = loadShim({ platform: 'darwin', fss });
  assert.throws(() => shim.openSync('/w/f.txt', 'w'), (e) => e.code === 'EACCES');
  assert.ok(fss.calls.some((c) => c[0] === 'symlink' && c[2] === '/w/f.txt'), 'the claim was made');
  assert.ok(!fss.files.has('/w/f.txt'), `the claim is gone: ${JSON.stringify([...fss.files])}`);
  assert.deepStrictEqual([...fss.files.keys()], ['/w'], 'and the staging directory with it');
});
