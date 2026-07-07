'use strict';
// node:v8 — the minimal surface bun-shim touches. getHeapSnapshot is used only
// by Bun.generateHeapSnapshot, itself wrapped in try/catch, so a fail-loud wall
// is acceptable (it never runs for --version). serialize/deserialize are the
// other common touch; implement over JSON as a documented approximation ONLY if
// the wall-walk proves the bundle needs them (YAGNI until then).
module.exports = {
  getHeapSnapshot() { throw new Error('node-shim: v8.getHeapSnapshot not implemented'); },
};
