'use strict';
// Behavior-NEUTRAL observability for MISSING properties on BROAD (non-sealed)
// shim builtins (fs, crypto, http, net, child_process, stream, v8,
// perf_hooks, ...). loader.cjs's wallProxy already covers a module with no
// .cjs at all; its sealSurface already covers the tiny curated SEALED set
// (module, vm) with a branded throw. Neither sees a missing-property GET on
// a broad module, because Node's "missing prop = undefined" idiom is
// DELIBERATELY preserved there — the bundle's own feature detection depends
// on it. Those accesses are otherwise invisible; this probe makes them
// visible without changing behavior.
//
// THE INVARIANT: a probed GET returns exactly what an unprobed GET would
// return, and `in` returns exactly what it returned before. Handing back a
// stub (or merely DEFINING a property) would flip `typeof mod.X` / `"X" in
// mod` branches — precisely the Bun.SQL regression this repo already hit (a
// global merely EXISTING defeated upstream's `typeof Bun > "u"` guard and
// turned a friendly message into `Bun.SQL is not a constructor`). We
// observe; we do not participate.
//
// No curated gap list: EVERY missing-property access on a probed module is
// logged. A curated list could only ever reveal gaps already known about —
// the noise is the point. A later task intersects this log against
// test/shim-surface/golden.json, where that fixture legitimately belongs; it
// must never travel into shipped/fused code (test/ doesn't exist inside a
// fused quaude, and a baked-in list would go stale against upstream anyway —
// see memory dep-closure-derived-not-declared for the same principle applied
// elsewhere in this shim).
function installProbe(ns, exportsVal, allowKeys) {
  // Read the flag from tjs.env, NOT globalThis.process.env: if a builtin
  // (e.g. process itself) failed to load, globalThis.process IS a wallProxy,
  // and reading its `.env` would re-enter THAT get trap -> unbounded
  // recursion. Same precedent as loader.cjs's wallProxy/sealSurface reading
  // CLODE_SHIM_TRACE this way. tjs.env is the raw engine env.
  if (!globalThis.tjs || !globalThis.tjs.env || !globalThis.tjs.env.CLODE_SHIM_PROBE) return exportsVal;
  if (!exportsVal || (typeof exportsVal !== 'object' && typeof exportsVal !== 'function')) return exportsVal;
  const loggable = (prop) => typeof prop === 'string' && !(allowKeys && allowKeys.has(prop));
  return new Proxy(exportsVal, {
    get(target, prop, receiver) {
      if (loggable(prop) && !(prop in target)) {
        try { console.error('[probe] ' + ns + '.' + prop); } catch { /* best effort */ }
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (loggable(prop) && !(prop in target)) {
        try { console.error('[probe] ' + ns + '.' + prop + ' (in)'); } catch { /* best effort */ }
      }
      return Reflect.has(target, prop);
    },
  });
}
module.exports = { installProbe };
