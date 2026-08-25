'use strict';
// node:util — M1 surface, characterization-locked.
function format(fmt, ...args) {
  if (typeof fmt !== 'string') return [fmt, ...args].map(inspect1).join(' ');
  let i = 0;
  let out = fmt.replace(/%[sdjifoOc%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    if (m === '%s') return typeof a === 'string' ? a : inspect1(a, undefined, 1);
    if (m === '%d') return String(Number(a));
    if (m === '%i') return String(parseInt(a, 10));
    if (m === '%f') return String(parseFloat(a));
    if (m === '%o' || m === '%O') return inspect1(a, undefined, 1);
    if (m === '%c') return '';                       // node consumes CSS and emits nothing
    if (m === '%j') { try { return JSON.stringify(a); } catch { return '[Circular]'; } }
    return inspect1(a, undefined, 1);
  });
  for (; i < args.length; i++) out += ' ' + inspect1(args[i]);
  return out;
}
// util.inspect WAS JSON.stringify, which is wrong in three ways that matter and one that
// is fatal. Measured 2026-08-25 on the engine:
//   inspect(new Error('boom'))  -> '{}'          (the message and stack, gone)
//   inspect(/re/)               -> '{}'
//   inspect(new Map([['a',1]])) -> '{}'
//   inspect(circularObject)     -> THREW         <-- node NEVER throws here
//   inspect(1n)                 -> THREW
// Since this backs console.log's object formatting, an error logged during a failure
// printed as `{}` — the moment you most need the message is the moment it vanished.
//
// NOT a full node inspect: no colours, no depth/breadth options, no getter evaluation, no
// %c handling, and the exact spacing of nested output is not byte-identical to node's.
// What it DOES guarantee: it never throws, it never returns '{}' for a value that has
// content, and Errors/Map/Set/Date/RegExp/BigInt/Symbol/functions/circular refs all print
// something a human can act on. Widen it when a caller needs more, not speculatively.
const _quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";

function inspect1(v, seen, depth) {
  seen = seen || new Set();
  depth = depth || 0;
  const t = typeof v;
  if (v === null) return 'null';
  if (t === 'undefined') return 'undefined';
  if (t === 'string') return depth === 0 ? v : _quote(v);
  if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (t === 'bigint') return String(v) + 'n';
  if (t === 'boolean') return String(v);
  if (t === 'symbol') return v.toString();
  if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';

  if (v instanceof Error) {
    // QuickJS's Error#stack is the call-frame trace ONLY — unlike V8 it does NOT prepend
    // "Name: message" (the same divergence libexec/node-shim/loader.cjs handles when it
    // prints an uncaught error). Returning the raw stack therefore LOSES THE MESSAGE,
    // which is the one thing a logged error must carry.
    const head = (v.name || 'Error') + (v.message ? ': ' + v.message : '');
    const stack = typeof v.stack === 'string' ? v.stack : '';
    if (!stack) return head;
    return stack.startsWith(v.name || 'Error') ? stack : head + '\n' + stack;
  }
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object RegExp]') return String(v);
  if (tag === '[object Date]') {
    const ms = v.getTime();
    return Number.isNaN(ms) ? 'Invalid Date' : v.toISOString();
  }

  if (seen.has(v)) return '[Circular *1]';
  if (depth > 4) return Array.isArray(v) ? '[Array]' : '[Object]';
  seen.add(v);
  try {
    const rec = (x) => inspect1(x, seen, depth + 1);
    if (Array.isArray(v)) return '[ ' + v.map(rec).join(', ') + ' ]';
    if (tag === '[object Map]') {
      return 'Map(' + v.size + ') {' + (v.size ? ' ' + [...v].map(([k, val]) => rec(k) + ' => ' + rec(val)).join(', ') + ' ' : '') + '}';
    }
    if (tag === '[object Set]') {
      return 'Set(' + v.size + ') {' + (v.size ? ' ' + [...v].map(rec).join(', ') + ' ' : '') + '}';
    }
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const name = v.constructor && v.constructor.name ? v.constructor.name : 'TypedArray';
      return name + '(' + v.length + ') [ ' + Array.from(v).join(', ') + ' ]';
    }
    const ctor = v.constructor && v.constructor.name;
    const prefix = ctor && ctor !== 'Object' ? ctor + ' ' : '';
    const parts = [];
    for (const k of Reflect.ownKeys(v)) {
      let val;
      try { val = v[k]; } catch (e) { val = '[getter threw]'; }
      const key = typeof k === 'symbol' ? '[' + k.toString() + ']'
        : (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : _quote(k));
      parts.push(key + ': ' + rec(val));
    }
    return prefix + '{' + (parts.length ? ' ' + parts.join(', ') + ' ' : '') + '}';
  } catch (e) {
    return '[uninspectable: ' + ((e && e.message) || e) + ']';
  } finally {
    seen.delete(v);
  }
}
function promisify(fn) {
  return (...args) => new Promise((res, rej) =>
    fn(...args, (err, val) => (err ? rej(err) : res(val))));
}
function inherits(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  ctor.super_ = superCtor;
}
// DEEP EQUALITY MUST SEE INTERNAL SLOTS, or it silently approves anything it cannot read.
//
// This walked Reflect.ownKeys only. Map, Set, Date, RegExp, boxed primitives and typed
// arrays keep their contents in INTERNAL SLOTS, not own properties, so both sides looked
// like {} and compared EQUAL. Measured on the engine before this fix:
//
//     assert.deepStrictEqual(new Map([['a',1]]), new Map([['a',2]]))   PASSED
//     assert.deepStrictEqual(new Set([1]), new Set([2]))               PASSED
//     assert.deepStrictEqual(new Date(2000), new Date(2020))           PASSED
//     assert.deepStrictEqual(/a/, /b/)                                 PASSED
//
// assert.deepStrictEqual delegates straight here (assert.cjs), so this was not a reporting
// quirk — it is an ASSERTION THAT APPROVED UNEQUAL VALUES. Any test comparing those types
// went green while measuring nothing, which is the worst failure this project has: a check
// that still runs and no longer checks. It stayed invisible because
// test/node-shim-util.test.cjs pins plain objects, NaN and +/-0 — all of which were right.
//
// Tag-first, then contents. Prototype identity is compared too: node treats
// Object.create(null) and {} as unequal even with identical keys.
const _tagOf = (v) => Object.prototype.toString.call(v);

