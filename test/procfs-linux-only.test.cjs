'use strict';
// PROC_FD_IS_LINUX_ONLY (libexec/node-shim/modules/fs.cjs): when process.platform is
// not 'linux', a path under /proc/self/fd or /proc/<pid>/fd does not exist, for every
// node:fs entry. On Linux the rule never fires.
//
// Why: a quaude for an OS upstream does not build runs the LINUX carve, whose
// platform is constant-folded to "linux". That carve probes readlink(/proc/self/fd/N)
// and stat(/proc/self/fd); when they answer, it writes through
// /proc/self/fd/<dirfd>/<name>. NetBSD's procfs answers the lookups and then refuses
// the rename/unlink (EROFS), so Write and Edit failed there (the NetBSD spike,
// 2026-09-26: floor-probe C1 and B4 failed, 3/5). When those lookups answer ENOENT,
// the carve takes its own "no procfs" route.
//
// The host cannot show this: macOS has no /proc at all and Linux must be left alone.
// So this loads the REAL fs.cjs in a vm context (the win-fs-rename-guard pattern) with
// a stand-in sync-fs primitive that behaves like NetBSD's procfs: it RESOLVES
// /proc/self/fd lookups and REFUSES mutations there. Whether the shim ever reaches
// that primitive with a /proc/self/fd path, on which platform, is the whole question.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { defineGuard, guardTests } = require('./guard.cjs');

const PID = 4242;

// A stand-in __tjs_fs_sync shaped like NetBSD's procfs: /proc/self/fd/N resolves (a
// readlink answer, a directory stat), and a rename/unlink/mkdir/open for writing
// under it fails the way the engine reports EROFS today (EUNKNOWN). Every call is
// recorded, so a test can say whether the shim reached the primitive at all.
function makeFSS() {
  const calls = [];
  const isProcFd = (p) => typeof p === 'string' && /^\/proc\/(?:self|\d+)\/fd(?:\/|$)/.test(p);
  const refused = (op, p) => {
    const e = new Error(`EUNKNOWN, ${op} '${p}'`);
    e.code = 'EUNKNOWN'; e.errno = 30; e.syscall = op;
    return e;
  };
  const dirStat = { size: 0, mode: 0o40555, mtimeMs: 0, kind: 'dir' };
  return {
    calls,
    readlink(p) { calls.push(['readlink', p]); if (isProcFd(p)) return '/work'; return '/elsewhere'; },
    stat(p) { calls.push(['stat', p]); return dirStat; },
    lstat(p) { calls.push(['lstat', p]); return dirStat; },
    rename(a, b) { calls.push(['rename', a, b]); if (isProcFd(a) || isProcFd(b)) throw refused('rename', a); },
    unlink(p) { calls.push(['unlink', p]); if (isProcFd(p)) throw refused('unlink', p); },
    mkdir(p) { calls.push(['mkdir', p]); if (isProcFd(p)) throw refused('mkdir', p); },
    open(p) { calls.push(['open', p]); return 9; },
    close() {},
    symlink(target, p) { calls.push(['symlink', target, p]); },
    chmod() {}, access() {}, readdir() { return []; }, realpath(p) { return p; }, rmdir() {},
  };
}

// Load a fs.cjs-shaped source with a given process.platform and stand-in primitive.
function loadShim(fsShimSrc, { platform, fss }) {
  const os = require('node:os');
  const engineConstants = {
    REQUIRED_ABI: 1,
    fs: fs.constants,
    signals: os.constants.signals,
    errno: os.constants.errno,
    dlopen: os.constants.dlopen,
    priority: os.constants.priority,
    UV_UDP_REUSEADDR: os.constants.UV_UDP_REUSEADDR,
  };
  const sandboxRequire = (id) =>
    (String(id).includes('internal/engine-constants.cjs') ? engineConstants : require(id));
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: sandboxRequire, console,
    TextDecoder, TextEncoder, Buffer, queueMicrotask,
    __tjs_fs_sync: fss,
    navigator: { platform: platform === 'darwin' ? 'MacIntel' : platform === 'linux' ? 'Linux aarch64' : 'NetBSD evbarm' },
    process: { platform, pid: PID, env: {} },
    tjs: {
      readFile: async (p) => { fss.calls.push(['tjs.readFile', p]); return new Uint8Array(0); },
      statFs: async (p) => { fss.calls.push(['tjs.statFs', p]); return { type: 0, bsize: 1, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 }; },
      utime: async (p) => { fss.calls.push(['tjs.utime', p]); },
      lutime: async (p) => { fss.calls.push(['tjs.lutime', p]); },
      link: async (a, b) => { fss.calls.push(['tjs.link', a, b]); },
      open: async (p) => { fss.calls.push(['tjs.open', p]); return { truncate: async () => {}, close: async () => {} }; },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `(function (module, exports, require) {\n${fsShimSrc}\n})(module, exports, require);`,
    sandbox, { filename: 'fs.cjs' });
  return sandbox.module.exports;
}

