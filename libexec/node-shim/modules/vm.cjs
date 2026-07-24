'use strict';
// node:vm — SEALED (loader). Used by the bundle at ~7 sites (the Workflow script
// loader, a command/tool sandbox, a REPL eval, a code-input tool): require('vm')
// then Script / createContext / runInContext / runInThisContext / compileFunction.
//
// quickjs-ng exposes NO context-isolation primitive, so a "context" here is the
// sandbox OBJECT itself, and code runs against it via a sloppy-mode `with` + direct
// eval: identifier reads resolve to the sandbox's own properties, and assignments to
// existing sandbox properties flow back to the object.
//
// DIVERGENCE (documented + tested in test/node-shim-vm.test.cjs): this is NOT a real
// sandbox. Identifiers absent from the sandbox fall through to the real global scope,
// and code that creates brand-new globals leaks them to the global scope rather than
// onto the sandbox. Adequate for the bundle's inject-known-globals-and-run usage
// (e.g. the Workflow orchestration loader); true isolation stays out of reach.
const indirectEval = eval; // indirect eval => global scope, not the caller's

const CONTEXT_FLAG = Symbol.for('node-shim.vm.contextified');

function createContext(sandbox) {
  const s = (sandbox == null || typeof sandbox !== 'object') ? {} : sandbox;
  try {
    Object.defineProperty(s, CONTEXT_FLAG, { value: true, enumerable: false, configurable: true });
  } catch { /* frozen/sealed sandbox — still usable below, just not markable */ }
  return s;
}
function isContext(sandbox) {
  return !!(sandbox && typeof sandbox === 'object' && sandbox[CONTEXT_FLAG]);
}

// Run `code` with `sandbox`'s own properties in scope. `with` requires sloppy mode;
// functions built by `new Function` are sloppy regardless of this file's 'use strict'
// (they don't inherit surrounding strict mode). The direct `eval(__code__)` inside
// the `with` block evaluates in the with-scope and returns the code's completion
// value — matching vm's return contract.
function runInSandbox(code, sandbox) {
  const box = (sandbox == null || typeof sandbox !== 'object') ? {} : sandbox;
  const fn = new Function('__sandbox__', '__code__', 'with (__sandbox__) { return eval(__code__); }');
  return fn(box, String(code));
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
  runInContext(contextifiedSandbox) { return runInSandbox(this.__code, contextifiedSandbox); }
  runInNewContext(sandbox) { return runInSandbox(this.__code, createContext(sandbox)); }
}

function runInThisContext(code) { return indirectEval(String(code)); }
function runInContext(code, contextifiedSandbox) { return runInSandbox(code, contextifiedSandbox); }
function runInNewContext(code, sandbox) { return runInSandbox(code, createContext(sandbox)); }
function compileFunction(code, params) {
  return new Function(...(Array.isArray(params) ? params : []), String(code));
}

module.exports = {
  Script, createContext, isContext,
  runInThisContext, runInContext, runInNewContext, compileFunction,
};
