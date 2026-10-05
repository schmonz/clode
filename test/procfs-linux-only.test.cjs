'use strict';
// PROC_FD_IS_LINUX_ONLY (libexec/node-shim/modules/fs.cjs): when process.platform is
// not 'linux', this process's own descriptor directory (/proc/self/fd, /proc/<own
// pid>/fd) is not Linux's magic-link procfs. Every node:fs operation on it or beneath
// it throws ENOENT, except READING one descriptor by name (open /proc/self/fd/N
// read-only), which still reaches the kernel. Another process's /proc/<pid>/fd is
// untouched, and on Linux the rule never fires.
//
// Why: a quaude for an OS upstream does not build runs the LINUX carve, whose platform
// is constant-folded to "linux". That carve probes readlink(/proc/self/fd/N) and
// stat(/proc/self/fd); when they answer, it writes through /proc/self/fd/<dirfd>/<name>.
// NetBSD's procfs answers the lookups and then refuses the rename/unlink (EROFS), so
// Write and Edit failed there (the NetBSD spike, 2026-09-26: floor-probe C1 and B4).
// When those lookups answer ENOENT, the carve takes its own "no procfs" route.
//
// Why reading one descriptor still passes: NetBSD's procfs opens it as Linux does (a
// fresh open of the same file), and the carve's auth-token readers
// (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR and its siblings) read a non-socket
// descriptor by opening /proc/self/fd/N "r". Refusing that too (the first cut of this
// rule, 0e24947) made a token on a file descriptor read as "Not logged in" on NetBSD,
// measured 2026-09-27. Why WRITING one stays hidden: the only carve writer is the
// TUI's nonblocking stdout (O_WRONLY|O_NONBLOCK on /proc/self/fd/1), and installed on
// NetBSD it holds a turn's answer back until the next keystroke (tui-probe D1).
//
// The host cannot show this: macOS has no /proc at all and Linux must be left alone.
// So this loads the REAL fs.cjs in a vm context (the win-fs-rename-guard pattern) with
// a stand-in sync-fs primitive that behaves like NetBSD's procfs: it RESOLVES
// /proc/self/fd lookups and REFUSES mutations there. Whether the shim ever reaches
// that primitive with a /proc path, on which platform, is the whole question.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { defineGuard, guardTests } = require('./guard.cjs');

const PID = 4242;
const OTHER_PID = 999;

// A stand-in __tjs_fs_sync shaped like NetBSD's procfs: /proc/self/fd/N resolves (a
// readlink answer, a directory stat), and a rename/unlink/mkdir under it fails the way
// the engine reports EROFS today (EUNKNOWN). Every call is recorded, so a test can say
// whether the shim reached the primitive at all.
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
    readdir(p) { calls.push(['readdir', p]); return []; },
    chmod(p) { calls.push(['chmod', p]); }, access(p) { calls.push(['access', p]); },
    realpath(p) { calls.push(['realpath', p]); return p; }, rmdir(p) { calls.push(['rmdir', p]); },
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
  // node-shim's own internals the shim requires, loaded in the same sandbox (test/fs-shim-sandbox.cjs)
  let sandboxRequire = null;
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: (id) => sandboxRequire(id), console,
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
  sandboxRequire = require('./fs-shim-sandbox.cjs').shimRequire(sandbox, engineConstants);
  vm.runInContext(
    `(function (module, exports, require) {\n${fsShimSrc}\n})(module, exports, require);`,
    sandbox, { filename: 'fs.cjs' });
  return sandbox.module.exports;
}

const reached = (fss, p) => fss.calls.some((c) => c.slice(1).includes(p));
const FD = '/proc/self/fd/7';

