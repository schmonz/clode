'use strict';
// File IDENTITY under quaude, judged against host node: every field of fs.Stats and of
// fs.BigIntStats, through every way node hands one out. The engine's sync stat binding used to
// carry only size, mode, uid, gid, a whole-second mtime and a kind, so node-shim reported dev, ino
// and rdev as 0, nlink 1, blksize 4096, every time as the whole-second mtime, and ignored
// `{ bigint: true }` (numbers came back, no *Ns). Two different files then compared equal on
// (dev, ino), and the 2.1.283 bundle's identity checks (git worktree commondir, the approval-bound
// reopen, the staging-dir checks) and its rdev comparison with /dev/null (every character device
// read as /dev/null) all judged nothing. BACKLOG: "node-shim's sync stat has no dev, ino or rdev".
//
// What is judged: a regular file, a hard link to it (same ino), a different file, a directory, a
// symlink (stat follows, lstat does not), a FIFO, a unix socket, /dev/null and /dev/zero; through
// statSync, lstatSync, fstatSync, fs.promises.stat/lstat, callback stat/lstat and FileHandle.stat;
// each with and without `{ bigint: true }`. Every value is printed with its type, so a number where
// node has a bigint is a difference.
//
// The one allowance: a field the ORACLE sees move between its own two runs (node, then quaude,
// then node again) cannot be judged, and is named in the output rather than skipped silently.
// /dev/null's times move whenever anything on the box writes to it; nothing else is expected to.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs, runLoader, LOADER, REPO } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2];
const FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
  'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs',
  'atime', 'mtime', 'ctime', 'birthtime'];
