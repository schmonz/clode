'use strict';
// buffer.isUtf8 (Task 5, Class C — armed by all three probe corpora, but the
// literal string "isUtf8" does not appear anywhere in the extracted
// entrypoints/cli.js text; some OTHER Bun-compiled module block bundled into
// the native binary reads it at runtime. Implemented for real regardless (per
// the task-5 brief: implement every genuine Class C gap with real semantics,
// not just enough to silence one caller). See
// libexec/node-shim/modules/buffer.cjs's isUtf8 addition.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-isutf8-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('buffer.isUtf8: valid UTF-8 (ascii, multibyte, empty) -> true', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const { isUtf8 } = require('buffer');
    console.log(JSON.stringify({
      ascii: isUtf8(Buffer.from('hello world', 'utf8')),
      multibyte: isUtf8(Buffer.from('héllo — wörld 🎉', 'utf8')),
      empty: isUtf8(Buffer.alloc(0)),
      viaUint8Array: isUtf8(new Uint8Array(Buffer.from('ok', 'utf8'))),
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    ascii: true, multibyte: true, empty: true, viaUint8Array: true,
  });
});

test('buffer.isUtf8: invalid byte sequences -> false', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const { isUtf8 } = require('buffer');
    console.log(JSON.stringify({
      loneContinuation: isUtf8(Buffer.from([0x80])),
      invalidStart: isUtf8(Buffer.from([0xff, 0xfe])),
      truncatedMultibyte: isUtf8(Buffer.from([0xe2, 0x82])), // incomplete U+20AC
      overlongEncoding: isUtf8(Buffer.from([0xc0, 0xaf])),   // overlong '/'
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    loneContinuation: false, invalidStart: false, truncatedMultibyte: false, overlongEncoding: false,
  });
});

test('buffer.isUtf8: rejects a non-buffer/typed-array/arraybuffer argument, with an ERR_INVALID_ARG_TYPE code', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const { isUtf8 } = require('buffer');
    try {
      isUtf8('not a buffer');
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, name: e.constructor.name, code: e.code }));
    }`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { threw: true, name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
});

// REGRESSION (found by review): Node's real accept/reject set is
// `isTypedArray(input) || isAnyArrayBuffer(input)` — that ACCEPTS
// SharedArrayBuffer (an "any array buffer") and REJECTS DataView (an
// ArrayBufferView that is NOT a typed array). An earlier version of this
// shim (and its own code comment) had this backwards: it accepted DataView
// via a blanket `ArrayBuffer.isView` check and never considered
// SharedArrayBuffer at all (which is not `instanceof ArrayBuffer` under
// tjs, verified empirically — a plain `instanceof ArrayBuffer` check alone
// would silently reject it).
test('buffer.isUtf8: accepts SharedArrayBuffer, rejects DataView (matches Node, not the reverse)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const { isUtf8 } = require('buffer');
    const sab = new SharedArrayBuffer(3);
    new Uint8Array(sab).set(Buffer.from('hi!', 'utf8'));
    const dv = new DataView(new Uint8Array(Buffer.from('hi!', 'utf8')).buffer);
    let dataViewCode;
    try { isUtf8(dv); } catch (e) { dataViewCode = e.code; }
    console.log(JSON.stringify({
      sharedArrayBuffer: isUtf8(sab),
      dataViewRejectedCode: dataViewCode,
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    sharedArrayBuffer: true, dataViewRejectedCode: 'ERR_INVALID_ARG_TYPE',
  });
});
