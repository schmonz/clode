'use strict';
// buffer.isAscii and buffer.isUtf8, and fs.close / fs.write / fs.read with missing or wrong
// arguments, judged against host node by running ONE program under both.
//
// 2.1.330 imports buffer.isAscii (`import{isAscii as X}from"buffer"`, and its JSONL reader's
// `te.isAscii(e)`); neither feross `buffer` nor buffer-lite has it, so under quaude it was
// undefined. Its carve also calls fs.close, fs.write and fs.read; the shim's callback forms
// mishandled a missing argument: `fs.close(cb)` and `fs.write(fd, cb)` called NOTHING back (the
// shim differential's executor waited forever), and `fs.read(fd, cb)` threw "not a function".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROGRAM = `
const { isAscii, isUtf8 } = require('buffer');
const fs = require('fs');
const out = [];
const one = (name, f) => { try { out.push([name, f()]); } catch (e) { out.push([name, 'threw', e.name, e.code, e.message]); } };
for (const [k, f] of [['isAscii', isAscii], ['isUtf8', isUtf8]]) {
  for (const [label, v] of [['empty', Buffer.alloc(0)], ['abc', Buffer.from('abc')], ['7f', Buffer.from([0x7f])],
    ['80', Buffer.from([0x80])], ['euro', Buffer.from('\\u20ac')], ['u16', new Uint16Array([65, 0x80])],
    ['arraybuffer', new Uint8Array([1, 2]).buffer], ['string', 'not bytes'], ['long string', 'x'.repeat(40)],
    ['null', null], ['undefined', undefined], ['dataview', new DataView(new ArrayBuffer(2))], ['number', 42],
    ['object', {}], ['function', function named() {}]]) {
    one(k + ' ' + label, () => f(v));
  }
}
const file = process.argv[2];
const fd = fs.openSync(file, 'r+');
const cases = [
  ['close(cb)', (cb) => fs.close(cb)],
  ['close(undefined, cb)', (cb) => fs.close(undefined, cb)],
  ['close("x", cb)', (cb) => fs.close('x', cb)],
  ['close(1.5, cb)', (cb) => fs.close(1.5, cb)],
  ['close(-1, cb)', (cb) => fs.close(-1, cb)],
  ['write(fd, cb)', (cb) => fs.write(fd, cb)],
  ['write(fd, {}, cb)', (cb) => fs.write(fd, {}, cb)],
  ['write(fd, "x", 0, cb)', (cb) => fs.write(fd, 'x', 0, cb)],
  ['write("x", "y", cb)', (cb) => fs.write('x', 'y', cb)],
  ['read(fd, cb)', (cb) => fs.read(fd, cb)],
  ['read(fd, buf, cb)', (cb) => fs.read(fd, Buffer.alloc(3), cb)],
  ['read(fd, buf, opts, cb)', (cb) => fs.read(fd, Buffer.alloc(4), { offset: 1, length: 2, position: 0 }, cb)],
  ['read(fd, opts, cb)', (cb) => fs.read(fd, { buffer: Buffer.alloc(2), position: 1 }, cb)],
  ['read(fd, {}, cb) no buffer', (cb) => fs.read(fd, 'nope', 0, 1, 0, cb)],
  // readSync's options form (2.1.330 calls readSync(fd, buf, {position})), and its defaults
  ['readSync(fd, buf, {position:0})', (cb) => { const b = Buffer.alloc(8); cb(null, fs.readSync(fd, b, { position: 0 }), b); }],
  ['readSync(fd, buf, {offset:2,length:3,position:1})', (cb) => { const b = Buffer.alloc(8); cb(null, fs.readSync(fd, b, { offset: 2, length: 3, position: 1 }), b); }],
  ['readSync(fd, buf, 1, undefined, 0)', (cb) => { const b = Buffer.alloc(4); cb(null, fs.readSync(fd, b, 1, undefined, 0), b); }],
  ['readSync(fd, buf)', (cb) => { const b = Buffer.alloc(4); cb(null, fs.readSync(fd, b), b); }],
  ['readSync(fd, buf, 1)', (cb) => { const b = Buffer.alloc(4); cb(null, fs.readSync(fd, b, 1), b); }],
];
(async () => {
  for (const [name, run] of cases) {
    out.push([name, await new Promise((res) => {
      const t = setTimeout(() => res('NO CALLBACK'), 2000);
      try {
        run((e, n, b) => { clearTimeout(t); res(e ? ['cb error', e.code] : ['cb', n, Buffer.isBuffer(b) ? b.subarray(0, 8).toString('hex') + ':' + b.length : b]); });
      } catch (e) { clearTimeout(t); res(['threw', e.name, e.code, e.message]); }
    })]);
  }
  fs.closeSync(fd);
  console.log(JSON.stringify(out));
})();
`;

test('buffer.isAscii/isUtf8 and fs.close/write/read argument handling answer as host node does', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-isascii-'));
  try {
    const prog = path.join(dir, 'p.cjs');
    fs.writeFileSync(prog, PROGRAM);
    const run = (who) => {
      const file = path.join(dir, `data-${who}.txt`);
      fs.writeFileSync(file, 'hello\n');
      const r = who === 'node' ? spawnSync(process.execPath, [prog, file], { encoding: 'utf8', timeout: 30000 }) : runLoader(prog, [file]);
      assert.strictEqual(r.status, 0, `${who}: ${r.stderr}`);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const node = run('node');
    const ours = run('quaude');
    assert.ok(node.length > 40);
    for (let i = 0; i < node.length; i++) assert.deepStrictEqual(ours[i], node[i], `row ${i}: ${node[i][0]}`);
    assert.strictEqual(ours.length, node.length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
