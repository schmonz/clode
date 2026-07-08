'use strict';
// node:util — M1 surface, characterization-locked.
function format(fmt, ...args) {
  if (typeof fmt !== 'string') return [fmt, ...args].map(inspect1).join(' ');
  let i = 0;
  let out = fmt.replace(/%[sdj%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    if (m === '%s') return String(a);
    if (m === '%d') return String(Number(a));
    return JSON.stringify(a);
  });
  for (; i < args.length; i++) out += ' ' + inspect1(args[i]);
  return out;
}
function inspect1(v) { return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v); }
function promisify(fn) {
  return (...args) => new Promise((res, rej) =>
    fn(...args, (err, val) => (err ? rej(err) : res(val))));
}
function inherits(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  ctor.super_ = superCtor;
}
function isDeepStrictEqual(a, b) {
  if (a === b) return a !== 0 || 1 / a === 1 / b;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Reflect.ownKeys(a), kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k)) return false; if (!isDeepStrictEqual(a[k], b[k])) return false; }
  return true;
}
// util.debuglog (Task 4 wall): the bundled `execa` calls
// `util.debuglog('execa').enabled` at init. Real semantics: a section is
// enabled iff it matches one of the comma/space-separated tokens in NODE_DEBUG
// (a trailing '*' is a prefix wildcard, matching host node). The returned
// function logs to stderr with a `[SECTION pid]` prefix ONLY when enabled, and
// carries a boolean `.enabled`. Characterized by test/node-shim-core.test.cjs
// (util.debuglog row).
function sectionEnabled(section) {
  const spec = (globalThis.process && process.env && process.env.NODE_DEBUG) || '';
  if (!spec) return false;
  for (const raw of spec.split(/[\s,]+/)) {
    if (!raw) continue;
    if (raw === '*') return true;
    if (raw.endsWith('*')) { if (section.startsWith(raw.slice(0, -1))) return true; }
    else if (raw.toLowerCase() === section.toLowerCase()) return true;
  }
  return false;
}
function debuglog(section, cb) {
  const enabled = sectionEnabled(section);
  const pid = (globalThis.process && process.pid) || 0;
  const fn = enabled
    ? (...args) => { process.stderr.write(`${section.toUpperCase()} ${pid}: ${format(...args)}\n`); }
    : () => {};
  fn.enabled = enabled;
  // Node passes the created logger to an optional callback (used to swap in a
  // faster logger once the section is known-enabled); honour the shape.
  if (typeof cb === 'function' && enabled) cb(fn);
  return fn;
}

// util.deprecate (Task 4 wall): the bundled `debug` package wraps a method with
// util.deprecate(fn, msg). Returns a function that delegates to fn and, on its
// FIRST call, emits the deprecation warning once (to stderr), honoring
// process.noDeprecation. Characterized by test/node-shim-core.test.cjs
// (util.deprecate row). The return value of fn passes through unchanged.
function deprecate(fn, msg, code) {
  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      warned = true;
      const noDep = globalThis.process && process.noDeprecation === true;
      if (!noDep) {
        try {
          if (globalThis.process && typeof process.emitWarning === 'function') {
            process.emitWarning(msg, 'DeprecationWarning', code);
          } else if (globalThis.process && process.stderr) {
            process.stderr.write(`DeprecationWarning: ${msg}\n`);
          }
        } catch { /* warning delivery must never break the wrapped call */ }
      }
    }
    return fn.apply(this, args);
  }
  return deprecated;
}

// util.formatWithOptions(inspectOptions, format, ...args): like format but with
// a leading inspect-options object. DIVERGENCE (documented): the options
// (colors/depth/etc.) are accepted and ignored — output matches util.format for
// the %s/%d/%j specifiers the bundle uses; a path depending on colored/deep
// inspect output is a future wall.
function formatWithOptions(_inspectOptions, ...args) {
  return format(...args);
}

// util.callbackify(asyncFn): wrap a promise-returning function so it takes a
// trailing node-style callback. Matches Node: resolves → cb(null, value) on a
// later tick; rejects → cb(reason), and a FALSY rejection is wrapped in an Error
// carrying `.reason` (so a truthy err is always delivered).
function callbackify(original) {
  if (typeof original !== 'function') throw new TypeError('The "original" argument must be of type Function');
  function callbackified(...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') throw new TypeError('The last argument must be of type Function');
    const later = (globalThis.process && typeof process.nextTick === 'function')
      ? process.nextTick.bind(process) : (fn, ...a) => queueMicrotask(() => fn(...a));
    const self = this;
    Promise.resolve(original.apply(self, args)).then(
      (ret) => { later(cb.bind(self, null, ret)); },
      (rej) => {
        let err = rej;
        if (!err) { err = new Error('Promise was rejected with a falsy value'); err.reason = rej; err.code = 'ERR_FALSY_VALUE_REJECTION'; }
        later(cb.bind(self, err));
      },
    );
  }
  Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
  try { Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original)); } catch { /* best effort */ }
  return callbackified;
}

// util.stripVTControlCharacters(str): remove ANSI/VT escape sequences (Node's
// exact regex).
const ANSI_RE = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
function stripVTControlCharacters(str) {
  if (typeof str !== 'string') throw new TypeError('The "str" argument must be of type string');
  return str.replace(ANSI_RE, '');
}

module.exports = {
  format, formatWithOptions, promisify, callbackify, inherits, inspect: inspect1, isDeepStrictEqual,
  debuglog, debug: debuglog, deprecate, stripVTControlCharacters,
  types: { isDate: (v) => v instanceof Date },
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
};
