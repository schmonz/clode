'use strict';
// node:events — EventEmitter, the observable subset. Locked by
// test/node-shim-core.test.cjs against host node.
class EventEmitter {
  #listeners = new Map();
  on(name, fn) { (this.#listeners.get(name) ?? this.#listeners.set(name, []).get(name)).push({ fn, once: false }); return this; }
  once(name, fn) { (this.#listeners.get(name) ?? this.#listeners.set(name, []).get(name)).push({ fn, once: true }); return this; }
  off(name, fn) { return this.removeListener(name, fn); }
  removeListener(name, fn) {
    const l = this.#listeners.get(name);
    if (l) { const i = l.findIndex((e) => e.fn === fn); if (i >= 0) l.splice(i, 1); }
    return this;
  }
  removeAllListeners(name) { name === undefined ? this.#listeners.clear() : this.#listeners.delete(name); return this; }
  emit(name, ...args) {
    const l = this.#listeners.get(name);
    if (!l || l.length === 0) {
      if (name === 'error') throw (args[0] instanceof Error ? args[0] : new Error(`Unhandled error: ${args[0]}`));
      return false;
    }
    for (const e of [...l]) { if (e.once) this.removeListener(name, e.fn); e.fn.apply(this, args); }
    return true;
  }
  listenerCount(name) { return this.#listeners.get(name)?.length ?? 0; }
  listeners(name) { return (this.#listeners.get(name) ?? []).map((e) => e.fn); }
  rawListeners(name) { return this.listeners(name); }
  addListener(name, fn) { return this.on(name, fn); }
  // Prepend variants (Task 4 wall-adjacent): insert at the FRONT of the list.
  prependListener(name, fn) { (this.#listeners.get(name) ?? this.#listeners.set(name, []).get(name)).unshift({ fn, once: false }); return this; }
  prependOnceListener(name, fn) { (this.#listeners.get(name) ?? this.#listeners.set(name, []).get(name)).unshift({ fn, once: true }); return this; }
  eventNames() { return [...this.#listeners.keys()].filter((k) => this.#listeners.get(k).length > 0); }
  // setMaxListeners/getMaxListeners (Task 4 wall): the -p bundle subclasses
  // EventEmitter and calls this.setMaxListeners(0) in its constructor. Real:
  // stores the cap and returns it; 0 means unlimited (Node semantics).
  #maxListeners = undefined;
  setMaxListeners(n) { this.#maxListeners = n; return this; }
  getMaxListeners() { return this.#maxListeners === undefined ? EventEmitter.defaultMaxListeners : this.#maxListeners; }
}
EventEmitter.defaultMaxListeners = 10;
EventEmitter.EventEmitter = EventEmitter;
module.exports = { EventEmitter, default: EventEmitter };
module.exports.once = (emitter, name) => new Promise((res) => emitter.once(name, (...a) => res(a)));

// Module-level events.setMaxListeners(n, ...targets) (Node 15+) — DISTINCT from
// the EventEmitter instance method. The -p bundle's AbortController helper (`Jl`)
// calls `require('events').setMaxListeners(n, abortController.signal)` to raise
// the listener cap on an AbortSignal; a missing module-level function throws
// `TypeError: not a function` and aborts session loading (Stu) before the
// Messages round-trip. Node: with no targets, sets EventEmitter.defaultMaxListeners;
// with targets, sets the cap on each (an EventEmitter via its setMaxListeners, an
// EventTarget/AbortSignal via a symbol-keyed slot). Returns undefined.
// Characterized by test/node-shim-core.test.cjs (events.setMaxListeners row).
const kMaxListeners = Symbol.for('nodejs.events.maxListeners');
module.exports.setMaxListeners = function setMaxListeners(n = EventEmitter.defaultMaxListeners, ...targets) {
  if (targets.length === 0) { EventEmitter.defaultMaxListeners = n; return; }
  for (const t of targets) {
    if (t && typeof t.setMaxListeners === 'function') t.setMaxListeners(n);
    else if (t) { try { t[kMaxListeners] = n; } catch { /* frozen target: ignore */ } }
  }
};
module.exports.getMaxListeners = function getMaxListeners(target) {
  if (target && typeof target.getMaxListeners === 'function') return target.getMaxListeners();
  if (target && target[kMaxListeners] !== undefined) return target[kMaxListeners];
  return EventEmitter.defaultMaxListeners;
};
