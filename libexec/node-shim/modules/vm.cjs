'use strict';
// node:vm — SEALED (loader). REAL per-context isolation via the __tjs_vm primitive
// (txiki src/mod_vm.c): each context is a child JSContext with its OWN global object
// on the shared heap. So code eval'd via runInContext (a workflow script + the
// engine's Date.now/Math.random determinism-guard install) sees the child's global,
// and CANNOT clobber the engine's / txiki's shared global. Injected builtins
// (agent/log/parallel/pipeline/args/budget) are main-context values set as child
// globals; when the script calls them they run in THEIR home (main) context, so they
// keep the real clock. See docs/superpowers/plans/2026-07-24-vm-context-isolation.md.
//
// runInThisContext / compileFunction intentionally use the MAIN global (that is their
// Node contract). Marshaling is copy-IN of the sandbox's own props at
// createContext/runInContext boundaries; copy-out is not implemented (the engine
// reads the run() return value, not sandbox props) — revisit if a consumer needs it.
const VM = globalThis.__tjs_vm;
if (!VM) {
  throw new Error('node-shim: this tjs lacks the __tjs_vm context primitive (rebuild: node scripts/build-tjs.mjs)');
}

const indirectEval = eval; // runInThisContext: main global, by design
const handles = new WeakMap(); // contextified sandbox object -> child-context handle

function copyIn(sandbox, h) {
  for (const k of Object.keys(sandbox)) {
    try { VM.setGlobal(h, k, sandbox[k]); } catch { /* non-transferable prop: skip */ }
  }
}

// Mirror the child global's values for the sandbox's known keys back onto the
// sandbox object (Node's contextified sandbox reflects context-global writes).
// Runs right after a SYNC eval; for an async run the sandbox isn't relied upon
// (the engine reads the returned Promise), so stale-until-resolve is fine.
function copyOut(sandbox, h) {
  for (const k of Object.keys(sandbox)) {
    try { sandbox[k] = VM.getGlobal(h, k); } catch { /* skip */ }
  }
}

function createContext(sandbox) {
  const s = (sandbox == null || typeof sandbox !== 'object') ? {} : sandbox;
  let h = handles.get(s);
  if (!h) { h = VM.create(); handles.set(s, h); }
  copyIn(s, h);
  return s;
}

function isContext(sandbox) {
  return !!(sandbox && typeof sandbox === 'object' && handles.has(sandbox));
}

// Resolve the child handle, contextifying on demand (lenient — Node requires a
// pre-contextified object, but the bundle always createContext()s first anyway).
function handleFor(sandbox) {
  const s = (sandbox == null || typeof sandbox !== 'object') ? createContext({}) : sandbox;
  let h = handles.get(s);
  if (!h) { createContext(s); h = handles.get(s); }
  return { h, s };
}

function runInContextImpl(code, sandbox, opts) {
  const { h, s } = handleFor(sandbox);
  copyIn(s, h); // re-push in case the engine mutated the sandbox after createContext
  const result = VM.run(h, String(code), (opts && opts.filename) || '<vm>');
  copyOut(s, h); // reflect context-global writes back onto the sandbox
  return result;
}

class Script {
  constructor(code) {
    this.__code = String(code);
    // Keep the M1 syntax gate: surface SyntaxErrors at construction like Node.
    try { new Function(this.__code); } catch (e) {
      if (e instanceof SyntaxError) throw e;
      throw new SyntaxError(String(e && e.message ? e.message : e));
    }
  }
  runInThisContext() { return indirectEval(this.__code); }
  runInContext(contextifiedSandbox, opts) { return runInContextImpl(this.__code, contextifiedSandbox, opts); }
  runInNewContext(sandbox, opts) { return runInContextImpl(this.__code, createContext(sandbox), opts); }
}

function runInThisContext(code) { return indirectEval(String(code)); }
function runInContext(code, contextifiedSandbox, opts) { return runInContextImpl(code, contextifiedSandbox, opts); }
function runInNewContext(code, sandbox, opts) { return runInContextImpl(code, createContext(sandbox), opts); }
function compileFunction(code, params) {
  return new Function(...(Array.isArray(params) ? params : []), String(code));
}

module.exports = {
  Script, createContext, isContext,
  runInThisContext, runInContext, runInNewContext, compileFunction,
};
