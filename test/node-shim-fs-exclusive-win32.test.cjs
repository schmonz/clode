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
const { defineGuard, guardTests } = require('./guard.cjs');

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
let floorLines = [];
function loadShim(fsShimSrc, { platform, fss, env = {} }) {
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
  vm.runInContext(`(function (module, exports, require) {\n${fsShimSrc}\n})(module, exports, require);`, sandbox, { filename: 'fs.cjs' });
  return sandbox.module.exports;
}

// The error a call threw, or null.
const thrown = (f) => { try { f(); return null; } catch (e) { return e; } };
const cmd = (fss, op) => fss.calls.filter((c) => c[0] === op);

// Each scenario loads the given fs.cjs source and answers the problems it saw ([] when it behaves as node does).
const OLD_ENGINE_ENVS = [['', {}],
  // The control for the hole a security review found in an earlier cut, which fell back to check-then-open whenever
  // this variable was set; any user's environment can set it.
  [' (CLODE_ENGINE_FLOOR_LOG set: no environment opens a way around it)', { CLODE_ENGINE_FLOOR_LOG: '/w/floor.log' }]];
const SCENARIOS = [
  ['win32: a new file is created with the engine\'s O_EXCL, never the symlink claim and rename the CRT refuses', (src) => {
    const fss = crtFSS({ openFlags: 'rwa+xn' });
    const shim = loadShim(src, { platform: 'win32', fss });
    const e = thrown(() => shim.closeSync(shim.openSync('/w/f.txt', 'w')));
    const out = [];
    if (e) out.push(`threw ${e.code}: ${e.message}`);
    if ((fss.files.get('/w/f.txt') || {}).kind !== 'file') out.push('no file at the path');
    if (JSON.stringify(cmd(fss, 'open').map((c) => c[2])) !== '["wx"]') out.push(`opens ${JSON.stringify(cmd(fss, 'open'))}, not one 'wx'`);
    if (['symlink', 'rename', 'mkdir'].some((op) => cmd(fss, op).length)) out.push(`claimed, renamed or staged: ${JSON.stringify(fss.calls)}`);
    return out;
  }],
  ['win32: \'wx\' over an existing file is EEXIST, from the kernel\'s claim, and the file is untouched', (src) => {
    const fss = crtFSS({ openFlags: 'rwa+xn' });
    const shim = loadShim(src, { platform: 'win32', fss });
    fss.files.set('/w/f.txt', { kind: 'file', mode: 0o666 });
    const e = thrown(() => shim.openSync('/w/f.txt', 'wx'));
    const out = [];
    if (!e || e.code !== 'EEXIST') out.push(`'wx' over a file answered ${e ? e.code : 'no error'}, not EEXIST`);
    if ((fss.files.get('/w/f.txt') || {}).kind !== 'file') out.push('the existing file was disturbed');
    return out;
  }],
  ['win32: a mode without owner-write sets the read-only attribute, as node does; one with it sets nothing', (src) => {
    const fss = crtFSS({ openFlags: 'rwa+xn' });
    const shim = loadShim(src, { platform: 'win32', fss });
    const e = thrown(() => {
      shim.closeSync(shim.openSync('/w/ro.txt', 'wx', 0o444));
      shim.closeSync(shim.openSync('/w/rw.txt', 'wx', 0o600));
    });
    if (e) return [`threw ${e.code}: ${e.message}`];
    const chmods = JSON.stringify(cmd(fss, 'chmod'));
    return chmods === JSON.stringify([['chmod', '/w/ro.txt', 0o444]]) ? [] : [`chmods ${chmods}`];
  }],
  // An engine without 'x' (every released one) is ALWAYS refused by name, as the utime and rusage floors refuse: an
  // exclusive create is a security property, so a non-exclusive one is never handed out in its place, and the symlink
  // claim is never taken.
  ...OLD_ENGINE_ENVS.map(([label, env]) => [`win32: an engine without the exclusive open is REFUSED by name; nothing is created${label}`, (src) => {
    floorLines = [];
    const fss = crtFSS({ openFlags: null });
    const shim = loadShim(src, { platform: 'win32', fss, env });
    const out = [];
    for (const [what, call] of [['openSync', () => shim.openSync('/w/f.txt', 'w')], ['writeFileSync', () => shim.writeFileSync('/w/g.txt', 'x')]]) {
      const e = thrown(call);
      if (!e || e.code !== 'ERR_CLODE_ENGINE_FLOOR' || !/txiki-sync-open-excl\.patch/.test(e.message)) {
        out.push(`${what} answered ${e ? `${e.code}: ${e.message}` : 'no error'}, not the floor refusal`);
      }
    }
    if (fss.files.has('/w/f.txt') || fss.files.has('/w/g.txt')) out.push('a file was created');
    if (cmd(fss, 'open').length || cmd(fss, 'symlink').length) out.push(`reached the engine: ${JSON.stringify(fss.calls)}`);
    if (floorLines.length !== 2) out.push(`${floorLines.length} CLODE_ENGINE_FLOOR_LOG line(s), not one per refusal`);
    return out;
  }]),
  ['posix: a claim whose rename fails is removed, not left dangling at the path', (src) => {
    const fss = crtFSS({ openFlags: 'rwa+xn' });
    const shim = loadShim(src, { platform: 'darwin', fss });
    const e = thrown(() => shim.openSync('/w/f.txt', 'w'));
    const out = [];
    if (!e || e.code !== 'EACCES') out.push(`the failed rename answered ${e ? e.code : 'no error'}, not its EACCES`);
    if (!cmd(fss, 'symlink').some((c) => c[2] === '/w/f.txt')) out.push('no claim was made (the stand-in did not reach the case)');
    if (JSON.stringify([...fss.files.keys()]) !== '["/w"]') out.push(`left behind: ${JSON.stringify([...fss.files])}`);
    return out;
  }],
];

