'use strict';
// node:buffer — feross `buffer` (an ext-dep) when installed: a battle-tested
// Buffer for the bundle's 548 refs, and Buffer.from(ArrayBuffer) is a VIEW.
// Falls back to internal/buffer-lite.cjs (the toolchain's Buffer) when feross
// isn't resolvable, so deps-free toolchain tests stay green.
const feross = globalThis.__nodeShim.requireExt('buffer');
const impl = feross && feross.Buffer
  ? feross
  : require('./../internal/buffer-lite.cjs');

// base64url: Node's Buffer supports it; feross `buffer` v6.0.3 does not (it
// throws "Unknown encoding: base64url"), and buffer-lite only knows plain
// base64. The bundle decodes Remote Control "work secrets" with it. base64url
// is base64 over the URL-safe alphabet (`+`->`-`, `/`->`_`) with no `=`
// padding, so we translate to/from the impl's plain base64 rather than
// reimplement the codec. Idempotent guard so re-require never double-wraps.
const B = impl.Buffer;
if (B && !B.__clodeBase64Url) {
  B.__clodeBase64Url = true;
  const toB64 = (s) => {
    let x = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const pad = x.length % 4;
    return pad ? x + '='.repeat(4 - pad) : x;
  };
  const toB64Url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const _from = B.from;
  B.from = function from(src, enc, ...rest) {
    if (enc === 'base64url' && typeof src === 'string') return _from.call(this, toB64(src), 'base64');
    return _from.call(this, src, enc, ...rest);
  };
  // Preserve feross's other static Buffer.* members (alloc, concat, isBuffer, …).
  Object.getOwnPropertyNames(_from).forEach((k) => {
    if (!(k in B.from)) { try { B.from[k] = _from[k]; } catch (_) { /* readonly */ } }
  });
  const _toString = B.prototype.toString;
  B.prototype.toString = function toString(enc, ...rest) {
    if (enc === 'base64url') return toB64Url(_toString.call(this, 'base64'));
    return _toString.call(this, enc, ...rest);
  };
  const _isEncoding = typeof B.isEncoding === 'function' ? B.isEncoding.bind(B) : null;
  B.isEncoding = function isEncoding(e) {
    return e === 'base64url' || (_isEncoding ? _isEncoding(e) : false);
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
// re-require never double-wraps (same idiom as the base64url patch above).
// TextDecoder('utf-8',{fatal:true}) IS the WHATWG UTF-8 decode algorithm — it
// throws iff the input is not valid UTF-8, which is exactly Node's isUtf8
// contract (not an approximation).
if (impl && typeof impl.isUtf8 !== 'function') {
  const isDataView = (v) => typeof DataView !== 'undefined' && v instanceof DataView;
  const isSharedArrayBuffer = (v) => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer;
  impl.isUtf8 = function isUtf8(input) {
    let view;
    if (ArrayBuffer.isView(input) && !isDataView(input)) {
      view = input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else if (input instanceof ArrayBuffer || isSharedArrayBuffer(input)) {
      view = new Uint8Array(input);
    } else {
      throw Object.assign(
        new TypeError('The "input" argument must be an instance of Buffer, TypedArray, ArrayBuffer, or SharedArrayBuffer'),
        { code: 'ERR_INVALID_ARG_TYPE' });
    }
    // This tjs build's TextDecoder.decode() validates its argument with
    // `buf.buffer instanceof ArrayBuffer` (src/js/polyfills/text-encoding.js)
    // — which is FALSE for a view backed by a SharedArrayBuffer (verified:
    // SharedArrayBuffer is not `instanceof ArrayBuffer` on this engine), so
    // decode() would throw "Expected TypedArray or ArrayBuffer or
    // ArrayBufferView" on valid UTF-8 bytes and get silently swallowed by the
    // catch below into a wrong `false`. Normalize by copying into a fresh,
    // plain-ArrayBuffer-backed Uint8Array first — `new Uint8Array(view)`
    // always allocates a non-shared buffer regardless of the source, so this
    // sidesteps the engine's validation gap for every input shape uniformly.
    try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(view)); return true; }
    catch { return false; }
  };
}

module.exports = impl;
