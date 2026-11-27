'use strict';
// Buffer-lite: the toolchain's Buffer surface as a Uint8Array subclass.
// M2 replaces this with the vendored feross `buffer` for the bundle's needs.
const te = new TextEncoder();
const td = new TextDecoder();
// base64, base64url and hex are internal/codec.cjs, the shim's one codec (native, with node's lenient decoding).
const codec = require('./codec.cjs');

// node's encoding names, any case: 'utf8' (also 'utf-8'), 'utf16le' (also 'utf-16le', 'ucs2', 'ucs-2'),
// 'latin1' (also 'binary'), 'ascii', 'base64', 'base64url', 'hex'. Anything else is read as utf8, as
// before (node throws ERR_UNKNOWN_ENCODING there).
const ENCODING = { 'utf-8': 'utf8', ucs2: 'utf16le', 'ucs-2': 'utf16le', 'utf-16le': 'utf16le', binary: 'latin1' };
function encodingOf(enc) {
  if (enc === undefined || enc === null) return 'utf8';
  const e = String(enc).toLowerCase();
  return ENCODING[e] || e;
}
class Buffer extends Uint8Array {
  static from(src, enc) {
    if (typeof src === 'string') {
      const e = encodingOf(enc);
      if (e === 'hex' || e === 'base64' || e === 'base64url') return new Buffer(codec.decode(src, e));
      // latin1/binary (and ascii, which node writes the same way): low-byte of each code
      // unit (NOT utf-8). This is the extractor's write path: Buffer.from(latin1Text,
      // 'latin1') must map 1 char -> 1 byte or bytes >= 0x80 corrupt.
      if (e === 'latin1' || e === 'ascii') return new Buffer(Uint8Array.from({ length: src.length }, (_, i) => src.charCodeAt(i) & 0xff));
      // utf16le/ucs2: each UTF-16 code unit, low byte first.
      if (e === 'utf16le') {
        const b = new Buffer(src.length * 2);
        for (let i = 0; i < src.length; i++) { const u = src.charCodeAt(i); b[2 * i] = u & 0xff; b[2 * i + 1] = u >> 8; }
        return b;
      }
      return new Buffer(te.encode(src));
    }
    if (src instanceof ArrayBuffer) return new Buffer(new Uint8Array(src));
    return new Buffer(Uint8Array.from(src));
  }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(v) { return v instanceof Buffer; }
  // node: the bytes `s` takes in `enc` (a Buffer, a view or an ArrayBuffer: its own byteLength).
  static byteLength(s, enc) {
    if (ArrayBuffer.isView(s) || s instanceof ArrayBuffer) return s.byteLength;
    const str = String(s);
    const e = encodingOf(enc);
    if (e === 'latin1' || e === 'ascii') return str.length;
    if (e === 'utf16le') return str.length * 2;
    if (e === 'hex' || e === 'base64' || e === 'base64url') return codec.byteLength(str, e);
    return te.encode(str).length;
  }
  // node: concat(list[, totalLength]) — totalLength TRUNCATES or zero-pads. Ignoring it
  // returned a differently-sized buffer than the caller asked for.
  static concat(list, totalLength) {
    const total = totalLength === undefined ? list.reduce((n, b) => n + b.length, 0) : totalLength;
    const out = new Buffer(total);
    let o = 0;
    for (const b of list) {
      if (o >= total) break;
      const take = Math.min(b.length, total - o);
      out.set(take === b.length ? b : b.subarray(0, take), o);
      o += take;
    }
    return out;
  }
  // node: toString([encoding[, start[, end]]]) decodes bytes start..end of THIS buffer (start below 0
  // is 0, end past the length is the length, end at or before start is ''). Ignoring them decoded the
  // whole buffer: rg-native's record parser read every file name as all of ugrep's output.
  toString(enc, start, end) {
    const len = this.length;
    const s0 = start === undefined ? 0 : Math.max(0, Math.min(len, Math.trunc(Number(start)) || 0));
    const e0 = end === undefined ? len : Math.max(0, Math.min(len, Math.trunc(Number(end)) || 0));
    if (e0 <= s0) return '';
    const v = s0 === 0 && e0 === len ? this : this.subarray(s0, e0);
    const e = encodingOf(enc);
    if (e === 'hex' || e === 'base64' || e === 'base64url') return codec.encode(v, e);
    const CH = 0x8000;
    const chars = (units) => { let s = ''; for (let i = 0; i < units.length; i += CH) s += String.fromCharCode.apply(null, units.subarray(i, Math.min(i + CH, units.length))); return s; };
    if (e === 'latin1') return chars(v);
    // ascii: each byte's low seven bits.
    if (e === 'ascii') return chars(Uint8Array.from(v, (x) => x & 0x7f));
    // utf16le/ucs2: little-endian code units; an odd last byte is dropped.
    if (e === 'utf16le') {
      const u = new Uint16Array(v.length >> 1);
      for (let i = 0; i < u.length; i++) u[i] = v[2 * i] | (v[2 * i + 1] << 8);
      return chars(u);
    }
    return td.decode(v);
  }
  slice(a, b) { return new Buffer(super.slice(a, b)); }
  // node: copy(target[, targetStart[, sourceStart[, sourceEnd]]]) -> the bytes copied. Each index is
  // read as an integer (NaN as 0); a negative one, or a sourceStart past this buffer, is a RangeError
  // ERR_OUT_OF_RANGE; the range is clamped to both buffers; a copy within one buffer acts as if through
  // a temporary (TypedArray set does).
  copy(target, targetStart, sourceStart, sourceEnd) {
    const int = (v) => { const n = +v; return Number.isNaN(n) ? 0 : Math.floor(n); };
    const range = (name, v, ok) => { const e = new RangeError(`The value of "${name}" is out of range. It must be ${ok}. Received ${v}`); e.code = 'ERR_OUT_OF_RANGE'; return e; };
    const ts = targetStart === undefined ? 0 : int(targetStart);
    if (ts < 0) throw range('targetStart', ts, '>= 0');
    const ss = sourceStart === undefined ? 0 : int(sourceStart);
    if (ss < 0 || ss > this.length) throw range('sourceStart', ss, `>= 0 && <= ${this.length}`);
    let se = sourceEnd === undefined ? this.length : int(sourceEnd);
    if (se < 0) throw range('sourceEnd', se, '>= 0');
    if (ts >= target.length || ss >= se) return 0;
    if (se - ss > target.length - ts) se = ss + target.length - ts;
    const n = Math.min(se - ss, this.length - ss);
    if (n <= 0) return 0;
    Uint8Array.prototype.set.call(target, this.subarray(ss, ss + n), ts);
    return n;
  }
  equals(other) { return this.length === other.length && this.every((v, i) => v === other[i]); }

