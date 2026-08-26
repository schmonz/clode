'use strict';
/* engine-run — entry point for running node:test-shaped test files ON THE ENGINE.
 *
 *   tjs run libexec/node-shim/loader.cjs test/engine/run.cjs <file.test.cjs> [...]
 *
 * The ONLY thing injected is `node:test` (the harness). Every other require —
 * node:assert, node:fs, node:path, node:util, and the repo's own libexec/* — goes
 * through the loader's real resolution and therefore lands on the real shim.
 */

const Module = require('node:module');
const harness = require('./harness.cjs');

// Intercept `require('node:test')` / `require('test')` only. Module._load is the
// loader's documented monkeypatch seam (libexec/node-shim/modules/module.cjs).
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const bare = String(request).startsWith('node:') ? String(request).slice(5) : String(request);
  if (bare === 'test' || bare === 'test/reporters') {
    if (bare === 'test') return harness.moduleExports;
    throw new Error('engine-harness: node:test/reporters is not implemented');
  }
  return origLoad(request, parent, isMain);
};

// ---- self-check: the harness must not be the thing making tests pass ---------
// If the shim's node:assert were a no-op, every ported test would go green while
// measuring nothing. Prove it throws BEFORE running anything.
(function assertIsReal() {
  const assert = require('node:assert');
  const probes = [
    ['strictEqual', () => assert.strictEqual(1, 2)],
    ['deepStrictEqual', () => assert.deepStrictEqual({ a: 1 }, { a: 2 })],
    ['ok', () => assert.ok(false)],
    ['match', () => assert.match('abc', /zzz/)],
    ['throws', () => assert.throws(() => {})],
  ];
  const dead = [];
  for (const [name, fn] of probes) {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    if (!threw) dead.push(name);
  }
  if (dead.length) {
    console.log(`# FATAL: shim node:assert does not throw for: ${dead.join(', ')}`);
    console.log('# tests 0');
    console.log('# fail 1');
    process.exitCode = 2;
    throw new Error('engine-harness: shim assert is not load-bearing; refusing to report green');
  }
  console.log(`# assert self-check ok (${probes.length} negative probes all threw)`);
})();

const files = process.argv.slice(2);
if (!files.length) {
  console.log('usage: run.cjs <file.test.cjs> [...]');
  process.exitCode = 64;
} else {
  const path = require('node:path');
  const loadErrors = [];
  for (const f of files) {
    const abs = path.resolve(f);
    console.log(`# file ${abs}`);
    try {
      require(abs);
    } catch (e) {
      loadErrors.push({ f: abs, e });
      console.log(`not ok - LOAD ${abs}`);
      console.log(`  error: ${(e && e.message) || String(e)}`);
      if (e && e.stack) console.log('  stack: ' + String(e.stack).split('\n').slice(0, 8).join(' | '));
    }
  }
  harness.run().then((stats) => {
    if (loadErrors.length) console.log(`# loaderrors ${loadErrors.length}`);
    const bad = stats.fail + loadErrors.length;
    console.log(`# RESULT ${bad === 0 ? 'PASS' : 'FAIL'}`);
    if (bad !== 0) process.exitCode = 1;
  }, (e) => {
    console.log(`# RESULT FAIL (runner threw): ${(e && e.stack) || e}`);
    process.exitCode = 1;
  });
}
