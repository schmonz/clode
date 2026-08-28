// Characterization for libexec/bun-graph-plan.cjs — the build-time plan for compiling a
// code-split bundle: what to compile, in what order, and the generated shims that make
// bare specifiers resolvable.
//
// The properties that matter are ORDER and COMPLETENESS, because both fail late and
// expensively. `tjs.engine.compile()` resolves imports as it compiles, so a dependency
// compiled after its dependent does not warn — it stops the build partway through with a
// "could not load" naming a module that is perfectly fine. Measured before shims existed:
// 279 of 1384 modules compiled, then a bare `fs` ended it.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { planGraph, planOrder, externalsOf, shimSource, depsOf } =
  require('../libexec/bun-graph-plan.cjs');
const { loadGraph, loadGraphFull } = require('../libexec/bun-graph.cjs');
const REPO = path.join(__dirname, '..');

const G = (obj) => new Map(Object.entries(obj));

// ---- order -------------------------------------------------------------------

test('dependencies are compiled before the modules that import them', () => {
  const g = G({
    '/a.js': 'import{x}from"/b.js";export{x as y};',
    '/b.js': 'import"/c.js";export const x=1;',
    '/c.js': 'export const z=2;',
  });
  const order = planOrder(g);
  assert.deepStrictEqual(order.length, 3);
  assert.ok(order.indexOf('/c.js') < order.indexOf('/b.js'), 'c before b');
  assert.ok(order.indexOf('/b.js') < order.indexOf('/a.js'), 'b before a');
});

test('a cycle throws and names both modules — it has no valid compile order', () => {
  const g = G({ '/a.js': 'import"/b.js";', '/b.js': 'import"/a.js";' });
  assert.throws(() => planOrder(g), (e) => /import cycle/.test(e.message)
    && /\/a\.js/.test(e.message) && /\/b\.js/.test(e.message));
});

test('specifiers outside the graph are not treated as dependencies', () => {
  // `fs` is not a module in the graph; it must not appear in the order or the DFS
  // would chase a module that does not exist.
  const g = G({ '/a.js': 'import{readFileSync}from"fs";export const q=1;' });
  assert.deepStrictEqual(planOrder(g), ['/a.js']);
  assert.deepStrictEqual(depsOf(g.get('/a.js'), (s) => g.has(s)), []);
});

// ---- externals and shims ------------------------------------------------------

test('every import form contributes an external, and named imports are collected', () => {
  const g = G({
    '/a.js': 'import{readFileSync,writeFileSync as w}from"fs";'
      + 'import * as os from"os";import p from"path";import"side-effect";',
  });
  const ext = externalsOf(g);
  assert.deepStrictEqual(Object.keys(ext).sort(), ['fs', 'os', 'path', 'side-effect']);
  // The ORIGINAL name is what must be re-exported, not the local alias.
  assert.deepStrictEqual(Object.keys(ext.fs).sort(), ['readFileSync', 'writeFileSync']);
});

test('a shim re-exports the requested names and routes through one runtime seam', () => {
  const src = shimSource('fs', ['readFileSync', 'promises']);
  assert.match(src, /globalThis\.__quaudeRequire\("fs"\)/);
  assert.match(src, /export \{ readFileSync, promises \}/);
  assert.match(src, /export default __m/);
});

test('a shim reads each name under guard, so a WALL fires on use and not on import', () => {
  // The shim marks unimplemented APIs with a throwing getter. Reading every name while
  // the shim module evaluates would trip every wall on that specifier whether the bundle
  // touches it or not — measured: a 2.1.245 build died on vm.SyntheticModule it never
  // uses. The error must be preserved and re-thrown from the binding instead.
  const src = shimSource('vm', ['SyntheticModule']);
  assert.match(src, /try \{ SyntheticModule = __m\["SyntheticModule"\]; \}/);
  assert.match(src, /catch \(__e\) \{ const __w = __e; SyntheticModule = function \(\) \{ throw __w; \}; \}/);
  // and it must actually behave that way, not merely look like it
  const mod = { get SyntheticModule() { throw new Error('vm.SyntheticModule not implemented'); } };
  let bound;
  const run = new Function('__m', src.replace(/^const __m[^\n]*\n/, '').replace(/export \{[^}]*\};?/, '').replace(/export default __m;?/, '') + '\nreturn SyntheticModule;');
  assert.doesNotThrow(() => { bound = run(mod); }, 'importing must not trip the wall');
  assert.throws(() => bound(), /not implemented/, 'using it must trip the wall');
});

test('a shim never emits a non-identifier as a named export', () => {
  // Anything unbindable stays reachable via the default export rather than producing
  // a module that cannot compile at all.
  const src = shimSource('weird', ['ok', 'has-dash', '2bad', 'default']);
  assert.match(src, /export \{ ok \}/);
  assert.doesNotMatch(src, /has-dash/);
  assert.doesNotMatch(src, /\b2bad\b/);
  assert.doesNotMatch(src, /\bdefault =/);
});

// ---- the whole plan ------------------------------------------------------------