const reached = (fss, p) => fss.calls.some((c) => c.slice(1).includes(p));

// PURE: every load below is deterministic given the shim text and the stand-in.
function scanProcFdRule({ fsShimSrc }) {
  const findings = [];
  let examined = 0;
  const FD = '/proc/self/fd/7';
  const cases = [
    // [what, call, the path it names]
    ['readlinkSync of a descriptor (the async write path\'s probe)', (s) => s.readlinkSync(FD), FD],
    ['lstatSync of /proc/self/fd (the sync read path\'s "is there procfs?" probe)', (s) => s.lstatSync('/proc/self/fd'), '/proc/self/fd'],
    ['statSync of /proc/self/fd', (s) => s.statSync('/proc/self/fd'), '/proc/self/fd'],
    ['readlinkSync by pid', (s) => s.readlinkSync(`/proc/${PID}/fd/7`), `/proc/${PID}/fd/7`],
    ['renameSync through a descriptor directory (the write that hit EROFS)', (s) => s.renameSync(`${FD}/a.tmp`, `${FD}/a`), `${FD}/a.tmp`],
    ['unlinkSync through a descriptor directory', (s) => s.unlinkSync(`${FD}/a.tmp`), `${FD}/a.tmp`],
    ['mkdirSync through a descriptor directory', (s) => s.mkdirSync(`${FD}/sub`), `${FD}/sub`],
    ['openSync through a descriptor directory', (s) => s.openSync(`${FD}/a`, 'w'), `${FD}/a`],
  ];
  for (const platform of ['netbsd', 'sunos', 'darwin']) {
    for (const [what, call, p] of cases) {
      examined++;
      const fss = makeFSS();
      const shim = loadShim(fsShimSrc, { platform, fss });
      let err = null;
      try { call(shim); } catch (e) { err = e; }
      if (!err || err.code !== 'ENOENT') {
        findings.push(`${platform}: ${what} must throw ENOENT, got ${err ? err.code : 'no error'}`);
      } else if (reached(fss, p)) {
        findings.push(`${platform}: ${what} threw ENOENT but only after reaching the primitive with ${p}`);
      } else if (err.syscall === undefined || err.path !== p) {
        findings.push(`${platform}: ${what} threw ENOENT without the engine's error shape (syscall/path)`);
      }
    }
  }
  // Linux is the reference box: the rule must never fire there.
  for (const [what, call, p] of cases) {
    examined++;
    const fss = makeFSS();
    const shim = loadShim(fsShimSrc, { platform: 'linux', fss });
    try { call(shim); } catch (e) { if (e.code === 'ENOENT') findings.push(`linux: ${what} was refused (${e.message}); Linux must be untouched`); }
    if (!reached(fss, p)) findings.push(`linux: ${what} never reached the primitive; Linux must be untouched`);
  }
  // Off Linux, ordinary paths and look-alikes are untouched.
  for (const p of ['/work/a', '/proc/self/status', '/proc/self/fdinfo/7', '/dev/fd/7']) {
    examined++;
    const fss = makeFSS();
    const shim = loadShim(fsShimSrc, { platform: 'netbsd', fss });
    try { shim.readlinkSync(p); } catch (e) { findings.push(`netbsd: readlinkSync('${p}') was refused (${e.code}); only /proc/<self|pid>/fd is hidden`); }
    if (!reached(fss, p)) findings.push(`netbsd: readlinkSync('${p}') never reached the primitive`);
  }
  // symlink's FIRST argument is link text, not a lookup.
  examined++;
  {
    const fss = makeFSS();
    const shim = loadShim(fsShimSrc, { platform: 'netbsd', fss });
    try { shim.symlinkSync(FD, '/work/link'); } catch (e) { findings.push(`netbsd: symlinkSync with /proc text as its TARGET was refused (${e.code})`); }
  }
  return { findings, examined, note: 'the real fs.cjs, loaded as netbsd, sunos, darwin and linux' };
}

