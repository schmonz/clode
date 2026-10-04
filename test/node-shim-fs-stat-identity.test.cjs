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
const { engineSpawn, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

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
