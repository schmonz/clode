'use strict';
// Buffer-lite: the toolchain's Buffer surface as a Uint8Array subclass.
// M2 replaces this with the vendored feross `buffer` for the bundle's needs.
const te = new TextEncoder();
const td = new TextDecoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64decode(s) {
  s = s.replace(/=+$/, '');
  const out = [];
  let bits = 0, acc = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}
function b64encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b ?? 0) >> 4]
      + (b === undefined ? '=' : B64[((b & 15) << 2) | (c ?? 0) >> 6])
      + (c === undefined ? '=' : B64[c & 63]);
  }
  return out;
}

class Buffer extends Uint8Array {
  static from(src, enc) {
    if (typeof src === 'string') {
      if (enc === 'hex') return new Buffer(Uint8Array.from(src.match(/../g) ?? [], (h) => parseInt(h, 16)));
      if (enc === 'base64') return new Buffer(b64decode(src));
      // latin1/binary: low-byte of each code point (NOT utf-8). This is the
      // extractor's write path: Buffer.from(latin1Text, 'latin1') must map
      // 1 char -> 1 byte or bytes >= 0x80 corrupt.
      if (enc === 'latin1' || enc === 'binary') return new Buffer(Uint8Array.from({ length: src.length }, (_, i) => src.charCodeAt(i) & 0xff));
      return new Buffer(te.encode(src));
    }
    if (src instanceof ArrayBuffer) return new Buffer(new Uint8Array(src));
    return new Buffer(Uint8Array.from(src));
  }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(v) { return v instanceof Buffer; }
  static byteLength(s) { return te.encode(String(s)).length; }
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
  toString(enc) {
    if (enc === 'hex') return [...this].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (enc === 'base64') return b64encode(this);
    if (enc === 'latin1' || enc === 'binary') {
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < this.length; i += CH) s += String.fromCharCode.apply(null, this.subarray(i, Math.min(i + CH, this.length)));
      return s;
    }
    return td.decode(this);
  }
  slice(a, b) { return new Buffer(super.slice(a, b)); }
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
