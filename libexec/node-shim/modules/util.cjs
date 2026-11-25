'use strict';
// node:util — M1 surface, characterization-locked.
// %j as node does it (lib/internal/util/inspect.js tryStringify): ONLY the engine's own
// circular-structure TypeError becomes '[Circular]'; every other throw propagates. Swallowing them
// all invented '[Circular]' for a throwing getter (node-shim's ERR_CLODE_ENGINE_FLOOR) or a BigInt.
// The circular message is the ENGINE's, learned once, so no engine's wording is spelled here.
let CIRCULAR_MESSAGE;
const firstLine = (e) => String((e && e.message) || '').split('\n')[0];
function tryStringify(a) {
  try { return JSON.stringify(a); } catch (err) {
    if (CIRCULAR_MESSAGE === undefined) {
      try { const c = {}; c.c = c; JSON.stringify(c); } catch (ce) { CIRCULAR_MESSAGE = firstLine(ce); }
    }
    if (err instanceof TypeError && firstLine(err) === CIRCULAR_MESSAGE) return '[Circular]';
    throw err;
  }
}
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
    if (m === '%j') return tryStringify(a);
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
// node's strEscape (lib/internal/util/inspect.js): single quotes unless the string holds one (then double, then a
// backtick), and every C0 control and DEL escaped the way node's meta table spells it ('\b' '\t' '\n' '\f' '\r' by
// name, the rest '\x0B'). Control escaping found by process.execve's args validation, whose message inspects
// 'a\0b' (node: "Received 'a\\x00b'"; this printed a raw NUL), 2026-11-22.
const _META = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
const _quote = (v) => {
  const s = String(v);
  let q = "'";
  if (s.includes("'")) { if (!s.includes('"')) q = '"'; else if (!s.includes('`') && !s.includes('${')) q = '`'; }
  return q + s.replace(new RegExp(`[\\\\\\x00-\\x1f\\x7f${q}]`, 'g'), (c) => {
    if (c === '\\') return '\\\\';
    if (c === q) return '\\' + q;
    return _META[c] || '\\x' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }) + q;
};

// util.inspect(value, options): the public entry. It used to BE inspect1, so an options object landed in `seen`
// and every call with options threw "not a function" (the 2.1.283 carve's device-code response inspects itself with
// {depth, colors, compact:false, sorted:true}; found when the differential learned to read destructured requires,
// 2026-11-19). A top-level string is quoted, as node's is; format's %s and bare args keep calling inspect1.
// Of the options, compact:false and sorted are honoured; colors are not (no colour, ever), nor depth.
function inspect(v, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return typeof v === 'string' ? _quote(v) : inspect1(v, undefined, 0, o);
}