function isDeepStrictEqual(a, b) {
  if (a === b) return a !== 0 || 1 / a === 1 / b;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);

  const tag = _tagOf(a);
  if (tag !== _tagOf(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  switch (tag) {
    case '[object Date]':
      return Object.is(a.getTime(), b.getTime());
    case '[object RegExp]':
      return a.source === b.source && a.flags === b.flags;
    case '[object Number]': case '[object String]':
    case '[object Boolean]': case '[object Symbol]': case '[object BigInt]':
      return Object.is(a.valueOf(), b.valueOf());   // boxed primitives
    case '[object Map]': {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        // Non-primitive keys need a structural search: node matches them by deep equality,
        // not by reference, so a plain `b.get(k)` would wrongly report a miss.
        if (k !== null && (typeof k === 'object' || typeof k === 'function')) {
          let hit = false;
          for (const [k2, v2] of b) { if (isDeepStrictEqual(k, k2) && isDeepStrictEqual(v, v2)) { hit = true; break; } }
          if (!hit) return false;
        } else {
          if (!b.has(k) || !isDeepStrictEqual(v, b.get(k))) return false;
        }
      }
      return true;
    }
    case '[object Set]': {
      if (a.size !== b.size) return false;
      for (const v of a) {
        if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
          let hit = false;
          for (const v2 of b) { if (isDeepStrictEqual(v, v2)) { hit = true; break; } }
          if (!hit) return false;
        } else if (!b.has(v)) return false;
      }
      return true;
    }
    default: break;
  }

  // Typed arrays and DataView: compare bytes, not indices-as-own-keys.
  if (ArrayBuffer.isView(a)) {
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  if (tag === '[object ArrayBuffer]') {
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a), ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }

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
  // util.types. The code-split bundle (2.1.243+) imports `isProxy` from `util/types`.
  // quickjs exposes no way to detect a Proxy from JS — node's own isProxy reads a V8
  // internal — so this reports false. That is the SAFE direction: every caller we can
  // see uses it to decide whether to avoid touching a value during inspection, and
  // "not a proxy" makes them take the ordinary path. A throwing stub would break
  // rendering for merely asking. If a caller ever needs a true answer this becomes a
  // real wall, and it should fail loudly then rather than lie more elaborately.
  types: { isDate: (v) => v instanceof Date, isProxy: () => false },
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
};
