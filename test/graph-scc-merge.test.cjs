'use strict';
// The cyclic-group merge DRIVER (libexec/graph-scc-merge.cjs) — the one implementation
// both consumers of a staged graph run: libexec/clode-extract.cjs under node, and
// scripts/merge-step.mjs under tjs (spawned by libexec/quaude-fuse.js — Task 7 pulled the
// tjs-side call out of quaude-fuse.js itself and into that protocol-only component).
//
// Hermetic: a two-module graph with the exact shape upstream Claude Code 2.1.248+ emits —
// A statically imports B, and B reaches back with `import.meta.require("A")`. Converting
// that require into an import would close a cycle, so the extractor leaves it, and NO host
// can answer it: tjs raises `node-shim: cannot resolve '/$bunfs/root/chunk-….js'` and node
// raises ERR_REQUIRE_CYCLE_MODULE. The merge makes the cycle stop crossing a module
// boundary, and residualCyclicRequires() is the standing proof that none survived.
const test = require('node:test');
const assert = require('node:assert');
const plan = require('../libexec/bun-graph-plan.cjs');
const merger = require('../libexec/scc-merge.cjs');
const scc = require('../libexec/graph-scc-merge.cjs');

const A = '/$bunfs/root/chunk-aaaa.js';
const B = '/$bunfs/root/chunk-bbbb.js';

// Real sources, compiled by nothing here — the merger is a text transform over them, and
// the only thing it needs an engine for is the metadata below.
function docWithCycle() {
  return {
    format: 'clode-bun-graph-v1',
    entry: A,
    externals: ['fs'],
    order: ['fs', B, A],
    cyclicRequires: [[B, A]],
    sources: {
      fs: 'const __m = globalThis.__quaudeRequire("fs");\nexport default __m;\n',
      [A]: `import { bee } from ${JSON.stringify(B)};\n`
        + 'export const alpha = 1;\n'
        + 'export function useBee() { return bee(); }\n',
      [B]: 'export function bee() { return 2; }\n'
        + `var back = import.meta.require(${JSON.stringify(A)});\n`
        + 'export function readAlpha() { return back.alpha; }\n',
    },
  };
}

// What the engine's parser reports for the two modules above: every top-level binding
// (exported or not) plus the export names. Hand-written here because this test must run
// with no engine; the real callers get it from tjs.engine.moduleMeta.
const METAS = {
  [A]: { locals: ['bee', 'alpha', 'useBee'], exports: ['alpha', 'useBee'] },
  [B]: { locals: ['bee', 'back', 'readAlpha'], exports: ['bee', 'readAlpha'] },
};

test('residualCyclicRequires: finds the require of a graph module, ignores external shims', () => {
  const doc = docWithCycle();
  const found = scc.residualCyclicRequires(doc, plan);
  assert.deepStrictEqual(found, [[B, A]]);

  // A require of an EXTERNAL specifier is not a residual: planGraph puts a generated shim
  // module in the graph under that specifier's own name, and every host answers it through
  // __quaudeRequire. Counting it would make the ratchet fire on every real provider (2.1.251
  // has requires of `util` and `worker_threads` that are perfectly fine).
  doc.sources[A] += 'const f = require("fs");\n';
  assert.deepStrictEqual(scc.residualCyclicRequires(doc, plan), [[B, A]]);
});

test('mergeCyclicGroups: the cycle stops crossing a module boundary', () => {
  const doc = docWithCycle();
  const groups = scc.cyclicGroupsOf(doc, plan);
  assert.strictEqual(groups.length, 1, `expected one cyclic group, got ${JSON.stringify(groups)}`);
  assert.deepStrictEqual([...groups[0]].sort(), [A, B].sort());

  scc.mergeCyclicGroups(doc, { plan, merger, groups, metaOf: (n) => METAS[n] });

  // THE PROPERTY THAT MATTERS: nothing is left for a host resolver to fail on.
  assert.deepStrictEqual(scc.residualCyclicRequires(doc, plan), []);

  // Both members survive as re-export shims onto one merged module, and the merged module
  // is in the order — a member that vanished would resolve to nothing at runtime.
  assert.ok(doc.order.includes(A) && doc.order.includes(B));
  const merged = doc.order.filter((n) => n.includes('__clode-scc-'));
  assert.strictEqual(merged.length, 1, `expected one merged module, got ${merged}`);
  // Both bodies are in the merged module, and B's `bee` was RENAMED because A's imported
  // binding of the same name is now in the same scope — that renaming is why metaOf has to
  // come from a real parser rather than a regex over the text.
  assert.match(doc.sources[merged[0]], /const alpha = 1;/);
  assert.match(doc.sources[merged[0]], /function __m1_bee\(\) \{ return 2; \}/);
  assert.ok(doc.sources[A].includes(merged[0]), 'member A is not a shim onto the merged module');
  assert.ok(doc.sources[B].includes(merged[0]), 'member B is not a shim onto the merged module');

  // And the stamp downstream reads to tell "already merged" from "nothing to merge".
  assert.strictEqual(doc.sccMerge.format, scc.MERGE_FORMAT);
  assert.strictEqual(doc.sccMerge.mergerVersion, merger.MERGER_VERSION);
  assert.deepStrictEqual(doc.sccMerge.groups, [2]);
});

test('mergeCyclicGroups: refuses when the graph and its cyclicRequires disagree', () => {
  // No cycle at all, but the caller asked for a merge: that means the planner's list and
  // the sources disagree. Merging nothing and reporting success would ship a target that
  // dies at runtime with "cannot resolve", so it fails here instead.
  const doc = docWithCycle();
  doc.sources[B] = 'export function bee() { return 2; }\n';
  assert.throws(
    () => scc.mergeCyclicGroups(doc, { plan, merger, metaOf: (n) => METAS[n] }),
    /no strongly connected group/);
});

test('mergeCyclicGroups: plan, merger and metaOf are all required', () => {
  assert.throws(() => scc.mergeCyclicGroups(docWithCycle(), { plan, merger }),
    /plan, merger and metaOf are all required/);
});
