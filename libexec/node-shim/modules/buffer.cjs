'use strict';
// node:buffer — feross `buffer` (an ext-dep) when installed: a battle-tested
// Buffer for the bundle's 548 refs, and Buffer.from(ArrayBuffer) is a VIEW.
// Falls back to internal/buffer-lite.cjs (the toolchain's Buffer) when feross
// isn't resolvable, so deps-free toolchain tests stay green.
const feross = globalThis.__nodeShim.requireExt('buffer');
const impl = feross && feross.Buffer
  ? feross
  : require('./../internal/buffer-lite.cjs');

// base64, base64url and hex: internal/codec.cjs, the shim's ONE codec (the engine's native Uint8Array base64/hex,
// read with node's lenient rules), in place of feross's base64-js and hex loops. feross 6.0.3 also has no
// base64url at all ("Unknown encoding: base64url"; the bundle decodes Remote Control "work secrets" with it),
// sizes base64 by decoding it rather than by node's length estimate, ignores toString's range for base64url, and
// reads '1g' as hex 01; test/node-shim-buffer-codec.test.cjs holds every member below to host node's answers.
// buffer-lite calls the codec itself. The one path left on base64-js is feross's own byte COUNT inside the
// deprecated `Buffer(string, encoding)` constructor; the bytes it then writes come through write() below.
// Idempotent guard so re-require never double-wraps.
const codec = require('../internal/codec.cjs');
const B = impl.Buffer;
if (impl === feross && B && !B.__clodeCodec) {
  B.__clodeCodec = true;
  const _from = B.from;
  const fromBytes = (u8) => _from.call(B, u8.buffer, u8.byteOffset, u8.byteLength);
  B.from = function from(src, enc, ...rest) {
    const c = typeof src === 'string' ? codec.codecOf(enc) : null;
    return c ? fromBytes(codec.decode(src, c)) : _from.call(this, src, enc, ...rest);
  };
  // Preserve feross's other static Buffer.* members (alloc, concat, isBuffer, …).
  Object.getOwnPropertyNames(_from).forEach((k) => {
    if (!(k in B.from)) { try { B.from[k] = _from[k]; } catch (_) { /* readonly */ } }
  });
  // node's toString(encoding, start, end) range rules (lib/buffer.js), then the codec.
  const _toString = B.prototype.toString;
  B.prototype.toString = function toString(enc, start, end) {
    const c = codec.codecOf(enc);
    if (!c) return _toString.apply(this, arguments);
    const len = this.length;
    if (start <= 0 || start === undefined) start = 0;
    else if (start >= len) return '';
    else start = Math.trunc(start) || 0;
    if (end === undefined || end > len) end = len;
    else end = Math.trunc(end) || 0;
    if (end <= start) return '';
    return codec.encode(start === 0 && end === len ? this : Uint8Array.prototype.subarray.call(this, start, end), c);
  };
  B.prototype.toLocaleString = B.prototype.toString;
  // write(string[, offset[, length]][, encoding]): node's argument shapes; a decoded string is written up to
  // the room left. An offset or length feross would refuse is left to feross to refuse.
  const _write = B.prototype.write;
  B.prototype.write = function write(string, offset, length, encoding) {
    const enc = typeof offset === 'string' ? offset : typeof length === 'string' ? length : encoding;
    const c = codec.codecOf(enc);
    if (!c) return _write.apply(this, arguments);
    let off = 0, room = this.length;
    if (typeof offset !== 'string' && offset !== undefined) {
      if (!Number.isInteger(offset) || offset < 0 || offset > this.length) return _write.apply(this, arguments);
      off = offset; room = this.length - offset;
      if (typeof length !== 'string' && length !== undefined) {
        if (!Number.isInteger(length) || length < 0) return _write.apply(this, arguments);
        room = Math.min(room, length);
      }
    }
    const bytes = codec.decode(string, c);
    const n = Math.min(bytes.length, room);
    Uint8Array.prototype.set.call(this, n === bytes.length ? bytes : bytes.subarray(0, n), off);
    return n;
  };
  const _byteLength = B.byteLength;
  B.byteLength = function byteLength(string, enc) {
    const c = typeof string === 'string' ? codec.codecOf(enc) : null;
    return c ? codec.byteLength(string, c) : _byteLength.apply(this, arguments);
  };
  const _isEncoding = typeof B.isEncoding === 'function' ? B.isEncoding.bind(B) : null;
  B.isEncoding = function isEncoding(e) {
    return codec.codecOf(e) !== null || (_isEncoding ? _isEncoding(e) : false);
  };
}