test('planGraph puts shims first and covers every module exactly once', () => {
  const g = G({
    '/entry.js': 'import{a}from"/lib.js";import{readFileSync}from"fs";',
    '/lib.js': 'import{homedir}from"os";export const a=1;',
  });
  const plan = planGraph(g, '/entry.js');
  assert.strictEqual(plan.moduleCount, 2);
  assert.deepStrictEqual(plan.externals.sort(), ['fs', 'os']);
  for (const e of plan.externals) {
    assert.ok(plan.order.indexOf(e) < plan.order.indexOf('/lib.js'), `${e} before modules`);
  }
  assert.strictEqual(new Set(plan.order).size, plan.order.length, 'no duplicates');
  for (const n of plan.order) assert.strictEqual(typeof plan.sources[n], 'string', n);
});

test('planGraph refuses an entry that is not in the graph', () => {
  assert.throws(() => planGraph(G({ '/a.js': '' }), '/missing.js'), /not in the graph/);
});

// ---- real providers ------------------------------------------------------------

function providers() {
  const found = [], seen = new Set();
  const add = (p) => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); found.push(p); } };
  add(process.env.CLODE_PROVIDER_BIN);
  add(process.env.CLODE_CLAUDE_BIN);
  try {
    add(execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8' }).trim());
  } catch { /* reported by the skip message */ }
  try {
    const { VERSIONS, providerBin } = require('./golden-shas-lib.cjs');
    for (const v of VERSIONS) add(providerBin(v));
  } catch { /* fixture lib unavailable */ }
  return found;
}

const PROVIDERS = providers();
const provOpts = {
  skip: PROVIDERS.length ? false
    : 'no Claude provider found (CLODE_PROVIDER_BIN, CLODE_CLAUDE_BIN, scripts/find-provider.mjs, or the golden-shas store)',
};

test('a real bundle plans with no order violations and no missing sources', provOpts, () => {
  for (const bin of PROVIDERS) {
    const mods = loadGraph(bin);
    const plan = planGraph(mods, loadGraphFull(bin).entryName);
    const pos = new Map(plan.order.map((n, i) => [n, i]));
    for (const [n, s] of mods) {
      for (const d of depsOf(s, (x) => mods.has(x))) {
        assert.ok(pos.get(d) < pos.get(n), `${bin}: ${d} must precede ${n}`);
      }
    }
    for (const n of plan.order) {
      assert.strictEqual(typeof plan.sources[n], 'string', `${bin}: no source for ${n}`);
    }
    assert.ok(plan.order.includes(plan.entry), `${bin}: entry missing from the order`);
  }
});

// ---- hooks across the graph ----------------------------------------------------

const { transformGraph } = require('../libexec/extract-claude-js.cjs');

test('transformGraph keeps the exactly-once contract ACROSS modules, not per module', () => {
  // The same anchor in two modules must NOT be patched twice — that is the whole
  // difference between "applies once per module" and "applies once in the bundle".
  // Shaped to the REAL anchor (INSTALL_WARNINGS in extract-claude-js.cjs), not invented
  // — a fixture that does not match would make this test prove nothing at all.
  const anchor = 'return{installationType:t,version:v,warnings:w,packageManager:p};';
  const { report } = transformGraph({ '/a.js': anchor, '/b.js': anchor });
  const doctor = report.find((r) => r.key === 'doctor');
  assert.strictEqual(doctor.applied, false, 'two matches must not be treated as applied');
  assert.match(doctor.why, /expected exactly one/);
});

test('transformGraph leaves sources untouched for a hook that did not apply', () => {
  const src = { '/a.js': 'nothing to patch here' };
  const { sources, report } = transformGraph(src);
  assert.strictEqual(sources['/a.js'], 'nothing to patch here');
  assert.ok(report.every((r) => r.applied === false), 'nothing should have applied');
  assert.ok(report.length > 0, 'every hook must be reported, applied or not');
});

test('transformGraph reports every hook by name, so a silent skip is impossible', () => {
  const { report } = transformGraph({ '/a.js': '' });
  const keys = report.map((r) => r.key).sort();
  assert.deepStrictEqual(keys, [
    'autoupdater', 'doctor', 'embedded_asset_reader', 'legacy_autoupdater', 'manual_update',
    'native_autoupdater', 'remote_control', 'snapshot_bridge', 'update_hint', 'update_notice',
  ]);
});

test('a real split bundle patches every hook', provOpts, () => {
  let checked = 0;
  for (const bin of PROVIDERS) {
    const mods = loadGraph(bin);
    const full = loadGraphFull(bin);
    // CJS bundles go through transform(), not transformGraph().
    if (full.rows.filter((r) => r.loader === 1)[0].moduleFormat !== 2) {
      const plan = planGraph(mods, full.entryName);
      const { report } = transformGraph(plan.sources);
      // No hook is exempt. snapshot_bridge used to be skipped here while its
      // anchor was stale for 2.1.243+; re-pinning it (storageV5 parameter) closed
      // that gap, and a skip is exactly how a dead hook stays dead unnoticed.
      for (const r of report) {
        // A 'benign' non-application is a hook whose anchor CANNOT be present in this provider —
        // embedded_asset_reader only exists from 2.1.251, when assets started being read through
        // the filesystem. Anything else that did not apply is a dead hook, which is the whole
        // point of this assertion.
        if (r.benign) continue;
        assert.strictEqual(r.applied, true, `${bin}: hook ${r.key} did not apply: ${r.why}`);
      }
      checked++;
    }
  }
  if (!checked) return;   // no split-format provider present
  assert.ok(checked > 0);
});
