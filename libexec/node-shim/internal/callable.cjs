'use strict';
// CONSTRUCTORS AN ES5 SUBCLASS CAN CALL, as node's are. Node defines EventEmitter, the stream classes, http.Agent,
// net.Socket, StringDecoder and the rest as plain functions, so the pre-class idiom
//     function Sub(opts) { Base.call(this, opts); }  util.inherits(Sub, Base);
// initializes `this` as a Base. This shim writes them as ES classes, which throw "class constructors must be invoked
// with 'new'" there instead: on a real Linux box (2026-11-25) every Remote Control session create failed with exactly
// that, before a byte left the machine. test/node-shim-callable.test.cjs holds every such constructor node exports to
// node's answer.
//
// HOW: callable(C) is C behind a Proxy whose call trap constructs C ON THE CALLER'S OBJECT. A derived class's `this`
// is whatever its base constructor returns, so a root that returns the waiting object makes every constructor in the
// chain -- private fields, closures over `this`, listeners -- initialize that object, not a stand-in. Every class
// wrapped here must therefore descend from Root; one that does not is refused LOUDLY at the call, never initialized
// half-way.
let pending = null;

function Root() {
  if (pending !== null && pending.nt === new.target) {
    const o = pending.obj;
    pending = null;
    return o;
  }
}

const wrapped = new WeakMap();
function callable(C) {
  if (wrapped.has(C)) return wrapped.get(C);
  const P = new Proxy(C, {
    apply(target, self, args) {
      // node: a bare call with no receiver (`Readable()`) is `new Readable()`
      if (self === null || self === undefined || (typeof self !== 'object' && typeof self !== 'function') || self === globalThis) {
        return Reflect.construct(target, args);
      }
      const outer = pending;
      pending = { obj: self, nt: target };
      try {
        Reflect.construct(target, args);
        if (pending !== null) throw new TypeError(`node-shim: ${target.name}.call(this) cannot initialize an existing object (its class does not descend from internal/callable.cjs Root)`);
      } finally { pending = outer; }
      return undefined;
    },
  });
  Object.defineProperty(C.prototype, 'constructor', { value: P, writable: true, configurable: true, enumerable: false });
  wrapped.set(C, P);
  wrapped.set(P, P);
  return P;
}

module.exports = { Root, callable };
