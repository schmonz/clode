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
module.exports = { format, promisify, inherits, inspect: inspect1, types: { isDate: (v) => v instanceof Date } };
