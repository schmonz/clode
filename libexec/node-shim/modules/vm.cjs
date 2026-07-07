'use strict';
// node:vm — SEALED (loader). Script keeps the M1 syntax-gate semantics.
// runInThisContext / compileFunction are real (indirect eval / new Function).
// DIVERGENCE (documented + tested): both evaluate in the GLOBAL context, not a
// sandboxed one — quickjs-ng has no context-isolation primitive we expose here.
// Adequate for the bundle's non-sandboxed self-eval; a true sandbox is a wall.
const indirectEval = eval; // indirect eval => global scope, not the caller's
class Script {
  constructor(code) {
    this.__code = code;
    try { new Function(code); } catch (e) {
      if (e instanceof SyntaxError) throw e;
      throw new SyntaxError(String(e && e.message ? e.message : e));
    }
  }
  runInThisContext() { return indirectEval(this.__code); }
}
function runInThisContext(code) { return indirectEval(String(code)); }
function compileFunction(code, params) {
  return new Function(...(Array.isArray(params) ? params : []), String(code));
}
module.exports = { Script, runInThisContext, compileFunction };