// buffer.isUtf8(input) (Task 5 gap, Class C): armed by the probe (reachability.json)
// but the string "isUtf8" does not appear anywhere in the extracted cli.js text —
// this is a property GET from some OTHER Bun-compiled module block bundled into
// the native binary (an ext-dep loaded at runtime, not entrypoints/cli.js), so
// which caller can't be pinned by grepping the entry alone. Implemented for real
// regardless, per Node's contract: input must be a TypedArray (Buffer included —
// Buffer IS a Uint8Array) or an ArrayBuffer/SharedArrayBuffer — Node's own check
// is `isTypedArray(input) || isAnyArrayBuffer(input)`, which EXCLUDES DataView
// (an ArrayBufferView but not a typed array; Node throws ERR_INVALID_ARG_TYPE on
// it, it does not accept it — an earlier draft of this comment claimed the
// opposite without checking). Neither feross `buffer` nor internal/buffer-lite.cjs
// (the two possible `impl`s) define this, so it's added here, once, guarded so
// re-require never double-wraps (same idiom as the codec patch above).
// TextDecoder('utf-8',{fatal:true}) IS the WHATWG UTF-8 decode algorithm — it
// throws iff the input is not valid UTF-8, which is exactly Node's isUtf8
// contract (not an approximation).
// The bytes of a buffer.isUtf8/isAscii input, or node's own ERR_INVALID_ARG_TYPE: node checks
// `isTypedArray(input) || isAnyArrayBuffer(input)` (a DataView is refused) and words the error
// with the input it received, as node 24 does (measured under 24.21.0, 2026-11-21).
function bytesOf(input) {
  const isDataView = typeof DataView !== 'undefined' && input instanceof DataView;
  if (ArrayBuffer.isView(input) && !isDataView) {
    return input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer)) {
    return new Uint8Array(input);
  }
  throw require('../internal/node-errors.cjs').invalidArgType('The "input" argument must be an instance of ArrayBuffer, Buffer, or TypedArray', input);
}
if (impl && typeof impl.isUtf8 !== 'function') {
  impl.isUtf8 = function isUtf8(input) {
    const view = bytesOf(input);
    // This tjs build's TextDecoder.decode() validates its argument with
    // `buf.buffer instanceof ArrayBuffer` (src/js/polyfills/text-encoding.js)
    // -- which is FALSE for a view backed by a SharedArrayBuffer (verified:
    // SharedArrayBuffer is not `instanceof ArrayBuffer` on this engine), so
    // decode() would throw "Expected TypedArray or ArrayBuffer or
    // ArrayBufferView" on valid UTF-8 bytes and get silently swallowed by the
    // catch below into a wrong `false`. Normalize by copying into a fresh,
    // plain-ArrayBuffer-backed Uint8Array first -- `new Uint8Array(view)`
    // always allocates a non-shared buffer regardless of the source, so this
    // sidesteps the engine's validation gap for every input shape uniformly.
    try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(view)); return true; }
    catch { return false; }
  };
}
// buffer.isAscii(input): 2.1.330 imports it (`import{isAscii as X}from"buffer"`, and its JSONL
// reader's `te.isAscii(e)`), and neither feross `buffer` nor buffer-lite defines it. Node's
// contract: true iff every byte is below 0x80, the same inputs as isUtf8.
if (impl && typeof impl.isAscii !== 'function') {
  impl.isAscii = function isAscii(input) {
    const view = bytesOf(input);
    for (let i = 0; i < view.length; i++) if (view[i] > 0x7f) return false;
    return true;
  };
}

// buffer.constants.MAX_LENGTH / MAX_STRING_LENGTH (and kMaxLength / kStringMaxLength). 2.1.330's hook runner caps a
// hook's JSON input at `Math.floor(buffer.constants.MAX_STRING_LENGTH/2)`; neither feross nor buffer-lite defines
// MAX_STRING_LENGTH, so the cap was NaN, nothing compared under it, and EVERY PreToolUse hook was refused with "this
// call's input can't be written as JSON" (the update guard among them).
// THE VALUES ARE THIS ENGINE'S OWN LIMITS, not native's. Native (Bun, measured in 2.1.330) answers MAX_LENGTH
// 4294967296 and MAX_STRING_LENGTH 2147483647; QuickJS-ng cannot reach either, so claiming them would promise a
// buffer or string this engine refuses. Its string limit is JS_STRING_LEN_MAX, (1 << 30) - 1 (quickjs.c; 'x'.repeat
// past it throws "invalid string length"), and an ArrayBuffer, hence a Buffer, is capped at INT32_MAX ("invalid array
// buffer length"). test/node-shim-buffer-isascii.test.cjs proves both edges under tjs and re-asks native's numbers.
if (impl) {
  const MAX_LENGTH = 2147483647;
  const MAX_STRING_LENGTH = 1073741823;
  const constants = impl.constants && typeof impl.constants === 'object' ? impl.constants : {};
  if (constants.MAX_LENGTH === undefined) constants.MAX_LENGTH = MAX_LENGTH;
  if (constants.MAX_STRING_LENGTH === undefined) constants.MAX_STRING_LENGTH = MAX_STRING_LENGTH;
  try { impl.constants = constants; } catch (_) { /* readonly */ }
  try { impl.kMaxLength = constants.MAX_LENGTH; } catch (_) { /* readonly */ }
  try { impl.kStringMaxLength = constants.MAX_STRING_LENGTH; } catch (_) { /* readonly */ }
}

module.exports = impl;
