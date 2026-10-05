'use strict';
// The errors node-shim's fs hands out, judged against host node (grep-native Task 10c fix round, review I-1).
//
// The engine's sync binding names a dozen errnos and called every other one EUNKNOWN (`EUNKNOWN, write ''`),
// EPIPE among them: a write into a pipe whose reader went away could not be told from a real failure, and
// quaude's rg printed a stack trace under `| head -1` where native rg ends quietly. node reports the errno's
// name, the NEGATED errno, the syscall and `NAME: libuv's text, syscall 'path'` (`'a' -> 'b'` for the two-path
// calls). One program makes each error under node and under tjs (node-shim), and every field must match:
// code, errno, syscall, message, path, dest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2], what = process.argv[3];
const shape = (e) => ({ code: e.code, errno: e.errno, syscall: e.syscall, message: e.message, path: e.path, dest: e.dest });
const tryIt = (f) => { try { f(); return null; } catch (e) { return shape(e); } };
if (what === 'epipe') {
  // stdout is a pipe whose reader has exited by now
  setTimeout(() => { const r = tryIt(() => { for (let i = 0; i < 64; i++) fs.writeSync(1, Buffer.alloc(65536)); }); fs.writeSync(2, JSON.stringify(r)); }, 500);
} else {
  const f = path.join(dir, 'file'), d = path.join(dir, 'sub'), full = path.join(dir, 'full');
  const out = {
    eisdir: tryIt(() => fs.readSync(fs.openSync(d, 'r'), Buffer.alloc(8), 0, 8, null)),
    ebadf: tryIt(() => fs.writeSync(987, 'x')),
    ebadfRead: tryIt(() => fs.writeSync(fs.openSync(f, 'r'), 'x')),
    enoent: tryIt(() => fs.openSync(path.join(dir, 'nope', 'x'), 'r')),
    eexist: tryIt(() => fs.mkdirSync(d)),
    enotempty: tryIt(() => fs.rmdirSync(full)),
    rename: tryIt(() => fs.renameSync(path.join(dir, 'missing'), path.join(dir, 'b'))),
    symlink: tryIt(() => fs.symlinkSync('target', f)),
    enotdirStat: tryIt(() => fs.statSync(path.join(f, 'x'))),
  };
  process.stdout.write(JSON.stringify(out));
}
`;

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-errno-')));
  fs.writeFileSync(path.join(dir, 'file'), 'x\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, 'full'));
  fs.writeFileSync(path.join(dir, 'full', 'f'), 'x');
  fs.writeFileSync(path.join(dir, 'prog.cjs'), PROG);
  return dir;
}
function runBoth(dir, what) {
  const prog = path.join(dir, 'prog.cjs');
  const node = [process.execPath, prog];
  const [cmd, a] = engineSpawn(['run', LOADER, prog]);
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const run = (argv) => {
    if (what === 'epipe') {
      // `| true`: the reader exits at once; the writer's next write meets EPIPE (it reports on fd 2)
      const r = spawnSync('/bin/sh', ['-c', `${argv.map(q).join(' ')} ${q(dir)} epipe | true`], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(r.stderr);
    }
    const r = spawnSync(argv[0], [...argv.slice(1), dir, what], { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(r.stdout);
  };
  return { node: run(node), ours: run([cmd, ...a]) };
}

test('fs errors under tjs are node\'s: code, errno, syscall, message, path, dest', { skip: process.platform === 'win32' ? 'POSIX errnos (Windows: libuv codes, unmeasured)' : false }, (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fixture();
  try {
    const { node, ours } = runBoth(dir, 'all');
    for (const k of Object.keys(node)) assert.deepStrictEqual(ours[k], node[k], k);
    assert.ok(Object.keys(node).length >= 9);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a write into a pipe whose reader went away is node\'s EPIPE under tjs, not EUNKNOWN', { skip: process.platform === 'win32' ? 'POSIX pipes' : false }, (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fixture();
  try {
    const { node, ours } = runBoth(dir, 'epipe');
    assert.deepStrictEqual(node, { code: 'EPIPE', errno: -32, syscall: 'write', message: 'EPIPE: broken pipe, write' });
    assert.deepStrictEqual(ours, node);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
