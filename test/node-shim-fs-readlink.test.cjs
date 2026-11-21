'use strict';
// fs.readlinkSync under quaude answers as host node does: a link's target, EINVAL for a file or a directory that is
// no link, ENOENT for nothing. The engine's sync readlink threw ENOSYS on Windows for EVERY path (txiki-sync-fs.patch
// had no Windows branch), and 2.1.330's permission check walks each directory of a path asking readlinkSync whether
// it is a link or a junction, reading EINVAL as "a plain directory". ENOSYS made every path unclassifiable, and the
// check calls an unclassifiable path sensitive: every Edit on Windows came back "Claude requested permissions to edit
// ... which is a sensitive file" (CI 44945260530, windows-amd64-tests and windows-arm64-tests). It now goes through
// libuv's uv_fs_readlink on every platform (txiki-sync-readlink.patch), the call node makes.
//
// Judged on every host the suite runs on, and on the real Windows kernels (ci.yml windows-*-tests), where a
// directory junction is judged too. A relative target is printed as given; an absolute one relative to the tree, so
// node and quaude, run in different temp trees, print the same thing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs'), path = require('node:path');
const dir = fs.realpathSync(process.argv[2]);
fs.mkdirSync(path.join(dir, 'd'));
fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
fs.symlinkSync('f.txt', path.join(dir, 'rel-link'));
fs.symlinkSync(path.join(dir, 'd'), path.join(dir, 'dir-link'), 'dir');
if (process.platform === 'win32') fs.symlinkSync(path.join(dir, 'd'), path.join(dir, 'junction'), 'junction');
const out = {};
for (const name of ['d', 'f.txt', 'missing', 'rel-link', 'dir-link', 'junction']) {
  if (name === 'junction' && process.platform !== 'win32') continue;
  try {
    const v = fs.readlinkSync(path.join(dir, name));
    out[name] = 'target ' + (path.isAbsolute(v) ? '<DIR>' + path.sep + path.relative(dir, v) : v);
  } catch (e) { out[name] = 'error ' + e.code + ' ' + e.syscall; }
}
console.log(JSON.stringify(out));`;

test('fs.readlinkSync answers as host node does: targets, EINVAL for no link, ENOENT for nothing', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-readlink-'));
  try {
    const prog = path.join(base, 'p.cjs');
    fs.writeFileSync(prog, PROG);
    const nodeDir = path.join(base, 'node'), shimDir = path.join(base, 'shim');
    fs.mkdirSync(nodeDir); fs.mkdirSync(shimDir);
    const node = spawnSync(process.execPath, [prog, nodeDir], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const want = JSON.parse(node.stdout.trim());
    assert.match(want.d, /^error EINVAL readlink$/, 'the host node oracle answers EINVAL for a plain directory');
    const r = runLoader(prog, [shimDir]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), want);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