const KINDS = ['isFile', 'isDirectory', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isCharacterDevice', 'isBlockDevice'];
const show = (v) => typeof v === 'bigint' ? 'bigint ' + v
  : v instanceof Date ? 'Date ' + v.getTime()
  : typeof v === 'number' ? 'number ' + v
  : typeof v;
const out = {};
const put = (label, s) => {
  out[label + ' class'] = Object.getPrototypeOf(s).constructor.name;
  out[label + ' types'] = KINDS.filter((k) => s[k]()).join(',');
  out[label + ' own'] = Object.keys(s).join(',');
  for (const f of FIELDS) out[label + ' ' + f] = show(s[f]);
};
const paths = { file: path.join(dir, 'file.txt'), hardlink: path.join(dir, 'hard.txt'), other: path.join(dir, 'other.txt'),
  dir: path.join(dir, 'sub'), symlink: path.join(dir, 'link'), fifo: path.join(dir, 'fifo'), sock: path.join(dir, 'sock'),
  null: '/dev/null', zero: '/dev/zero' };
if (process.platform === 'win32') {
  for (const k of ['fifo', 'sock', 'null', 'zero']) delete paths[k];
  try { fs.lstatSync(paths.symlink); } catch { delete paths.symlink; } // not created: no privilege
}
const OPENABLE = ['file', 'hardlink', 'other', 'symlink', 'fifo', 'null', 'zero'];
if (process.platform !== 'win32') OPENABLE.push('dir');   // a directory fd (Windows' open refuses one)
const VARIANTS = [['', undefined], [' bigint', { bigint: true }]];
const cb = (fn, p, o) => new Promise((res, rej) => {
  const done = (e, s) => (e ? rej(e) : res(s));
  if (o) fs[fn](p, o, done); else fs[fn](p, done);
});
(async () => {
  for (const [name, p] of Object.entries(paths)) {
    for (const [v, o] of VARIANTS) {
      put(name + ' statSync' + v, fs.statSync(p, o));
      put(name + ' lstatSync' + v, fs.lstatSync(p, o));
      put(name + ' promises.stat' + v, await fs.promises.stat(p, o));
      put(name + ' promises.lstat' + v, await fs.promises.lstat(p, o));
      put(name + ' stat-cb' + v, await cb('stat', p, o));
      put(name + ' lstat-cb' + v, await cb('lstat', p, o));
      if (OPENABLE.includes(name)) {
        const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        put(name + ' fstatSync' + v, fs.fstatSync(fd, o));
        put(name + ' fstat-cb' + v, await cb('fstat', fd, o));
        fs.closeSync(fd);
      }
      if (name === 'file') {
        const fh = await fs.promises.open(p, 'r');
        put(name + ' FileHandle.stat' + v, await fh.stat(o));
        await fh.close();
      }
    }
  }
  // fd 3, when the harness hands one over, is one end of a socketpair: fstat of a socket fd.
  if (process.env.STAT_SOCKFD === '3') {
    for (const [v, o] of VARIANTS) {
      put('sockfd fstatSync' + v, fs.fstatSync(3, o));
      put('sockfd fstat-cb' + v, await cb('fstat', 3, o));
    }
  }
  console.log(JSON.stringify(out));
})();
`;

// On Windows the files, the directory and (where the runner may create one) the symlink are judged;
// there are no FIFOs, unix sockets or /dev/null. libuv's rules there (deps/libuv/src/win/fs.c): ino
// is the FileId, dev the volume serial number's low 32 bits, nlink NumberOfLinks, blksize 4096,
// uid/gid/rdev 0 for a file, and lstat sees a reparse point. node reads the same struct, so the
// comparison stands as is, and it can fail there as anywhere.
const POSIX = process.platform !== 'win32';
test('every Stats and BigIntStats field equals host node\'s (stat, lstat, fstat, promises, callbacks, FileHandle)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stat-identity-')));
  const server = net.createServer();
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const dir = path.join(base, 'd');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
    fs.linkSync(path.join(dir, 'file.txt'), path.join(dir, 'hard.txt'));
    fs.writeFileSync(path.join(dir, 'other.txt'), 'a different file\n');
    let symlink = true;
    try { fs.symlinkSync('file.txt', path.join(dir, 'link')); } catch (e) {
      // Windows without the create-symlink privilege: say so, and judge the rest.
      if (POSIX || e.code !== 'EPERM') throw e;
      symlink = false;
      t.diagnostic('no symlink judged: this Windows account may not create one (EPERM)');
    }
    if (POSIX) {
      assert.strictEqual(spawnSync('mkfifo', [path.join(dir, 'fifo')]).status, 0);
      await new Promise((res, rej) => { server.once('error', rej); server.listen(path.join(dir, 'sock'), res); });
    }
    // On POSIX every run gets fd 3 as one end of a fresh socketpair (node's 'pipe' beyond stdio).
    const run = (cmd, argv) => {
      const x = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe', ...(POSIX ? ['pipe'] : [])],
        env: { ...process.env, STAT_SOCKFD: POSIX ? '3' : '' } });
      return { status: x.status, stdout: x.stdout || '', stderr: x.stderr || '' };
    };
    const oracle = () => {
      const o = run(process.execPath, [prog, dir]);
      assert.strictEqual(o.status, 0, o.stderr);
      return JSON.parse(o.stdout.trim());
    };
    const before = oracle();
    const r = run(...engineSpawn(['run', LOADER, prog, dir]));
    const after = oracle();
    assert.strictEqual(r.status, 0, r.stderr);
    // (A rejection the program leaves unhandled exits 0 under node-shim, so status alone is no proof.)
    assert.ok(r.stdout.trim(), `quaude printed nothing: ${r.stderr}`);
    const ours = JSON.parse(r.stdout.trim());

    // The oracle must itself tell the cases apart, or the comparison judges nothing.
    assert.strictEqual(before['file statSync ino'], before['hardlink statSync ino'], 'a hard link shares its ino');
    assert.notStrictEqual(before['file statSync ino'], before['other statSync ino'], 'two files differ in ino');
    assert.match(before['file statSync ino'], /^number [1-9]/);
    assert.match(before['file statSync bigint ino'], /^bigint [1-9]/);
    if (POSIX) assert.notStrictEqual(before['null statSync rdev'], before['zero statSync rdev'], '/dev/null and /dev/zero differ in rdev');
    if (symlink) assert.notStrictEqual(before['symlink statSync ino'], before['symlink lstatSync ino'], 'stat follows a symlink, lstat does not');
    assert.strictEqual(before['file statSync bigint class'], 'BigIntStats');
    if (POSIX) {
      assert.strictEqual(before['dir fstatSync types'], 'isDirectory', 'a directory fd was judged');
      assert.strictEqual(before['sockfd fstatSync types'], 'isSocket', 'a socket fd was judged');
    }

    const moving = Object.keys(before).filter((k) => before[k] !== after[k]);
    for (const k of moving) t.diagnostic(`unjudgeable, the oracle moved between its runs: ${k} (${before[k]} -> ${after[k]})`);
    // Allowed to move: /dev/null's times (anything on the box writing to it), and the socket fd's
    // identity and times (each run gets a new socketpair, so its ino is its own).
    assert.ok(moving.every((k) => (/^null /.test(k) && /time/.test(k)) || (/^sockfd /.test(k) && /( ino| \w*time\w*)$/.test(k))),
      `only /dev/null's times and the socket fd's ino and times may move under the oracle: ${moving.join(', ')}`);

    // A moving field is not judged for its value, but it must still be a real one: quaude's socket
    // fd has an ino of its own wherever node's has one.
    for (const k of moving.filter((x) => /^sockfd .* ino$/.test(x))) {
      if (!/ 0$/.test(before[k])) assert.match(ours[k], /^(number|bigint) [1-9]/, `${k}: quaude ${ours[k]}`);
    }

    const diffs = Object.keys(before).filter((k) => !moving.includes(k) && before[k] !== ours[k]);
    const fields = [...new Set(diffs.map((k) => k.split(' ').pop()))].sort();
    assert.deepStrictEqual(diffs.map((k) => `${k}: node ${before[k]} / quaude ${ours[k]}`), [],
      `${diffs.length} of ${Object.keys(before).length} answers differ; fields: ${fields.join(', ')}`);
  } finally { if (server.listening) server.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

// THE STATS CONSTRUCTION, FED A WINDOWS uv_stat_t. Off Windows the comparison above never sees one, so here a
// __tjs_fs_sync whose stat, lstat and fstat answer what libuv's fs__stat_handle (deps/libuv/src/win/fs.c) fills
// on NTFS, in the raw shape txiki-sync-stat-identity.patch hands JS (BigInt dev/ino/... and <time>Sec/<time>Nsec),
// and a FRESH node-shim fs module bound to it (as test/node-shim-fs-engine-floor.test.cjs does). The Windows facts
// in it: dev the volume serial (32 bits), ino the 64-bit FileId whose high 16 bits are a sequence number (past
// 2^53, and here past 2^63: node's BigInt64Array reads it negative), mode S_IFREG|0666 and uid/gid/rdev 0,
// blksize 4096 and blocks AllocationSize/512, times from FILETIME (100 ns ticks: every Nsec a multiple of 100),
// birthtime its CreationTime, one time before the epoch. Expected: node's arithmetic (lib/internal/fs/utils.js:
// a Float64Array of the fields, ms = sec * 1e3 + nsec / 1e6; BigIntStats from a BigInt64Array, ns = sec * 1e9 + nsec).
// The windows-* tjs smoke's battery (test/win-sync-battery.js) checks a REAL Windows engine answers this shape.
const WIN_RAW = {
  size: 6, mode: 0o100666, uid: 0, gid: 0, kind: 'file',
  dev: 0xC0FFEE12n, ino: 0x8003000000001A2Bn, nlink: 2n, rdev: 0n, blksize: 4096n, blocks: 8n, size64: 6n,
  atimeSec: 1763500000n, atimeNsec: 123456700n, mtimeSec: 1763499999n, mtimeNsec: 999999900n,
  ctimeSec: 1763400000n, ctimeNsec: 0n, birthtimeSec: -86400n, birthtimeNsec: 500000000n,
};
test('Stats and BigIntStats from a Windows uv_stat_t: every field as node builds it', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stat-winraw-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    const rawSrc = `({${Object.entries(WIN_RAW).map(([k, v]) => `${k}: ${typeof v === 'bigint' ? `${v}n` : JSON.stringify(v)}`).join(', ')}})`;
    fs.writeFileSync(prog, `
      const real = globalThis.__tjs_fs_sync;
      const raw = () => ${rawSrc};
      globalThis.__tjs_fs_sync = Object.create(real, { stat: { value: raw, writable: true }, lstat: { value: raw, writable: true },
        fstat: { value: raw, writable: true } });
      const fsx = require(process.argv[2]);
      const show = (v) => typeof v === 'bigint' ? 'bigint ' + v : v instanceof Date ? 'Date ' + v.getTime() : typeof v + ' ' + v;
      const out = {};
      for (const [label, s] of [['', fsx.statSync('C:/x')], [' bigint', fsx.statSync('C:/x', { bigint: true })], [' lstat', fsx.lstatSync('C:/x')]]) {
        for (const k of Object.keys(s)) out[k + label] = show(s[k]);
        for (const k of ['atime', 'mtime', 'ctime', 'birthtime']) out[k + label] = show(s[k]);
        out['isFile' + label] = String(s.isFile());
      }
      console.log(JSON.stringify(out));
    `);
    const r = runLoader(prog, [path.join(REPO, 'libexec/node-shim/modules/fs.cjs')], { timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim(), `printed nothing: ${r.stderr}`);
    const got = JSON.parse(r.stdout.trim());
    const want = {};
    const INTS = ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks'];
    const TIMES = ['atime', 'mtime', 'ctime', 'birthtime'];
    for (const label of ['', ' lstat']) {
      // node: a Float64Array holds each field (uint64 -> double, round to nearest), times through msFromTimeSpec.
      for (const f of INTS) want[f + label] = `number ${Number(f === 'size' ? WIN_RAW.size64 : WIN_RAW[f])}`;
      for (const k of TIMES) {
        const ms = Number(WIN_RAW[`${k}Sec`]) * 1e3 + Number(WIN_RAW[`${k}Nsec`]) / 1e6;
        want[`${k}Ms${label}`] = `number ${ms}`;
        want[k + label] = `Date ${Math.round(ms)}`;
      }
      want['isFile' + label] = 'true';
    }
    for (const f of INTS) want[`${f} bigint`] = `bigint ${BigInt.asIntN(64, BigInt(f === 'size' ? WIN_RAW.size64 : WIN_RAW[f]))}`;
    for (const k of TIMES) {
      const ns = WIN_RAW[`${k}Sec`] * 1000000000n + WIN_RAW[`${k}Nsec`];
      want[`${k}Ms bigint`] = `bigint ${ns / 1000000n}`;
      want[`${k}Ns bigint`] = `bigint ${ns}`;
      want[`${k} bigint`] = `Date ${Number(ns / 1000000n)}`;
    }
    want['isFile bigint'] = 'true';
    assert.deepStrictEqual(got, want);
    // The Windows facts the shape carries, read back: an ino past 2^53 rounds as node's double does, and past 2^63
    // is negative as node's BigInt64Array has it; a pre-epoch birthtime keeps its sign.
    assert.strictEqual(got.ino, `number ${Number(0x8003000000001A2Bn)}`);
    assert.strictEqual(got['ino bigint'], `bigint ${0x8003000000001A2Bn - (1n << 64n)}`);
    assert.strictEqual(got.birthtimeMs, 'number -86399500');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
