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
// `report.plan(` (with the receiver, not bare 'plan(') anchors on the two REAL
// calls only — the prose comments above them say "plan() call", never
// "report.plan(", so lastIndexOf/indexOf both land on code. The trap the brief
// warns about is a DIFFERENT anchor: 'scc-merge.cjs' (used by the test above)
// appears three times earlier in the file (inside mergeCyclicGroups and its
// own commentary) before the merge step's own name ever does, so indexOf on
// THAT literal would anchor on the wrong occurrence. `report.finish('merge'`
// is not reused that way — it names the merge step's own completion, and
// nothing else in the file happens to contain that exact substring — so a
// plain lastIndexOf on it is safe here.
test('quaude-fuse plans compile/assets AFTER merge finishes, in the SOURCE ITSELF (not just in a hand-written test double)', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  const planIdxs = [];
  for (let i = src.indexOf('report.plan('); i !== -1; i = src.indexOf('report.plan(', i + 1)) planIdxs.push(i);
  assert.strictEqual(planIdxs.length, 2,
    'expected exactly two report.plan( call sites: merge alone, then compile+assets together');
  const mergeFinishIdx = src.lastIndexOf("report.finish('merge'");
  assert.notStrictEqual(mergeFinishIdx, -1, "report.finish('merge' must appear literally");
  assert.ok(planIdxs[1] > mergeFinishIdx,
    "the SECOND report.plan( (compile/assets) must appear AFTER report.finish('merge') in the source — "
    + 'planning them from the pre-merge doc.order.length would silently under-declare a total that the '
    + 'in-worker merge fallback then grows past, tripping the over-report mismatch (see the regression-proof '
    + 'test above for what that looked like)');
});

test('the worker declares compile, assets and merge as named steps', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  for (const name of ['compile', 'assets', 'merge']) {
    assert.match(src, new RegExp(`['"\`]${name}['"\`]`), `step '${name}' must be declared by name`);
  }
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