  // SEARCH METHODS MUST BE OVERRIDDEN, NOT INHERITED. Uint8Array.prototype.indexOf
  // coerces its argument to a NUMBER, so a string needle became NaN and the answer was
  // always -1: `Buffer.from('abcabc').indexOf('cab')` returned -1 where node returns 2,
  // and `.includes('cab')` returned false. SILENTLY WRONG, which is worse than absent —
  // an absent method throws and gets noticed. Found 2026-08-25 by running the suite on
  // the engine.
  //
  // This class is the DEPS-FREE fallback (clode-native / `clode build`); quaude ships
  // feross/buffer, so the two configurations answer differently. See BACKLOG.
  _needle(value, encoding) {
    if (typeof value === 'number') return Uint8Array.of(value & 0xff);
    if (typeof value === 'string') return Buffer.from(value, encoding);
    return value instanceof Uint8Array ? value : Uint8Array.from(value);
  }
  indexOf(value, byteOffset, encoding) {
    if (typeof byteOffset === 'string') { encoding = byteOffset; byteOffset = 0; }
    const n = this._needle(value, encoding);
    let start = byteOffset | 0;
    if (start < 0) start = Math.max(0, this.length + start);
    if (n.length === 0) return Math.min(start, this.length);
    outer: for (let i = start; i + n.length <= this.length; i++) {
      for (let j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }
  lastIndexOf(value, byteOffset, encoding) {
    if (typeof byteOffset === 'string') { encoding = byteOffset; byteOffset = undefined; }
    const n = this._needle(value, encoding);
    if (n.length === 0) return this.length;
    let start = byteOffset === undefined ? this.length - n.length : (byteOffset | 0);
    if (start < 0) start = this.length + start;
    start = Math.min(start, this.length - n.length);
    outer: for (let i = start; i >= 0; i--) {
      for (let j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }
  includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }
  // JSON.stringify(buf) must yield {type:'Buffer',data:[...]}, not an index map.
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
}
module.exports = { Buffer };
