'use strict';
// node:querystring — faithful. The bundle requires it (3×) using parse/stringify.
// Semantics match Node: default sep '&', eq '='; repeated keys collect into an
// array; escape/unescape use percent-encoding (querystring.escape is like
// encodeURIComponent but also encodes a few extra chars the same way Node does).
// Values/keys are decoded with unescape (which replaces '+' with space).

function escape(str) {
  // Node's querystring.escape ~ encodeURIComponent, but encodes per RFC3986 and
  // additionally leaves the RFC3986 unreserved set unescaped. encodeURIComponent
  // already matches Node's escape for all ASCII except it does NOT encode
  // !'()*  — Node's querystring.escape DOES leave those unescaped too, so
  // encodeURIComponent is the correct primitive here.
  return encodeURIComponent(str);
}

function unescape(str) {
  try { return decodeURIComponent(str.replace(/\+/g, ' ')); }
  catch { return str; } // Node's unescape is lenient on malformed sequences
}

function stringify(obj, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  const enc = (options && options.encodeURIComponent) || escape;
  if (obj === null || typeof obj !== 'object') return '';
  const parts = [];
  for (const k of Object.keys(obj)) {
    const ek = enc(k);
    const v = obj[k];
    if (Array.isArray(v)) {
      for (const item of v) parts.push(ek + eq + enc(stringifyPrimitive(item)));
    } else {
      parts.push(ek + eq + enc(stringifyPrimitive(v)));
    }
  }
  return parts.join(sep);
}

function stringifyPrimitive(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function parse(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  const dec = (options && options.decodeURIComponent) || unescape;
  const maxKeys = options && typeof options.maxKeys === 'number' ? options.maxKeys : 1000;
  const obj = Object.create(null);
  if (typeof qs !== 'string' || qs.length === 0) return obj;
  const pairs = qs.split(sep);
  const limit = maxKeys > 0 ? Math.min(pairs.length, maxKeys) : pairs.length;
  for (let i = 0; i < limit; i++) {
    const pair = pairs[i];
    if (pair === '') continue;
    const idx = pair.indexOf(eq);
    let key, val;
    if (idx === -1) { key = dec(pair); val = ''; }
    else { key = dec(pair.slice(0, idx)); val = dec(pair.slice(idx + eq.length)); }
    if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = val;
    else if (Array.isArray(obj[key])) obj[key].push(val);
    else obj[key] = [obj[key], val];
  }
  return obj;
}

const qs = {
  parse, decode: parse,
  stringify, encode: stringify,
  escape, unescape,
};
qs.default = qs;
module.exports = qs;
