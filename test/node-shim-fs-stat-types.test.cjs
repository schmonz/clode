'use strict';
// fs.Stats and fs.Dirent TYPES under quaude, judged against host node (Task 7 review I3). node-shim's
// Stats answered isFIFO(), isSocket() and isBlockDevice() false for every path and isCharacterDevice()
// false even for /dev/null (it keyed on an engine `kind` that is only file/dir/symlink/other), and its
// Dirent the same. The 2.1.283 bundle asks them: readInheritedFdSync refuses any fd that is not a
// socket or FIFO, so every CLAUDE_CODE_*_FILE_DESCRIPTOR credential handed over a pipe failed under
// quaude ("not a pipe or socket"). The engine's mode bits were right all along; every is*() now reads
// them. Each kind of path, through statSync, lstatSync, fstatSync, fs.promises.stat and readdir's
// Dirents, must answer as node answers. (dev, ino and rdev: the engine's sync stat does not carry
// them yet, BACKLOG; not judged here.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2];
const KINDS = ['isFile', 'isDirectory', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isCharacterDevice', 'isBlockDevice'];
const types = (s) => KINDS.filter((k) => s[k]()).join(',') + ' mode-type ' + ((s.mode & 0o170000) >>> 0).toString(8);
const out = {};
const paths = { file: path.join(dir, 'file.txt'), dir: path.join(dir, 'sub'), link: path.join(dir, 'link'), fifo: path.join(dir, 'fifo'),
  sock: path.join(dir, 'sock'), null: '/dev/null' };
for (const [name, p] of Object.entries(paths)) {
  out[name + ' stat'] = types(fs.statSync(p));
  out[name + ' lstat'] = types(fs.lstatSync(p));
  if (name !== 'sock' && name !== 'dir') {
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    out[name + ' fstat'] = types(fs.fstatSync(fd));
    fs.closeSync(fd);
  }
}
(async () => {
  for (const [name, p] of Object.entries(paths)) out[name + ' promises.stat'] = types(await fs.promises.stat(p));
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) out['dirent ' + d.name] = KINDS.filter((k) => d[k]()).join(',');
  console.log(JSON.stringify(out));
})();
`;

test('Stats and Dirent report every file type as host node does (stat, lstat, fstat, promises, readdir)', {
  skip: process.platform === 'win32' ? 'no FIFOs, unix sockets or /dev/null' : false,
}, async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stat-types-')));
  const server = net.createServer();
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const dir = path.join(base, 'd');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
    fs.symlinkSync('file.txt', path.join(dir, 'link'));
    assert.strictEqual(spawnSync('mkfifo', [path.join(dir, 'fifo')]).status, 0);
    await new Promise((res, rej) => { server.once('error', rej); server.listen(path.join(dir, 'sock'), res); });
    const nodeOut = execFileSync(process.execPath, [prog, dir], { encoding: 'utf8', timeout: 15000 }).trim();
    // the oracle itself must see each kind, or the comparison judges nothing
    const n = JSON.parse(nodeOut);
    assert.match(n['fifo stat'], /^isFIFO /);
    assert.match(n['sock lstat'], /^isSocket /);
    assert.match(n['null stat'], /^isCharacterDevice /);
    assert.strictEqual(n['dirent fifo'], 'isFIFO');
    const r = runLoader(prog, [dir], { timeout: 15000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), n);
  } finally { server.close(); fs.rmSync(base, { recursive: true, force: true }); }
});
