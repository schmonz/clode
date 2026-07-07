'use strict';
// Characterization: node:async_hooks AsyncLocalStorage synchronous-scope
// contract (run/getStore/enterWith/exit/nested) must match host node. The
// cross-await PROPAGATION node has (and this shim does NOT — see
// modules/async_hooks.cjs DIVERGENCE) is intentionally NOT asserted equal here;
// it is documented in the module and deferred until a boot needs it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');
const als = new AsyncLocalStorage();
const out = {};
out.outsideBefore = als.getStore() ?? null;
out.sync = als.run({ v: 1 }, () => als.getStore().v);
out.nested = als.run({ v: 1 }, () => als.run({ v: 2 }, () => als.getStore().v) + '/' + als.getStore().v);
out.restoredAfterRun = als.getStore() ?? null;
als.enterWith({ v: 9 });
out.enterWith = als.getStore().v;
out.exit = als.exit(() => als.getStore() ?? null);
out.afterExit = als.getStore().v;
// AsyncResource.runInAsyncScope runs the fn synchronously.
const ar = new AsyncResource('x');
out.ares = ar.runInAsyncScope(() => 'ran');
console.log(JSON.stringify(out));
`;

test('async_hooks AsyncLocalStorage synchronous-scope contract vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-als-'));
  const f = path.join(dir, 'als.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
