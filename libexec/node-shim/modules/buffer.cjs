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
// regardless, per Node's contract: input is a Buffer/TypedArray/ArrayBuffer/
// DataView; returns true iff its bytes are valid UTF-8. Neither feross `buffer`
// nor internal/buffer-lite.cjs (the two possible `impl`s) define this, so it's
// added here, once, guarded so re-require never double-wraps (same idiom as the
// base64url patch above). TextDecoder('utf-8',{fatal:true}) IS the WHATWG UTF-8
// decode algorithm — it throws iff the input is not valid UTF-8, which is exactly
// Node's isUtf8 contract (not an approximation).
if (impl && typeof impl.isUtf8 !== 'function') {
  impl.isUtf8 = function isUtf8(input) {
    let view;
    if (impl.Buffer && impl.Buffer.isBuffer(input)) view = input;
    else if (input instanceof ArrayBuffer) view = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError('The "input" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView');
    try { new TextDecoder('utf-8', { fatal: true }).decode(view); return true; }
    catch { return false; }
  };
}

module.exports = impl;
