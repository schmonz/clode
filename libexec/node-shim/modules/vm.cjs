'use strict';
// node:vm — M1 surface: syntax-check only (the extractor compiles module
// sources to validate them). DIVERGENCE (documented): new Function parses
// in sloppy/function context, not Script context; adequate for the
// extractor's syntax gate, wrong for actual sandboxing. Fail loud on run.
class Script {
  constructor(code) {
    try { new Function(code); } catch (e) {
      if (e instanceof SyntaxError) throw e;
      throw new SyntaxError(String(e?.message ?? e));
    }
  }
  runInThisContext() { throw new Error('node-shim: vm.Script.runInThisContext not implemented'); }
}
module.exports = { Script };
