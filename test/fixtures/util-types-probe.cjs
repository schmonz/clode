'use strict';
// util/types under whichever runtime runs this: every predicate host node's util.types has, over one value matrix.
// Prints { names, rows: { label: [bool per name] } }. Run by test/node-shim-util-types.test.cjs under host node and
// under tjs + node-shim; the two printouts must agree but for the divergences that test names.
const T = require('util/types');
const NAMES = process.argv[2] ? JSON.parse(process.argv[2]) : Object.keys(T);
function* gen() { yield 1; }
async function* agen() { yield 1; }
const mapIt = new Map([[1, 2]]).entries();
const setIt = new Set([1]).values();
const args = (function () { return arguments; })(1, 2);
const VALUES = {
  undefined: undefined, null: null, number: 1, string: 's', boolean: true, bigint: 1n, symbol: Symbol('x'),
  plainObject: {}, nullProto: Object.create(null), array: [1], fn: function f() {}, arrow: () => 1,
  asyncFn: async function a() {}, genFn: gen, asyncGenFn: agen, genObj: gen(), asyncGenObj: agen(),
  arguments: args, date: new Date(0), invalidDate: new Date(NaN), regexp: /x/g, regexpProto: RegExp.prototype,
  regexpLike: { source: 'x', flags: 'g', global: true, exec() {} },
  error: new Error('e'), typeError: new TypeError('t'), errorSubclass: new (class E extends Error {})('s'),
  errorLike: { name: 'Error', message: 'm', stack: '' },
  map: new Map(), set: new Set(), weakMap: new WeakMap(), weakSet: new WeakSet(), mapIter: mapIt, setIter: setIt,
  arrayIter: [1].values(), promise: Promise.resolve(1), thenable: { then() {} },
  arrayBuffer: new ArrayBuffer(4), sharedArrayBuffer: typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : null,
  dataView: new DataView(new ArrayBuffer(4)), u8: new Uint8Array(2), u8c: new Uint8ClampedArray(2), u16: new Uint16Array(2),
  u32: new Uint32Array(2), i8: new Int8Array(2), i16: new Int16Array(2), i32: new Int32Array(2),
  f16: typeof Float16Array === 'function' ? new Float16Array(2) : null, f32: new Float32Array(2), f64: new Float64Array(2),
  bi64: new BigInt64Array(2), bu64: new BigUint64Array(2), buffer: Buffer.from('ab'),
  numberObject: new Number(1), stringObject: new String('s'), booleanObject: new Boolean(false),
  bigintObject: Object(1n), symbolObject: Object(Symbol('y')),
  spoofedTag: { [Symbol.toStringTag]: 'Map' }, mapProtoSwap: Object.setPrototypeOf({}, Map.prototype),
  dateProtoSwap: Object.setPrototypeOf({}, Date.prototype), u8ProtoSwap: Object.setPrototypeOf({}, Uint8Array.prototype),
};
const rows = {};
for (const [label, v] of Object.entries(VALUES)) rows[label] = NAMES.map((n) => (typeof T[n] === 'function' ? T[n](v) : `missing`));
process.stdout.write(JSON.stringify({ names: NAMES, rows }));