function inspect1(v, seen, depth, opts) {
  seen = seen || new Set();
  depth = depth || 0;
  opts = opts || {};
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
    const rec = (x) => inspect1(x, seen, depth + 1, opts);
    // compact:false (node): every entry on its own line, indented two spaces per level
    const pad = '  '.repeat(depth);
    const wrap = (open, items, close) => (!items.length ? open.trimEnd() + close
      : opts.compact === false ? open + '\n' + items.map((i) => pad + '  ' + i).join(',\n') + '\n' + pad + close
        : open + ' ' + items.join(', ') + ' ' + close);
    if (Array.isArray(v)) return wrap('[', v.map(rec), ']');
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
    const keys = Reflect.ownKeys(v);
    if (opts.sorted === true) keys.sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    for (const k of keys) {
      let val;
      try { val = v[k]; } catch (e) { val = '[getter threw]'; }
      const key = typeof k === 'symbol' ? '[' + k.toString() + ']'
        : (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : _quote(k));
      parts.push(key + ': ' + rec(val));
    }
    return prefix + wrap('{', parts, '}');
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

// util.getSystemErrorName(err): the NAME of a system error number (-2 -> 'ENOENT').
//
// Upstream imports it — `import{getSystemErrorName as vn,promisify as gt}from"util"`
// (2.1.251) — in the dirSync anchor module, whose ONLY call site reads darwin's
// __error() through bun:ffi and renders `code: vn(-b)` on a failed *at() syscall.
// That call site is currently behind libexec/bun-shim.cjs's bun:ffi wall (dlopen
// throws, upstream catches it and sets the anchor to null), so nothing reaches this
// today; it is implemented anyway because, unlike Bun.ant, nothing FEATURE-DETECTS it
// — providing it advertises no capability — and the alternative was the interop
// facade's lazy thrower, which fails at the exact moment an errno is being named.
//
// NO TABLE, AND DELIBERATELY NOT os.constants.errno. node's answer is LIBUV's error
// map, not the platform's errno list, and the two disagree badly: measured on
// darwin/arm64 against node 24.19.0, 18 of the 79 names in os.constants.errno get a
// DIFFERENT answer from util.getSystemErrorName. EWOULDBLOCK (35) must answer "EAGAIN"
// (libuv's UV_ERRNO_MAP has no EWOULDBLOCK); EOPNOTSUPP, ECHILD, EDEADLK, EDOM, EDQUOT,
// EIDRM, EINPROGRESS, ESTALE, ETIME and eight more must answer "Unknown system error
// -N" because libuv maps neither. Inverting os.constants.errno is therefore the same
// class of confident, silent wrongness as the hand-written fs O_* table that was wrong
// on 8 of 11 values on every BSD leg (see internal/engine-constants.cjs).
//
// So ask the engine's own libuv. txiki's tjs.Error constructor (src/error.c) sets
// `.code` from uv_err_name(err) — the same UV_ERRNO_MAP node reads, compiled against
// the same headers the engine was built with, including uv_err_name's own
// "Unknown system error %d" fallback, which is byte-identical to node's. Nothing here
// is transcribed, so nothing here can rot on a leg nobody is standing on.
// Differential-locked by test/node-shim-system-error-name.test.cjs.
function getSystemErrorName(err) {
  // node: validateNumber -> ERR_INVALID_ARG_TYPE (TypeError), then
  // `err >= 0 || !NumberIsSafeInteger(err)` -> ERR_OUT_OF_RANGE (RangeError).
  // Verified against node 24.19.0 for 0, 2, 1.5, -1.5, NaN, '-2', null, undefined.
  if (typeof err !== 'number') {
    const e = new TypeError('The "err" argument must be of type number. Received '
      + (err === null ? 'null' : typeof err));
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  if (err >= 0 || !Number.isSafeInteger(err)) {
    const e = new RangeError('The value of "err" is out of range. It must be a negative '
      + `integer. Received ${err}`);
    e.code = 'ERR_OUT_OF_RANGE';
    throw e;
  }
  const UvError = globalThis.tjs && globalThis.tjs.Error;
  if (typeof UvError !== 'function') {
    // Same policy as internal/engine-constants.cjs: a fallback table is a guess with a
    // longer shelf life. Fail with the remedy instead.
    throw new Error('node-shim: util.getSystemErrorName needs the engine\'s own '
      + 'uv_err_name (exposed as tjs.Error), and this engine does not provide it. '
      + 'Rebuild the engine from current sources; refusing to guess an errno table.');
  }
  return new UvError(err).code;
}

// util.types — node's whole predicate set, each a BRAND check where the language has one (a builtin method or
// getter that throws, or answers undefined, on anything without the internal slot), never `instanceof` or a
// toStringTag, which a prototype swap or a Symbol.toStringTag spoofs. Until 2.1.332 this held only isDate and isProxy;
// 2.1.332's `import*as A from"util/types"` then `A.isRegExp(o)` threw QuickJS's nameless "not a function" and three
// of four builtin plugins' hooks modules failed to load in every quaude turn. test/node-shim-util-types.test.cjs
// holds every predicate to host node's answer over one value matrix; test/shim-surface.test.cjs now measures this
// subpath's members (it measured only module files before).
//
// Where QuickJS offers no brand check the predicate says what it does instead:
//   isProxy        false: no way to detect a Proxy from JS (node reads a V8 internal). Every caller we can see uses it
//                  to avoid touching a value during inspection; "not a proxy" takes the ordinary path.
//   isPromise      a native promise or one whose prototype chain holds Promise.prototype. No slot check exists that
//                  does not attach a reaction (which could raise an unhandled rejection), so Object.create(
//                  Promise.prototype) answers true here and false under node.
//   isMapIterator / isSetIterator / isGeneratorObject: the prototype chain holds the intrinsic iterator / generator
//                  prototype. A swapped prototype answers otherwise than node's slot check.
//   isModuleNamespaceObject: null prototype, a non-writable Symbol.toStringTag of 'Module', not extensible.
//   isExternal     false: an External is a native addon's wrapper; quaude loads no addons.
//   isKeyObject / isCryptoKey: false. The shim's crypto makes no KeyObject or CryptoKey a caller could hold.
const _brand = (fn) => (v) => { try { fn(v); return true; } catch { return false; } };
const _getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
const _taTag = _getter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
const _abLen = _getter(ArrayBuffer.prototype, 'byteLength');
const _sabLen = typeof SharedArrayBuffer === 'function' ? _getter(SharedArrayBuffer.prototype, 'byteLength') : null;
const _reGlobal = _getter(RegExp.prototype, 'global');
const _mapSize = _getter(Map.prototype, 'size');
const _setSize = _getter(Set.prototype, 'size');
const _protoOf = (v) => (v !== null && (typeof v === 'object' || typeof v === 'function') ? Object.getPrototypeOf(v) : null);
const _chainHas = (v, proto) => { for (let p = _protoOf(v); p; p = Object.getPrototypeOf(p)) if (p === proto) return true; return false; };
const _MAP_ITER = Object.getPrototypeOf(new Map().entries());
const _SET_ITER = Object.getPrototypeOf(new Set().values());
const _GEN = Object.getPrototypeOf(Object.getPrototypeOf((function* () {})()));
const _ASYNC_GEN = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})()));
const _fnTag = (v) => (typeof v === 'function' ? Object.prototype.toString.call(v) : '');
const _ta = (name) => (v) => _taTag.call(v) === name;
const isNumberObject = (v) => typeof v === 'object' && v !== null && _brand((x) => Number.prototype.valueOf.call(x))(v);
const isStringObject = (v) => typeof v === 'object' && v !== null && _brand((x) => String.prototype.valueOf.call(x))(v);
const isBooleanObject = (v) => typeof v === 'object' && v !== null && _brand((x) => Boolean.prototype.valueOf.call(x))(v);
const isBigIntObject = (v) => typeof v === 'object' && v !== null && _brand((x) => BigInt.prototype.valueOf.call(x))(v);
const isSymbolObject = (v) => typeof v === 'object' && v !== null && _brand((x) => Symbol.prototype.valueOf.call(x))(v);
const isArrayBuffer = _brand((v) => _abLen.call(v));
const isSharedArrayBuffer = (v) => _sabLen !== null && _brand((x) => _sabLen.call(x))(v);
const types = {
  isArgumentsObject: (v) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Arguments]'
    && !(Symbol.toStringTag in Object(v)),
  isArrayBuffer,
  isAsyncFunction: (v) => /^\[object Async(?:Generator)?Function\]$/.test(_fnTag(v)),
  isBigIntObject,
  isBooleanObject,
  isDate: (v) => typeof v === 'object' && v !== null && _brand((x) => Date.prototype.getTime.call(x))(v),
  isExternal: () => false,
  isGeneratorFunction: (v) => /^\[object (?:Async)?GeneratorFunction\]$/.test(_fnTag(v)),
  isGeneratorObject: (v) => typeof v === 'object' && (_chainHas(v, _GEN) || _chainHas(v, _ASYNC_GEN)),
  isMap: _brand((v) => _mapSize.call(v)),
  isMapIterator: (v) => typeof v === 'object' && _chainHas(v, _MAP_ITER),
  isModuleNamespaceObject: (v) => {
    if (v === null || typeof v !== 'object' || Object.getPrototypeOf(v) !== null || Object.isExtensible(v)) return false;
    const d = Object.getOwnPropertyDescriptor(v, Symbol.toStringTag);
    return !!d && d.value === 'Module' && d.writable === false;
  },
  isNativeError: (v) => Error.isError(v),
  isNumberObject,
  isPromise: (v) => v !== null && typeof v === 'object' && _chainHas(v, Promise.prototype),
  isProxy: () => false,
  isRegExp: (v) => v !== null && typeof v === 'object' && _brand((x) => { if (typeof _reGlobal.call(x) !== 'boolean') throw 0; })(v),
  isSet: _brand((v) => _setSize.call(v)),
  isSetIterator: (v) => typeof v === 'object' && _chainHas(v, _SET_ITER),
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isWeakMap: _brand((v) => WeakMap.prototype.has.call(v, {})),
  isWeakSet: _brand((v) => WeakSet.prototype.has.call(v, {})),
  isAnyArrayBuffer: (v) => isArrayBuffer(v) || isSharedArrayBuffer(v),
  isBoxedPrimitive: (v) => isNumberObject(v) || isStringObject(v) || isBooleanObject(v) || isBigIntObject(v) || isSymbolObject(v),
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isDataView: _brand((v) => _getter(DataView.prototype, 'byteLength').call(v)),
  isTypedArray: (v) => _taTag.call(v) !== undefined,
  isUint8Array: _ta('Uint8Array'), isUint8ClampedArray: _ta('Uint8ClampedArray'), isUint16Array: _ta('Uint16Array'),
  isUint32Array: _ta('Uint32Array'), isInt8Array: _ta('Int8Array'), isInt16Array: _ta('Int16Array'),
  isInt32Array: _ta('Int32Array'), isFloat16Array: _ta('Float16Array'), isFloat32Array: _ta('Float32Array'),
  isFloat64Array: _ta('Float64Array'), isBigInt64Array: _ta('BigInt64Array'), isBigUint64Array: _ta('BigUint64Array'),
  isKeyObject: () => false,
  isCryptoKey: () => false,
};

module.exports = {
  format, formatWithOptions, promisify, callbackify, inherits, inspect, isDeepStrictEqual,
  debuglog, debug: debuglog, deprecate, stripVTControlCharacters, getSystemErrorName,
  // util.types. The code-split bundle (2.1.243+) imports `isProxy` from `util/types`.
  // quickjs exposes no way to detect a Proxy from JS — node's own isProxy reads a V8
  // internal — so this reports false. That is the SAFE direction: every caller we can
  // see uses it to decide whether to avoid touching a value during inspection, and
  // "not a proxy" makes them take the ordinary path. A throwing stub would break
  // rendering for merely asking. If a caller ever needs a true answer this becomes a
  // real wall, and it should fail loudly then rather than lie more elaborately.
  types,
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
};
