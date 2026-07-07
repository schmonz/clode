'use strict';
// node:async_hooks — AsyncLocalStorage (+ AsyncResource, createHook stubs) over
// a synchronous store stack. The bundle wraps request/session context in an
// AsyncLocalStorage and reads it back with getStore(); run()/getStore() work
// exactly like node's WITHIN a synchronous call scope. Characterized by
// test/node-shim-async-hooks.test.cjs.
//
// DIVERGENCE (loud): context does NOT propagate across async boundaries. Node's
// AsyncLocalStorage rides native async_hooks so getStore() still returns the
// store after an `await`, a timer, or a microtask that started inside run().
// This tjs build exposes no async-context primitive reachable from JS, so here
// getStore() after such a boundary returns whatever the CURRENT synchronous
// scope's store is (typically undefined once run()'s synchronous frame has
// unwound). The -p round-trip's use of ALS is synchronous-scope (store read on
// the same tick it is set / within the same sync callback chain), which this
// satisfies; if a future path depends on cross-await propagation it is a real
// wall — the honest fix is a Promise/timer/microtask-wrapping context bridge,
// deferred until a boot actually needs it. See the characterization test: it
// asserts the synchronous contract (the behavior we DO implement) against host
// node, and documents (todo-style) the propagation node has that we do not.
class AsyncLocalStorage {
  constructor() { this._store = undefined; this._has = false; }
  run(store, cb, ...args) {
    const prevStore = this._store; const prevHas = this._has;
    this._store = store; this._has = true;
    try { return cb(...args); }
    finally { this._store = prevStore; this._has = prevHas; }
  }
  getStore() { return this._has ? this._store : undefined; }
  enterWith(store) { this._store = store; this._has = true; }
  exit(cb, ...args) {
    const prevStore = this._store; const prevHas = this._has;
    this._store = undefined; this._has = false;
    try { return cb(...args); }
    finally { this._store = prevStore; this._has = prevHas; }
  }
  disable() { this._store = undefined; this._has = false; }
}
// Static helper node exposes; both forms call the callback with the given store.
AsyncLocalStorage.bind = (fn) => fn;
AsyncLocalStorage.snapshot = () => (fn, ...a) => fn(...a);

class AsyncResource {
  constructor(type, opts) { this.type = type; this._opts = opts; }
  runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
  bind(fn) { return fn; }
  emitBefore() { return this; }
  emitAfter() { return this; }
  emitDestroy() { return this; }
  asyncId() { return 0; }
  triggerAsyncId() { return 0; }
}
AsyncResource.bind = (fn) => fn;

function createHook() {
  return { enable() { return this; }, disable() { return this; } };
}

module.exports = {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId: () => 0,
  triggerAsyncId: () => 0,
  executionAsyncResource: () => ({}),
};
module.exports.default = module.exports;
