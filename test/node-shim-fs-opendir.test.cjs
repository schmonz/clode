'use strict';
// fs.opendirSync's Dir under quaude, judged against host node. node's Dir hands over a directory's
// entries in the order the OS's readdir gives them (libuv uv_fs_readdir), where fs.readdirSync sorts
// them (libuv's scandir sorts by name). quaude's rg walks in rg's order, which is readdir's (grep-native
// Task 9, libexec/rg-walk.cjs), so it reads directories through opendirSync + readSync on every engine.
// node-shim's Dir had read() and an async iterator but no readSync (Task 7 re-review M3) and no
// closeSync-then-read error. Each entry, its order and its type must be node's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs');
const dir = process.argv[2];
const KINDS = ['isFile', 'isDirectory', 'isSymbolicLink'];
const out = { sync: [], async: [] };
const d = fs.opendirSync(dir);
for (let e; (e = d.readSync()) !== null;) out.sync.push(e.name + ' ' + KINDS.filter((k) => e[k]()).join(','));
d.closeSync();
let after;
try { d.readSync(); after = 'read after close answered'; } catch (e) { after = e.code; }
out.afterClose = after;
(async () => {
  for await (const e of await fs.promises.opendir(dir)) out.async.push(e.name);
  console.log(JSON.stringify(out));
})();
`;

test('opendirSync().readSync() hands over entries in readdir order with their types, as host node does', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-opendir-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const dir = path.join(base, 'd');
    fs.mkdirSync(dir);
    // enough names that readdir order is not name order on any filesystem this runs on
    for (const n of ['zeta', 'alpha', 'Mike', 'bravo', '10', '9', '_x', 'charlie', 'delta', 'echo', 'kilo', 'lima']) fs.writeFileSync(path.join(dir, n), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.symlinkSync('alpha', path.join(dir, 'link'));
    const nodeOut = JSON.parse(execFileSync(process.execPath, [prog, dir], { encoding: 'utf8', timeout: 15000 }));
    // the oracle itself: every entry once, readdir's order (not necessarily sorted), and the close error
    assert.strictEqual(nodeOut.sync.length, 14);
    assert.deepStrictEqual(nodeOut.async, nodeOut.sync.map((s) => s.split(' ')[0]));
    const r = runLoader(prog, [dir]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), nodeOut);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
