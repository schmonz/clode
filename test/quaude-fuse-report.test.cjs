'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const R = require('../libexec/build-report.cjs');
const { Composer } = require('../libexec/build-compose.cjs');

test('quaude-fuse LOADS the protocol module the way it loads its other libexec cjs', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  assert.match(src, /build-report\.cjs/, 'the worker must speak the protocol');
  assert.match(src, /Reporter/, 'and emit through it rather than ad-hoc printing');
  // require() in this worker is a loud stub that throws (:72-81) — there is no
  // module resolver. It must go through loadLibexecCjs, like scc-merge.cjs does.
  assert.match(src, /loadLibexecCjs\(\s*[\s\S]{0,200}build-report\.cjs/,
    'build-report.cjs must be loaded via loadLibexecCjs, not require()');
});

test('build-report.cjs is CARRIED into a fused builder, or it works from a checkout and dies fused', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  // lastIndexOf, not indexOf: 'scc-merge.cjs' appears TWICE earlier too (the loadLibexecCjs
  // call inside mergeCyclicGroups that reads and evaluates it) — indexOf would anchor on
  // that unrelated call instead of the carried-member list this test actually means to check.
  // The carried-member array (":294" in the brief) is where the literal appears LAST.
  const anchor = src.lastIndexOf("'scc-merge.cjs'");
  const members = src.slice(anchor - 400, anchor + 200);
  assert.match(members, /build-report\.cjs/,
    'add it to the carried-member list beside scc-merge.cjs (:294)');
});

// Carried forward from Task 4's review: the arithmetic tests above (feed()/
// 'never mismatches'/'regression proof') construct their call sequence BY HAND
// as JS literals and never load quaude-fuse.js at all — reverting the file's
// actual step ordering (the fix this round made: 'compile'/'assets' planned
// AFTER 'merge' finishes, from the POST-merge doc.order) would not fail any of
// them. This is the cheap guard that actually reads the source and would.
//
// TASK 7 changed WHO owns 'merge': it moved out of this worker's `report`
// entirely, into scripts/merge-step.mjs (a protocol-only component — see
// test/merge-step.test.cjs for its own plan/start/finish assertions). This
// worker now has exactly ONE report.plan( call site (compile+assets); the
// ordering property that mattered before — "compile/assets must be planned
// from the POST-merge doc.order, not the pre-merge one" — still has to hold,
// it just anchors on the merge SUBPROCESS having been waited on and applied,
// not on a report.finish('merge' this file no longer writes.
test('quaude-fuse plans compile/assets AFTER the merge subprocess is applied, in the SOURCE ITSELF (not just in a hand-written test double)', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  const planIdxs = [];
  for (let i = src.indexOf('report.plan('); i !== -1; i = src.indexOf('report.plan(', i + 1)) planIdxs.push(i);
  assert.strictEqual(planIdxs.length, 1,
    'expected exactly one report.plan( call site left in this file: compile+assets — '
    + "'merge' is now planned by scripts/merge-step.mjs, not here");
  const mergeAppliedIdx = src.lastIndexOf('doc.order = merged.order');
  assert.notStrictEqual(mergeAppliedIdx, -1,
    'the merge subprocess result must be applied onto doc.order somewhere before compile/assets are planned');
  assert.ok(planIdxs[0] > mergeAppliedIdx,
    'the (sole) report.plan( (compile/assets) must appear AFTER the merge result is applied to doc.order — '
    + 'planning from doc.order before that would silently under-declare a total the compile loop (which '
    + 'iterates the ACTUAL, longer doc.order) then exceeds, tripping the over-report mismatch (see the '
    + 'regression-proof test above for what that looked like)');
});

