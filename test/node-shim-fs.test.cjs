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

// latin1 byte round-trip: this is the extractor's core representation
// (extract-claude-js reads the native binary as a latin1 string so 1 char == 1
// byte, then writes Buffer.from(text, 'latin1')). readFileSync(,'latin1') must
// return a string of code points 0..255, and Buffer.from(str,'latin1') must
// re-encode low-byte (NOT utf-8, which would corrupt bytes >= 0x80).
const LATIN1_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
// Every byte value 0..255, twice, so a naive utf-8 round-trip is visibly wrong.
const src = Buffer.from(Array.from({ length: 512 }, (_, i) => i & 0xff));
const srcPath = path.join(dir, 'bytes.bin');
fs.writeFileSync(srcPath, src);
const s = fs.readFileSync(srcPath, 'latin1');
const outPath = path.join(dir, 'rt.bin');
fs.writeFileSync(outPath, Buffer.from(s, 'latin1'));
const rt = fs.readFileSync(outPath); // bytes
console.log(JSON.stringify({
  typeofRead: typeof s,
  len: s.length,
  cp0: s.charCodeAt(0), cp200: s.charCodeAt(200), cp255: s.charCodeAt(255),
  roundTripLen: rt.length,
  roundTripEqual: Buffer.from(rt).equals(src),
}));
`;

test('fs.readFileSync latin1 + Buffer.from latin1 round-trip vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-latin1-'));
  const f = path.join(base, 'l1.cjs');
  fs.writeFileSync(f, LATIN1_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-l1-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-l1-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    typeofRead: 'string', len: 512, cp0: 0, cp200: 200, cp255: 255,
    roundTripLen: 512, roundTripEqual: true,
  });
});
