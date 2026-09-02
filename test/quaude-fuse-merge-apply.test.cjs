'use strict';
// TASK 7 FIX ROUND 1: quaude-fuse.js's read-back of scripts/merge-step.mjs's computed
// result (libexec/quaude-fuse.js, the `if (cyclicRequires.length && !alreadyMerged) {...}`
// block that applies <stage-dir>/graph-merged.json onto `doc`) was exercised by NOTHING —
// not node --test, not a live build (libexec/clode-extract.cjs REFUSES to stage an unmerged
// graph when an engine is reachable, so the real product path never reaches this branch; it
// exists only for a doc staged before the staging-time merge existed). This is a LIVE test,
// not a source assertion: it drives the real quaude-fuse.js worker, under the real tjs
// engine, through a genuinely unmerged staged graph — bypassing clode-extract.cjs entirely
// by writing graph.json directly, the way "a doc staged before the merge moved to staging"
// would have looked.
//
// It stops short of a full build (no real signed-base/bootstrap/node_modules — quaude-fuse.js
// legitimately dies later, past the point this test cares about) and instead reads the
// worker's OWN build-report protocol lines off stdout: 'merge' finishing with the expected
// count, then 'compile' being PLANNED with a total that reflects the POST-merge doc.order
// (one longer than the pre-merge order — one synthetic module per merged group, same
// invariant test/quaude-fuse-report.test.cjs pins with a hand-built Composer sequence). If
// the apply-back silently did nothing, 'compile' would be planned from the UNMERGED,
// shorter order instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs } = require('./node-shim-helper.cjs');

const REPO = path.resolve(__dirname, '..');

// The exact fixture test/graph-scc-merge.test.cjs uses for the SAME cycle shape upstream
// Claude Code 2.1.248+ emits (A statically imports B, B reaches back with
// import.meta.require("A")) — reused rather than re-invented so a divergence in the driver's
// own understanding of "a cycle" cannot silently make both tests agree on the wrong thing.
const A = '/$bunfs/root/chunk-aaaa.js';
const B = '/$bunfs/root/chunk-bbbb.js';
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
    // NO sccMerge — this is the fallback path's whole reason to exist: a doc staged before
    // clode-extract.cjs did the merge itself.
  };
}

// Run the real quaude-fuse.js worker far enough to plan 'compile', then let it die (missing
// bootstrap/signed-base/deps — none of which this test needs). Returns the parsed
// @clode-step lines seen on stdout before that.
function runWorkerThroughCompilePlan(t, { stageDir }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quaude-fuse-merge-apply-'));
  t.after(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

  const extrasPath = path.join(scratch, 'extras.json');
  fs.writeFileSync(extrasPath, JSON.stringify({ deps: ['whatever-not-read-yet'] }));
  const shimDir = path.join(REPO, 'libexec', 'node-shim'); // real — libexecDir/scriptsDir resolve for real
  const nmDir = path.join(scratch, 'node_modules'); // never read before our checkpoint
  const bootstrapPath = path.join(scratch, 'bootstrap.mjs'); // never read before our checkpoint
  const signedBase = path.join(scratch, 'signed-base'); // never read before our checkpoint
  const out = path.join(scratch, 'out.bin'); // never written before our checkpoint

  const [cmd, argv] = engineSpawn(['run', path.join(REPO, 'libexec', 'quaude-fuse.js'),
    signedBase, stageDir, shimDir, nmDir, bootstrapPath, extrasPath, out]);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });

  const MARK = '@clode-step ';
  const events = (r.stdout || '').split('\n')
    .filter((l) => l.startsWith(MARK))
    .map((l) => JSON.parse(l.slice(MARK.length)));
  return { events, raw: r };
}

test('quaude-fuse applies a freshly-computed merge onto doc.order/doc.sources before planning compile', (t) => {
  if (skipUnlessTjs(t)) return;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quaude-fuse-merge-apply-stage-'));
  t.after(() => { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  fs.writeFileSync(path.join(stageDir, 'graph.json'), JSON.stringify(docWithCycle()));

  const { events, raw } = runWorkerThroughCompilePlan(t, { stageDir });

  const mergeFinished = events.find((e) => e.type === 'finished' && e.name === 'merge');
  assert.ok(mergeFinished, `expected a 'merge' finished event; stdout:\n${raw.stdout}\nstderr:\n${raw.stderr}`);
  assert.strictEqual(mergeFinished.done, 1, "the fixture's ONE cyclic require must be reported done");

  const compilePlan = events.find((e) => e.type === 'plan' && e.steps.some((s) => s.name === 'compile'));
  assert.ok(compilePlan, `expected a 'compile' plan event AFTER the merge; stdout:\n${raw.stdout}\nstderr:\n${raw.stderr}`);
  const compileTotal = compilePlan.steps.find((s) => s.name === 'compile').total;

  // THE LOAD-BEARING ASSERTION. Pre-merge order.length is 3 (fs, B, A). The merge mints ONE
  // new synthetic module for the one merged group, so 'compile' — planned from doc.order
  // AFTER the apply-back — must see 4. If the apply-back is a silent no-op (doc.order and
  // doc.sources never actually mutated from what quaude-fuse.js started with), this would
  // read 3 instead: the pre-merge, unmerged length.
  assert.strictEqual(compileTotal, 4,
    "expected 'compile' planned from the POST-merge doc.order (3 original + 1 synthetic "
    + `merged module = 4); got ${compileTotal}. This is exactly what a silent no-op in the `
    + "merge result's apply-back onto doc looks like.");
});