const guard = defineGuard({
  name: 'procfs-linux-only',
  read: () => ({
    fsShimSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8'),
  }),
  scan: scanProcFdRule,
  // 3 non-Linux platforms x 8 calls, 8 Linux calls, 4 look-alike paths, 1 symlink.
  floor: 37,
  // Models the shim before the rule: every call forwards straight to the primitive,
  // so on NetBSD the carve's readlink(/proc/self/fd/N) answers and the write that
  // follows lands on EROFS.
  control: () => ({
    fsShimSrc: `
      const F = globalThis.__tjs_fs_sync;
      module.exports = {
        readlinkSync: (p) => F.readlink(p), lstatSync: (p) => F.lstat(p), statSync: (p) => F.stat(p),
        renameSync: (a, b) => F.rename(a, b), unlinkSync: (p) => F.unlink(p),
        mkdirSync: (p) => F.mkdir(p, 0o777), openSync: (p) => F.open(p, 'w'),
        symlinkSync: (t, p) => F.symlink(t, p),
      };
    `,
  }),
});
guardTests(guard);

// The promises and callback forms: guard.cjs's scan() is synchronous, so these are
// asserted directly against the real fs.cjs, as win-fs-rename-guard does for rename.
const FS_SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8');
const FD = '/proc/self/fd/7';
const ASYNC = [
  ['promises.readlink', (s) => s.promises.readlink(FD)],
  ['promises.lstat', (s) => s.promises.lstat('/proc/self/fd')],
  ['promises.mkdir', (s) => s.promises.mkdir(`${FD}/sub`)],
  ['promises.open', (s) => s.promises.open(`${FD}/a`, 'w')],
  ['promises.rename', (s) => s.promises.rename(`${FD}/a.tmp`, `${FD}/a`)],
  ['promises.unlink', (s) => s.promises.unlink(`${FD}/a.tmp`)],
  ['promises.readFile (tjs.readFile)', (s) => s.promises.readFile(`${FD}/a`)],
  ['promises.statfs (tjs.statFs)', (s) => s.promises.statfs('/proc/self/fd')],
  ['promises.utimes (tjs.utime)', (s) => s.promises.utimes(`${FD}/a`, 0, 0)],
  ['promises.truncate (tjs.open)', (s) => s.promises.truncate(`${FD}/a`)],
  ['promises.link (tjs.link)', (s) => s.promises.link('/work/a', `${FD}/a`)],
  ['callback readlink', (s) => new Promise((ok, no) => s.readlink(FD, (e, v) => (e ? no(e) : ok(v))))],
];

for (const [what, call] of ASYNC) {
  test(`netbsd: ${what} on a /proc/self/fd path rejects ENOENT without reaching the engine`, async () => {
    const fss = makeFSS();
    const shim = loadShim(FS_SRC, { platform: 'netbsd', fss });
    await assert.rejects(() => call(shim), (e) => e.code === 'ENOENT');
    assert.ok(!fss.calls.some((c) => c.slice(1).some((a) => typeof a === 'string' && a.startsWith('/proc/'))),
      `the engine was reached with a /proc path: ${JSON.stringify(fss.calls)}`);
  });
  test(`linux: ${what} on a /proc/self/fd path reaches the engine untouched`, async () => {
    const fss = makeFSS();
    const shim = loadShim(FS_SRC, { platform: 'linux', fss });
    try { await call(shim); } catch (e) { assert.notStrictEqual(e.code, 'ENOENT', `refused on Linux: ${e.message}`); }
    assert.ok(fss.calls.some((c) => c.slice(1).some((a) => typeof a === 'string' && a.startsWith('/proc/'))),
      `the engine was never reached on Linux: ${JSON.stringify(fss.calls)}`);
  });
}