// Off Linux these must be refused BEFORE the primitive: every probe the carve uses to
// decide "magic-link procfs?", and every operation through a descriptor directory.
const REFUSED = [
  ['readlinkSync of a descriptor (the write path\'s probe)', (s) => s.readlinkSync(FD), FD],
  ['lstatSync of /proc/self/fd (the sync read path\'s "is there procfs?" probe)', (s) => s.lstatSync('/proc/self/fd'), '/proc/self/fd'],
  ['statSync of /proc/self/fd', (s) => s.statSync('/proc/self/fd'), '/proc/self/fd'],
  ['statSync of a descriptor', (s) => s.statSync(FD), FD],
  ['readdirSync of /proc/self/fd', (s) => s.readdirSync('/proc/self/fd'), '/proc/self/fd'],
  ['readlinkSync by our own pid', (s) => s.readlinkSync(`/proc/${PID}/fd/7`), `/proc/${PID}/fd/7`],
  ['renameSync through a descriptor directory (the write that hit EROFS)', (s) => s.renameSync(`${FD}/a.tmp`, `${FD}/a`), `${FD}/a.tmp`],
  ['unlinkSync through a descriptor directory', (s) => s.unlinkSync(`${FD}/a.tmp`), `${FD}/a.tmp`],
  ['mkdirSync through a descriptor directory', (s) => s.mkdirSync(`${FD}/sub`), `${FD}/sub`],
  ['openSync through a descriptor directory', (s) => s.openSync(`${FD}/a`, 'w'), `${FD}/a`],
  ['openSync of one descriptor for WRITING (the TUI\'s nonblocking-stdout reopen)',
    (s) => s.openSync('/proc/self/fd/1', fs.constants.O_WRONLY | fs.constants.O_NONBLOCK), '/proc/self/fd/1'],
];
// Off Linux these must still REACH the primitive untouched.
const REACHES = [
  ['openSync of one descriptor for reading (the auth-token fd readers)', (s) => s.openSync(FD, 'r'), FD],
  ['openSync of one descriptor for reading, by our own pid', (s) => s.openSync(`/proc/${PID}/fd/7`, 'r'), `/proc/${PID}/fd/7`],
  ['readlinkSync of ANOTHER process\'s descriptor', (s) => s.readlinkSync(`/proc/${OTHER_PID}/fd/7`), `/proc/${OTHER_PID}/fd/7`],
  ['readlinkSync of an ordinary path', (s) => s.readlinkSync('/work/a'), '/work/a'],
  ['readlinkSync of /proc/self/status', (s) => s.readlinkSync('/proc/self/status'), '/proc/self/status'],
  ['readlinkSync of /proc/self/fdinfo/7', (s) => s.readlinkSync('/proc/self/fdinfo/7'), '/proc/self/fdinfo/7'],
  ['readlinkSync of /dev/fd/7', (s) => s.readlinkSync('/dev/fd/7'), '/dev/fd/7'],
  ['symlinkSync whose TARGET text is a /proc path', (s) => s.symlinkSync(FD, '/work/link'), '/work/link'],
];

