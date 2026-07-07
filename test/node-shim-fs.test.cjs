'use strict';
// fs characterization: a scripted round-trip in a temp sandbox must produce
// the same observable answers under node and under the shim.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const out = [];
fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
fs.writeFileSync(path.join(dir, 'a/x.txt'), 'hello sync world');
out.push(fs.readFileSync(path.join(dir, 'a/x.txt'), 'utf8'));
out.push(fs.existsSync(path.join(dir, 'a/x.txt')), fs.existsSync(path.join(dir, 'nope')));
const st = fs.statSync(path.join(dir, 'a/x.txt'));
out.push(st.isFile(), st.isDirectory(), st.size);
fs.symlinkSync(path.join(dir, 'a/x.txt'), path.join(dir, 'a/lnk'));
out.push(fs.lstatSync(path.join(dir, 'a/lnk')).isSymbolicLink());
out.push(path.basename(fs.realpathSync(path.join(dir, 'a/lnk'))));
out.push(fs.readdirSync(path.join(dir, 'a')).sort());
const fd = fs.openSync(path.join(dir, 'a/x.txt'), 'r');
const buf = new Uint8Array(5);
out.push(fs.readSync(fd, buf, 0, 5, 6), new TextDecoder().decode(buf));
fs.closeSync(fd);
fs.renameSync(path.join(dir, 'a/x.txt'), path.join(dir, 'a/y.txt'));
fs.unlinkSync(path.join(dir, 'a/lnk'));
out.push(fs.readdirSync(path.join(dir, 'a')).sort());
try { fs.readFileSync(path.join(dir, 'ghost')); } catch (e) { out.push(e.code); }
fs.promises.readFile(path.join(dir, 'a/y.txt'), 'utf8').then((s) => {
  out.push('p:' + s.slice(0, 5));
  console.log(JSON.stringify(out));
});
`;

test('fs characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fs-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fs-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fs-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
