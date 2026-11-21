// What Bun.ant.isVmContextGlobal answers, for the cases quaude's implementation must match.
// Runs inside native Bun (BUN_OPTIONS=--preload) and under node with bun-shim (argv[2] = bun-shim path).
const vm = require('vm');
const B = globalThis.Bun && globalThis.Bun.ant ? globalThis.Bun : (process.argv[2] ? require(process.argv[2]) : null);
const f = B && B.ant && B.ant.isVmContextGlobal;
const out = { has: typeof f };
if (typeof f === 'function') {
  const one = (k, v) => { try { out[k] = f(v); } catch (e) { out[k] = 'threw ' + e.message; } };
  const sandbox = {};
  const ctx = vm.createContext(sandbox);
  one('inner global of createContext', vm.runInContext('this', ctx));
  one('the contextified sandbox', sandbox);
  one('plain object', {});
  one('this realm global', globalThis);
  one('runInNewContext global', vm.runInNewContext('this', {}));
  one('runInNewContext no sandbox', vm.runInNewContext('this'));
  one('Script.runInNewContext global', new vm.Script('this').runInNewContext({}));
  one('createContext() no arg, inner', vm.runInContext('this', vm.createContext()));
  one('object inside a context', vm.runInContext('({})', ctx));
  one('null', null);
  one('undefined', undefined);
  one('number', 1);
  one('isContext(inner)', vm.isContext(vm.runInContext('this', ctx)));
}
console.log('CTXGLOBAL ' + JSON.stringify(out));