// PURE: every load below is deterministic given the shim text and the stand-in.
function scanProcFdRule({ fsShimSrc }) {
  const findings = [];
  let examined = 0;
  for (const platform of ['netbsd', 'sunos', 'darwin']) {
    for (const [what, call, p] of REFUSED) {
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
    for (const [what, call, p] of REACHES) {
      examined++;
      const fss = makeFSS();
      const shim = loadShim(fsShimSrc, { platform, fss });
      try { call(shim); } catch (e) { findings.push(`${platform}: ${what} was refused (${e.code}); it must reach the kernel`); }
      if (!reached(fss, p)) findings.push(`${platform}: ${what} never reached the primitive`);
    }
  }
  // Linux is the reference box: the rule must never fire there.
  for (const [what, call, p] of [...REFUSED, ...REACHES]) {
    examined++;
    const fss = makeFSS();
    const shim = loadShim(fsShimSrc, { platform: 'linux', fss });
    try { call(shim); } catch (e) { if (e.code === 'ENOENT') findings.push(`linux: ${what} was refused (${e.message}); Linux must be untouched`); }
    if (!reached(fss, p)) findings.push(`linux: ${what} never reached the primitive; Linux must be untouched`);
  }
  return { findings, examined, note: 'the real fs.cjs, loaded as netbsd, sunos, darwin and linux' };
}

// Each shim below exposes exactly the entries the rows call.
const shimOf = (hideExpr) => `
  const F = globalThis.__tjs_fs_sync;
  const hide = (p) => (${hideExpr});
  const g = (op, fn) => (...a) => { for (const p of a) if (typeof p === 'string' && hide(p, op)) {
    const e = new Error('ENOENT, ' + op + " '" + p + "'"); e.code = 'ENOENT'; e.syscall = op; e.path = p; throw e; }
    return fn(...a); };
  module.exports = {
    readlinkSync: g('readlink', (p) => F.readlink(p)), lstatSync: g('lstat', (p) => F.lstat(p)),
    statSync: g('stat', (p) => F.stat(p)), readdirSync: g('readdir', (p) => F.readdir(p)),
    renameSync: g('rename', (a, b) => F.rename(a, b)), unlinkSync: g('unlink', (p) => F.unlink(p)),
    mkdirSync: g('mkdir', (p) => F.mkdir(p, 0o777)), openSync: g('open', (p, fl) => F.open(p, fl)),
    symlinkSync: (t, p) => F.symlink(t, p),
  };
`;

const guard = defineGuard({
  name: 'procfs-linux-only',
  read: () => ({
    fsShimSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8'),
  }),
  scan: scanProcFdRule,
  // 3 non-Linux platforms x (11 refused + 8 reaching), then all 19 on Linux.
  floor: 76,
  // Models the shim before the rule: every call forwards straight to the primitive,
  // so on NetBSD the carve's readlink(/proc/self/fd/N) answers and the write that
  // follows lands on EROFS.
  control: () => ({ fsShimSrc: shimOf('false') }),
});
guardTests(guard);

// The first cut of the rule (0e24947) hid ALL of /proc/<any pid>/fd, opens included. It
// fixed Write and Edit and broke the auth-token fd readers. The rows above must say so.
test('regression: the over-broad first cut (every op, any pid) is caught', () => {
  const r = scanProcFdRule({
    fsShimSrc: shimOf(`globalThis.process.platform !== 'linux' && /^\\/proc\\/(?:self|\\d+)\\/fd(?:\\/|$)/.test(p)`),
  });
  assert.ok(r.findings.some((f) => /one descriptor for reading .* was refused/.test(f)),
    `expected the read of one descriptor to be flagged: ${JSON.stringify(r.findings)}`);
  assert.ok(r.findings.some((f) => /ANOTHER process's descriptor was refused/.test(f)),
    `expected another pid's descriptor to be flagged: ${JSON.stringify(r.findings)}`);
});

// A rule that let EVERY open of one descriptor through (reads and writes alike) would
// bring back the TUI's nonblocking stdout on NetBSD. The write row must say so.
test('regression: letting a WRITE open of one descriptor through is caught', () => {
  const r = scanProcFdRule({
    fsShimSrc: shimOf(`globalThis.process.platform !== 'linux' && /^\\/proc\\/self\\/fd(?:\\/|$)/.test(p) && !/^\\/proc\\/self\\/fd\\/\\d+$/.test(p)`),
  });
  assert.ok(r.findings.some((f) => /one descriptor for WRITING .* must throw ENOENT/.test(f)),
    `expected the write open of one descriptor to be flagged: ${JSON.stringify(r.findings)}`);
});

// The promises and callback forms: guard.cjs's scan() is synchronous, so these are
// asserted directly against the real fs.cjs, as win-fs-rename-guard does for rename.
const FS_SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8');
const ASYNC_REFUSED = [
  ['promises.readlink', (s) => s.promises.readlink(FD)],
  ['promises.lstat', (s) => s.promises.lstat('/proc/self/fd')],
  ['promises.mkdir', (s) => s.promises.mkdir(`${FD}/sub`)],
  ['promises.open through a descriptor directory', (s) => s.promises.open(`${FD}/a`, 'w')],
  ['promises.rename', (s) => s.promises.rename(`${FD}/a.tmp`, `${FD}/a`)],
  ['promises.unlink', (s) => s.promises.unlink(`${FD}/a.tmp`)],
  ['promises.readFile through a descriptor directory (tjs.readFile)', (s) => s.promises.readFile(`${FD}/a`)],
  ['promises.statfs (tjs.statFs)', (s) => s.promises.statfs('/proc/self/fd')],
  ['promises.utimes (tjs.utime)', (s) => s.promises.utimes(`${FD}/a`, 0, 0)],
  ['promises.truncate through a descriptor directory (tjs.open)', (s) => s.promises.truncate(`${FD}/a`)],
  ['promises.link (tjs.link)', (s) => s.promises.link('/work/a', `${FD}/a`)],
  ['callback readlink', (s) => new Promise((ok, no) => s.readlink(FD, (e, v) => (e ? no(e) : ok(v))))],
];
const ASYNC_REFUSED_EXACT = [
  ['promises.open of one descriptor for writing', (s) => s.promises.open(FD, 'w')],
  ['promises.truncate of one descriptor (tjs.open r+)', (s) => s.promises.truncate(FD)],
];
ASYNC_REFUSED.push(...ASYNC_REFUSED_EXACT);
const ASYNC_REACHES = [
  ['promises.open of one descriptor for reading', (s) => s.promises.open(FD, 'r')],
  ['promises.readFile of one descriptor (tjs.readFile)', (s) => s.promises.readFile(FD)],
];
const reachedProc = (fss) => fss.calls.some((c) => c.slice(1).some((a) => typeof a === 'string' && a.startsWith('/proc/')));

for (const [what, call] of ASYNC_REFUSED) {
  test(`netbsd: ${what} on a /proc/self/fd path rejects ENOENT without reaching the engine`, async () => {
    const fss = makeFSS();
    const shim = loadShim(FS_SRC, { platform: 'netbsd', fss });
    await assert.rejects(() => call(shim), (e) => e.code === 'ENOENT');
    assert.ok(!reachedProc(fss), `the engine was reached with a /proc path: ${JSON.stringify(fss.calls)}`);
  });
}
for (const [what, call] of ASYNC_REACHES) {
  test(`netbsd: ${what} reaches the engine`, async () => {
    const fss = makeFSS();
    const shim = loadShim(FS_SRC, { platform: 'netbsd', fss });
    try { await call(shim); } catch (e) { assert.notStrictEqual(e.code, 'ENOENT', `refused off Linux: ${e.message}`); }
    assert.ok(reachedProc(fss), `the engine was never reached: ${JSON.stringify(fss.calls)}`);
  });
}
for (const [what, call] of [...ASYNC_REFUSED, ...ASYNC_REACHES]) {
  test(`linux: ${what} on a /proc/self/fd path reaches the engine untouched`, async () => {
    const fss = makeFSS();
    const shim = loadShim(FS_SRC, { platform: 'linux', fss });
    try { await call(shim); } catch (e) { assert.notStrictEqual(e.code, 'ENOENT', `refused on Linux: ${e.message}`); }
    assert.ok(reachedProc(fss), `the engine was never reached on Linux: ${JSON.stringify(fss.calls)}`);
  });
}
