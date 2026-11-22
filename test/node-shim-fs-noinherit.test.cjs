'use strict';
// A file the shim opens is NOT inherited by a child it spawns, as node's is not. On Windows the engine's sync open
// made INHERITABLE handles (O_CLOEXEC is 0 under the CRT) and libuv spawns with bInheritHandles TRUE (for the
// child's stdio), so every child got a copy of every open file. The CRT open shares no DELETE access, so while the
// child ran, a file the parent had already CLOSED could not be unlinked or renamed over ("EACCES"/"EBUSY": the
// child's copy still held it). txiki-sync-open-excl.patch opens with _O_NOINHERIT, as libuv's uv_fs_open does.
//
// The program opens a file, spawns a child that outlives the test window, closes the file, and unlinks it while
// the child runs. Node unlinks it; so must quaude. Judged on the real Windows kernels (ci.yml windows-*-tests); on
// POSIX the sync open was already O_CLOEXEC, and the row is the same comparison.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const p = path.join(process.argv[2], 'held.txt');
const fd = fs.openSync(p, 'w');
fs.writeSync(fd, 'x');
const child = process.platform === 'win32'
  ? cp.spawn('ping', ['-n', '6', '127.0.0.1'], { stdio: 'ignore' })
  : cp.spawn('sleep', ['5'], { stdio: 'ignore' });
setTimeout(() => {
  fs.closeSync(fd);
  let out;
  try { fs.unlinkSync(p); out = 'unlinked'; } catch (e) { out = 'held by the child: ' + e.code; }
  try { child.kill(); } catch { /* gone */ }
  console.log(out);
  process.exit(0);
}, 500);`;

test('a file the shim opened is not inherited by a spawned child: closed, it unlinks while the child runs, as node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-noinherit-'));
  try {
    const prog = path.join(base, 'p.cjs');
    fs.writeFileSync(prog, PROG);
    const nodeDir = path.join(base, 'node'), shimDir = path.join(base, 'shim');
    fs.mkdirSync(nodeDir); fs.mkdirSync(shimDir);
    const node = spawnSync(process.execPath, [prog, nodeDir], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(node.status, 0, node.stderr);
    assert.strictEqual(node.stdout.trim(), 'unlinked', 'the host node oracle');
    const r = runLoader(prog, [shimDir], { timeout: 20000 });
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.strictEqual(r.stdout.trim().split('\n').pop(), 'unlinked');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