test('the worker declares compile and assets as named steps; merge is declared by scripts/merge-step.mjs, not here', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  for (const name of ['compile', 'assets']) {
    assert.match(src, new RegExp(`['"\`]${name}['"\`]`), `step '${name}' must be declared by name`);
  }
  // This worker still NAMES 'merge' (log lines, the subprocess result file) but must not
  // declare it as ITS OWN report step — that would double-declare alongside merge-step.mjs's
  // own plan(), which build-compose.cjs has no defined behaviour for.
  assert.doesNotMatch(src, /report\.plan\(\[\{\s*name:\s*['"`]merge['"`]/,
    "quaude-fuse.js must not itself plan a 'merge' report step — that step belongs to "
    + 'scripts/merge-step.mjs alone');
});

test('build-report stays tjs-safe, or the worker dies at runtime', () => {
  const src = fs.readFileSync(require.resolve('../libexec/build-report.cjs'), 'utf8');
  assert.strictEqual(/require\(/.test(src), false,
    'build-report.cjs must not require anything: quaude-fuse.js loads it under txiki.js, not Node');
});

// The previous four tests all match SOURCE TEXT — none exercises the actual plan/start/
// finish arithmetic quaude-fuse.js emits at runtime. That gap let a real bug through
// fix round 1: mergeCyclicGroups (the in-worker fallback merge, live whenever a doc was
// staged before the merge moved to staging) mutates doc.order IN PLACE, minting one new
// synthetic module per merged cyclic group — so a 'compile' total captured from
// doc.order.length BEFORE merge runs is stale, and the compile loop (which iterates the
// POST-merge, longer doc.order) reports MORE than declared. build-compose.cjs's
// mismatch check treats any over-report as a hard failure. These two tests replay the
// actual call sequence quaude-fuse.js now emits through the REAL Composer, so a
// regression in that ordering fails here instead of only at a live fuse.
function feed(composer, component, fn) {
  const lines = [];
  fn(new R.Reporter({ emit: (l) => lines.push(l) }));
  for (const line of lines) composer.ingest(component, line);
}

test('quaude-fuse\'s post-fix call sequence never mismatches, even when the in-worker merge GROWS doc.order', () => {
  const c = new Composer();
  const cyclicRequires = new Array(33).fill(0);
  const preMergeOrderLength = 1795;
  // The in-worker merge fallback mints one new synthetic module per merged group (3
  // groups on 2.1.250: scc-merge.cjs's mergeGroup + graph-scc-merge.cjs's re-sort).
  const postMergeOrderLength = preMergeOrderLength + 3;
  const assetCount = 173;

  feed(c, 'quaude-fuse', (r) => {
    // Only 'merge' is planned before it runs — its total (cyclicRequires.length) is
    // unaffected by its own work, so it is safe to declare up front.
    r.plan([{ name: 'merge', total: cyclicRequires.length }]);
    r.start('merge');
    r.finish('merge', cyclicRequires.length);

    // 'compile'/'assets' are planned AFTER merge finishes, from the now-final doc.order.
    r.plan([
      { name: 'compile', total: postMergeOrderLength },
      { name: 'assets', total: assetCount },
    ]);
    r.start('compile');
    for (let i = 1; i <= postMergeOrderLength; i++) r.progress('compile', i);
    r.finish('compile', postMergeOrderLength);

    r.start('assets');
    r.finish('assets', assetCount);
  });

  assert.deepStrictEqual(c.mismatches(), [],
    'a total taken from the POST-merge doc.order must never be exceeded');
});

test('regression proof: capturing compile\'s total from the PRE-merge doc.order (the fixed bug) DOES trip the over-report mismatch', () => {
  const c = new Composer();
  const cyclicRequires = new Array(33).fill(0);
  const preMergeOrderLength = 1795;
  const postMergeOrderLength = preMergeOrderLength + 3;
  const assetCount = 173;

  feed(c, 'quaude-fuse', (r) => {
    // THE BUG this round fixed: 'compile's total declared in the SAME plan() call as
    // 'merge', from doc.order.length captured BEFORE merge ran.
    r.plan([
      { name: 'merge', total: cyclicRequires.length },
      { name: 'compile', total: preMergeOrderLength },
      { name: 'assets', total: assetCount },
    ]);
    r.start('merge');
    r.finish('merge', cyclicRequires.length);
    r.start('compile');
    // The compile loop always iterates the ACTUAL (post-merge) doc.order, regardless of
    // what total was declared — so it reports more than was promised.
    r.finish('compile', postMergeOrderLength);
    r.start('assets');
    r.finish('assets', assetCount);
  });

  const mismatches = c.mismatches();
  assert.strictEqual(mismatches.length, 1, 'the stale pre-merge total must be caught as an over-report');
  assert.match(mismatches[0].reason, /compile/);
  assert.match(mismatches[0].reason, /exceeding a total/,
    'the reason must name it as an over-report, not merely any mismatch');
});
