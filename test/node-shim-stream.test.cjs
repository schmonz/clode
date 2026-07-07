'use strict';
// stream characterization: the shim's Readable/Writable/PassThrough must produce
// the same observable data/end/finish behavior as host node for the same fixture.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stream-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const BODY = `
  const { Readable, Writable, PassThrough } = require('node:stream');
  const seen = [];
  const r = new Readable({ read() {} });
  const w = new Writable({ write(chunk, enc, cb) { seen.push(chunk.toString()); cb(); } });
  w.on('finish', () => console.log(JSON.stringify({ seen, joined: seen.join('') })));
  const pt = new PassThrough();
  r.pipe(pt).pipe(w);
  r.push('PO'); r.push('NG'); r.push(null);
`;

test('stream: Readable->PassThrough->Writable matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.joined, 'PONG');
});

test('stream: .end(callback) with NO chunk runs cb, writes no data — Writable & PassThrough match node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { Writable, PassThrough } = require('node:stream');
    const out = {};
    // Writable: .end(cb) must invoke cb and write NOTHING (regression: the cb
    // must not be coerced to a string and written as a data chunk).
    const wSeen = [];
    const wOrder = [];
    const w = new Writable({ write(c, e, cb) { wSeen.push(c.toString()); cb(); } });
    w.on('finish', () => wOrder.push('finish'));
    w.end(() => {
      wOrder.push('endcb');
      out.wSeen = wSeen;
      // PassThrough: .end(cb) must invoke cb, write no stray data, and emit
      // BOTH 'finish' (writable side) and 'end' (readable side).
      const ptSeen = [];
      const ptOrder = [];
      const pt = new PassThrough();
      pt.on('data', (d) => ptSeen.push(d.toString()));
      pt.on('finish', () => ptOrder.push('finish'));
      pt.on('end', () => ptOrder.push('end'));
      pt.write('X');
      pt.end(() => ptOrder.push('endcb'));
      // Both streams' event tallies drain within a couple of microtask turns.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        out.wOrder = wOrder;
        out.ptSeen = ptSeen;
        out.ptOrder = ptOrder;
        console.log(JSON.stringify(out));
      })));
    });`);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  // Pin the host-node oracle: no stray data, cb ran, finish present.
  assert.deepStrictEqual(node.wSeen, []);
  assert.deepStrictEqual(node.ptSeen, ['X']);
  assert.ok(node.wOrder.includes('endcb') && node.wOrder.includes('finish'));
  assert.ok(node.ptOrder.includes('finish') && node.ptOrder.includes('end'));
});

test('stream: bare PassThrough write+end emits finish AND end in host-node order', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { PassThrough } = require('node:stream');
    const order = [];
    const seen = [];
    const pt = new PassThrough();
    pt.on('data', (d) => seen.push(d.toString()));
    pt.on('finish', () => order.push('finish'));
    pt.on('end', () => order.push('end'));
    pt.write('X');
    pt.end();
    // Drain a few microtask turns so both 'end' and 'finish' have fired
    // (the shim's process.on('exit') is a separate unimplemented surface).
    let n = 0;
    (function drain() { if (n++ < 8) queueMicrotask(drain); else console.log(JSON.stringify({ order, seen })); })();`);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  // Host node = oracle: BOTH fire, 'end' before 'finish'.
  assert.deepStrictEqual(node.order, ['end', 'finish']);
  assert.deepStrictEqual(node.seen, ['X']);
});

test('stream: async iteration over Readable matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { Readable } = require('node:stream');
    (async () => {
      const r = Readable.from(['P', 'O', 'N', 'G']);
      let out = '';
      for await (const c of r) out += c.toString();
      console.log(out);
    })();`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'PONG');
});

// Wall (Task 4, -p round-trip): the bundle's execa-style stream cleanup
// (get-stream's Q2n) calls `stream.destroy()` on consumed streams; a missing
// method threw `TypeError: not a function`. destroy() must mark the stream
// destroyed, emit 'close', be idempotent, and return the stream — matching node.
test('stream: destroy() emits close, sets destroyed, is idempotent (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { Readable, Writable } = require('node:stream');
    const out = {};
    const r = new Readable({ read() {} });
    out.type_destroy = typeof r.destroy;
    out.destroyed_before = r.destroyed;
    out.returns_self = r.destroy() === r;
    out.destroyed_after = r.destroyed;
    r.on('close', () => {
      out.close_fired = true;
      // idempotent: a second destroy must not throw or double-fire synchronously
      r.destroy();
      const w = new Writable({ write(c, e, cb) { cb(); } });
      out.w_destroy = typeof w.destroy;
      w.on('close', () => { out.w_close = true; console.log(JSON.stringify(out)); });
      w.destroy();
    });`);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// Wall (Task 4): the -p bundle does `class X extends require('stream').Transform`
// (SSE/text pipelines). Transform must be a real constructor whose subclass
// _transform/_flush run and whose output ('data' chunks, then 'end') matches
// host node.
test('stream: Transform subclass (_transform + _flush) matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { Transform } = require('node:stream');
    class Upper extends Transform {
      _transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); }
      _flush(cb) { cb(null, '!'); }
    }
    const out = [];
    const up = new Upper();
    up.on('data', (d) => out.push(d.toString()));
    up.on('end', () => console.log(JSON.stringify({ out, joined: out.join('') })));
    up.write('po'); up.write('ng'); up.end();
  `);
  const node = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.joined, 'PONG!');
});

// Wall (Task 4): the -p bundle captures require('stream/consumers') and
// stream/promises to drain response/body streams. text/json/buffer over a
// node-shim Readable must match host node.
test('stream/consumers + stream/promises consume a Readable like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { Readable } = require('stream');
    const consumers = require('stream/consumers');
    const sp = require('stream/promises');
    (async () => {
      const text = await consumers.text(Readable.from(['PO', 'NG']));
      const json = await consumers.json(Readable.from(['{"a":', '1}']));
      const buf = await consumers.buffer(Readable.from(['xy', 'z']));
      const fin = typeof sp.finished === 'function' && typeof sp.pipeline === 'function';
      console.log(JSON.stringify({ text, json, buf: buf.toString(), fin }));
    })();
  `);
  const node = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.text, 'PONG');
});
