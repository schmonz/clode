'use strict';
// The engine's synchronous fs errors, as node reports them (grep-native Task 10c fix round, review I-1).
//
// The engine's sync binding (txiki-sync-fs.patch, throw_errno) names only a dozen errnos and calls every
// other one EUNKNOWN, with the message `EUNKNOWN, write ''`. EPIPE is one of those others: a write into a
// pipe whose reader went away (`rg … | head -1`) threw EUNKNOWN, so nothing in the shim could tell a closed
// reader from a real failure, and the rg command printed a stack trace where native rg ends quietly. The
// errno itself was always there (e.errno, positive). Node reports `{ code: 'EPIPE', errno: -32, syscall:
// 'write', message: 'EPIPE: broken pipe, write' }` (and `open '/x'`, `rename 'a' -> 'b'` for path calls),
// so every engine error the shim hands on is reshaped HERE, once, from the engine's own facts: the name
// from the engine's errno table (engine-constants.cjs, the headers the engine was built against; never a
// table of ours) and the text from libuv's (what `new tjs.Error(-errno)` carries: node's own source).
// test/node-shim-fs-errno.test.cjs judges the shapes against host node.
//
// WINDOWS (unmeasured): the engine's errno there is the CRT's, while node reports libuv's own codes
// (UV_EPIPE is -4047, not -32); the name is still right (the engine's table is the CRT's), the number is
// the negated CRT errno, and the text is libuv's only where libuv names that number the same.
let names = null;
function errnoName(n) {
  if (!names) {
    names = new Map();
    for (const [k, v] of Object.entries(require('./engine-constants.cjs').errno || {})) if (!names.has(v)) names.set(v, k);
  }
  return names.get(n);
}
function uvText(n, name) {
  try {
    const t = new tjs.Error(-n);
    if (t.code === name) return String(t.message).replace(/^[A-Z0-9_]+: /, '');
  } catch { /* no tjs.Error here */ }
  return null;
}
// The two-path calls node spells `'src' -> 'dest'`.
const TWO_PATHS = new Set(['rename', 'symlink', 'link', 'copyfile']);
const ENGINE_MESSAGE = /^[A-Z0-9_]+, [a-z_]+ '([\s\S]*)'$/;

// Reshape one engine error in place (and return it). An error the engine did not throw (no positive errno
// and syscall) is returned untouched. `args`: the call's arguments, for the paths node names.
function asNodeError(e, op, args) {
  if (!e || typeof e.errno !== 'number' || e.errno <= 0 || typeof e.syscall !== 'string') return e;
  const n = e.errno;
  const name = errnoName(n) || (e.code !== 'EUNKNOWN' ? e.code : `Unknown system error -${n}`);
  const text = uvText(n, name) || 'unknown error';
  const syscall = e.syscall || op;
  let where = '';
  const a = args || [];
  if (TWO_PATHS.has(syscall) && typeof a[0] === 'string' && typeof a[1] === 'string') {
    where = ` '${a[0]}' -> '${a[1]}'`;
    e.path = a[0]; e.dest = a[1];
  } else {
    const m = ENGINE_MESSAGE.exec(String(e.message || ''));
    if (m && m[1] !== '') { where = ` '${m[1]}'`; e.path = m[1]; }
  }
  e.code = name;
  e.errno = -n;
  e.message = `${name}: ${text}, ${syscall}${where}`;
  return e;
}

// The engine's sync binding with every function's errors reshaped (an object inheriting the binding, so
// anything else on it reads through).
function nodeErrorsFss(raw) {
  if (!raw) return raw;
  const out = Object.create(raw);
  for (const op of Object.getOwnPropertyNames(raw)) {
    const fn = raw[op];
    if (typeof fn !== 'function') continue;
    out[op] = function (...a) {
      try { return fn.apply(raw, a); } catch (e) { throw asNodeError(e, op, a); }
    };
  }
  return out;
}

module.exports = { asNodeError, nodeErrorsFss, errnoName };