// PURE: each load is deterministic given the shim text and the stand-in.
function scanExclusiveCreate({ fsShimSrc }) {
  const findings = [];
  for (const [what, run] of SCENARIOS) {
    let problems;
    try { problems = run(fsShimSrc); } catch (e) { problems = [`the load itself threw: ${e && e.message}`]; }
    for (const p of problems) findings.push(`${what}: ${p}`);
  }
  return { findings, examined: SCENARIOS.length, note: 'the real fs.cjs, loaded as win32 and darwin over a CRT-contract stand-in' };
}

const guard = defineGuard({
  name: 'node-shim-exclusive-create-win32',
  read: () => ({ fsShimSrc: FS_SRC }),
  scan: scanExclusiveCreate,
  // every scenario runs; fewer examined means the table was cut
  floor: SCENARIOS.length,
  // The bug as CI met it (44977529851): fs.cjs with the Windows dispatch removed, so win32 takes the POSIX symlink
  // claim and rename the CRT refuses, and an old engine is never refused.
  control: () => {
    const from = '_isWin ? createExclusiveWin(p, createBase, mode, nb) : createExclusive(p, createBase, mode)';
    if (!FS_SRC.includes(from)) throw new Error('control: the Windows dispatch in openPath has moved; re-model the bug');
    return { fsShimSrc: FS_SRC.replace(from, 'createExclusive(p, createBase, mode)') };
  },
});
guardTests(guard);

// The control is the bug where it bites: a new file, a moded new file, and both old-engine refusals. ('wx' over an
// existing file is EEXIST either way, and the POSIX claim cleanup is not behind the dispatch.)
test('the control fails each scenario the Windows dispatch decides', () => {
  const r = scanExclusiveCreate(guard.control());
  const failed = (what) => r.findings.some((f) => f.startsWith(`${what}: `));
  const decided = SCENARIOS.map(([what]) => what).filter((w) => w.startsWith('win32:') && !w.includes('over an existing file'));
  assert.strictEqual(decided.length, 4);
  for (const what of decided) assert.ok(failed(what), `${what}: ${JSON.stringify(r.findings)}`);
});
