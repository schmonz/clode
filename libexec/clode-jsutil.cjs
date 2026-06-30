'use strict';
// Python json.dumps parity helpers. Pure stdlib (runs before ensure_deps).

// Escape every char Python's ensure_ascii=True would escape as \uXXXX. Python
// escapes everything outside printable ASCII (0x20-0x7e); JSON.stringify already
// emits identical escapes for 0x00-0x1f (\n, \t, ... and \u00xx) plus " and \, so
// the only range we must add here is 0x7f-0xffff (note: 0x7f/DEL IS escaped by
// Python but left raw by JSON.stringify). JS strings are UTF-16, so astral chars
// are already surrogate pairs -> two \u escapes, exactly like CPython.
function escapeNonAscii(s) {
  return s.replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Deep-clone with object keys sorted (Python sort_keys=True). Arrays keep order.
// Object.create(null) so an own "__proto__" key becomes an ordinary data property
// (a plain `{}` would invoke the prototype setter, silently dropping it and
// breaking byte-parity); JSON.stringify serializes null-proto objects normally.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = Object.create(null);
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}

// Reproduce Python json.dumps(obj, indent=2[, sort_keys]). JSON.stringify with
// indent=2 already uses ',\n' + ': ' separators and '{}'/'[]' for empties, which
// match Python's indented form; only ensure_ascii and key sorting differ.
// Parity holds for str/int/bool/null/array/object; floats (Python 1.0 vs JS 1)
// and NaN/Infinity (Python keeps them, JSON.stringify emits null) are NOT
// Python-identical — clode's callers emit none of those.
function pyJson(obj, { sortKeys = false } = {}) {
  const v = sortKeys ? sortDeep(obj) : obj;
  return escapeNonAscii(JSON.stringify(v, null, 2));
}

module.exports = { pyJson };
