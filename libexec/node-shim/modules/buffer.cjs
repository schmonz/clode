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

module.exports = impl;
