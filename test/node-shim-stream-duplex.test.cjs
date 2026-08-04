'use strict';
// stream.Duplex (Task 5, Class C — armed and already tracked in golden.json's
// layer2_node_apis_missing). Real semantics: readable+writable sides are
// INDEPENDENT (unlike Transform, which auto-flows write->read via
// _transform) — a subclass wires push() itself from _write. See
// libexec/node-shim/modules/stream.cjs's Duplex class comment for the
// AWS-SDK ChecksumStream shape (`class X extends require('stream').Duplex`,
// found verbatim in the extracted 2.1.218 bundle) this was modeled on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-duplex-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('stream.Duplex is a real class: instanceof Readable, has write/end/push', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const stream = require('stream');
    class X extends stream.Duplex {
      _read() {}
      _write(chunk, enc, cb) { this.push(chunk); cb(); }
    }
    const x = new X();
    console.log(JSON.stringify({
      isFunction: typeof stream.Duplex === 'function',
      instanceofReadable: x instanceof stream.Readable,
      instanceofDuplex: x instanceof stream.Duplex,
      hasWrite: typeof x.write === 'function',
      hasPush: typeof x.push === 'function',
      hasEnd: typeof x.end === 'function',
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    isFunction: true, instanceofReadable: true, instanceofDuplex: true,
    hasWrite: true, hasPush: true, hasEnd: true,
  });
});

test('Duplex: data written flows to the readable side only via an explicit push() (not auto-piped)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const stream = require('stream');
    class X extends stream.Duplex {
      _read() {}
      _write(chunk, enc, cb) { this.push(Buffer.from(chunk.toString().toUpperCase())); cb(); }
    }
    const x = new X();
    const chunks = [];
    x.on('data', (d) => chunks.push(d.toString()));
    x.write('hello');
    x.end();
    setTimeout(() => {
      console.log(JSON.stringify({ chunks }));
      process.exit(0);
    }, 50);`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { chunks: ['HELLO'] });
});

test('Duplex: _final runs BEFORE finish, and end() waits for it (async cleanup point)', (t) => {
  if (skipUnlessTjs(t)) return;
  // Mirrors the extracted bundle's ChecksumStream: an async _final that does
  // work (there: checksum verification) before signalling completion.
  const f = writeProg(`
    const stream = require('stream');
    class X extends stream.Duplex {
      _read() {}
      _write(chunk, enc, cb) { cb(); }
      _final(cb) {
        this._finalRan = true;
        setTimeout(cb, 10);   // async cleanup, like the real ChecksumStream's checksum.digest()
      }
    }
    const x = new X();
    const order = [];
    x.on('finish', () => { order.push('finish:_finalRan=' + x._finalRan); });
    x.end();
    setTimeout(() => {
      console.log(JSON.stringify({ order }));
      process.exit(0);
    }, 50);`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { order: ['finish:_finalRan=true'] });
});

test('Duplex: source.pipe(duplex) then source-end triggers dest.end() -> _final -> finish (the exact bundle shape)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const stream = require('stream');
    class ChecksumStream extends stream.Duplex {
      constructor() { super(); this.seen = []; }
      _read() {}
      _write(chunk, enc, cb) { this.seen.push(chunk.toString()); this.push(chunk); cb(); }
      _final(cb) { this.push(null); cb(); }
    }
    const src = stream.Readable.from(['a', 'b', 'c']);
    const cs = new ChecksumStream();
    const out = [];
    cs.on('data', (d) => out.push(d.toString()));
    cs.on('end', () => {
      console.log(JSON.stringify({ seen: cs.seen, out }));
      process.exit(0);
    });
    src.pipe(cs);`);
  const r = runLoader(f, [], { timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { seen: ['a', 'b', 'c'], out: ['a', 'b', 'c'] });
});

test('Duplex: end() after end() is idempotent (matches Writable.end)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const stream = require('stream');
    class X extends stream.Duplex { _read() {} }
    const x = new X();
    x.end();
    x.end((err) => {
      console.log(JSON.stringify({ code: err && err.code }));
      process.exit(0);
    });`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { code: 'ERR_STREAM_ALREADY_FINISHED' });
});

// REGRESSION (found by review): write() had no guard against arriving after
// end() was called — for the AWS-SDK ChecksumStream shape this class was
// modeled on, a stray post-end write would silently fold into the checksum
// under this shim while host Node rejects it outright
// (ERR_STREAM_WRITE_AFTER_END) and reports .writable === false. Also checks
// .writable flips false the instant end() is CALLED, not only once 'finish'
// fires later.
test('Duplex: write() after end() is rejected (ERR_STREAM_WRITE_AFTER_END), .writable flips false immediately', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const stream = require('stream');
    class X extends stream.Duplex {
      _read() {}
      _write(chunk, enc, cb) { (this.seen ??= []).push(chunk.toString()); cb(); }
    }
    const x = new X();
    x.write('a');
    const writableRightAfterEnd = (x.end(), x.writable);
    x.write('b', (err) => {
      console.log(JSON.stringify({
        writableRightAfterEnd,
        seen: x.seen,
        rejectedCode: err && err.code,
      }));
      process.exit(0);
    });`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    writableRightAfterEnd: false,
    seen: ['a'],                              // only the pre-end write reached _write
    rejectedCode: 'ERR_STREAM_WRITE_AFTER_END',
  });
});

test('Duplex: end(chunk) still writes the end-supplied chunk (the write-after-end guard must not reject it)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const stream = require('stream');
    class X extends stream.Duplex {
      _read() {}
      _write(chunk, enc, cb) { (this.seen ??= []).push(chunk.toString()); cb(); }
    }
    const x = new X();
    x.on('finish', () => {
      console.log(JSON.stringify({ seen: x.seen }));
      process.exit(0);
    });
    x.end('last-chunk');`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { seen: ['last-chunk'] });
});
