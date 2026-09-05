'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const R = require('../libexec/build-report.cjs');
const { Composer } = require('../libexec/build-compose.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

// PURE: every check below is derived from the two already-read source texts
// (quaude-fuse.js and build-report.cjs).
function scanFuseReportWiring({ src, buildReportSrc }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/build-report\.cjs/.test(src)) findings.push('quaude-fuse.js must speak the protocol (no build-report.cjs reference)');
  examined++;
  if (!/Reporter/.test(src)) findings.push('quaude-fuse.js must emit through Reporter rather than ad-hoc printing');
  // require() in this worker is a loud stub that throws — there is no module resolver. It
  // must go through loadLibexecCjs, like scc-merge.cjs does.
  examined++;
  if (!/loadLibexecCjs\(\s*[\s\S]{0,200}build-report\.cjs/.test(src)) {
    findings.push('build-report.cjs must be loaded via loadLibexecCjs, not require()');
  }

  // lastIndexOf, not indexOf: 'scc-merge.cjs' appears TWICE earlier too (the loadLibexecCjs
  // call inside mergeCyclicGroups that reads and evaluates it) — indexOf would anchor on
  // that unrelated call instead of the carried-member list this check actually means to
  // check. The carried-member array is where the literal appears LAST.
  examined++;
  {
    const anchor = src.lastIndexOf("'scc-merge.cjs'");
    if (anchor === -1) {
      findings.push('quaude-fuse.js no longer mentions scc-merge.cjs at all');
    } else {
      const members = src.slice(Math.max(0, anchor - 400), anchor + 200);
      if (!/build-report\.cjs/.test(members)) {
        findings.push('build-report.cjs must be CARRIED into a fused builder — add it to the '
          + 'carried-member list beside scc-merge.cjs, or it works from a checkout and dies fused');
      }
    }
  }

  // TASK 7 moved WHO owns 'merge' out of this worker's report entirely, into
  // scripts/merge-step.mjs. This worker now has exactly ONE report.plan( call site
  // (compile+assets); the ordering property that mattered before — "compile/assets must be
  // planned from the POST-merge doc.order, not the pre-merge one" — still has to hold, it
  // just anchors on the merge SUBPROCESS having been waited on and applied.
  examined++;
  {
    const planIdxs = [];
    for (let i = src.indexOf('report.plan('); i !== -1; i = src.indexOf('report.plan(', i + 1)) planIdxs.push(i);
    if (planIdxs.length !== 1) {
      findings.push(`expected exactly one report.plan( call site (compile+assets) left in `
        + `quaude-fuse.js, found ${planIdxs.length} — 'merge' is now planned by `
        + 'scripts/merge-step.mjs, not here');
    } else {
      const mergeAppliedIdx = src.lastIndexOf('doc.order = merged.order');
      if (mergeAppliedIdx === -1) {
        findings.push('the merge subprocess result must be applied onto doc.order somewhere '
          + 'before compile/assets are planned');
      } else if (planIdxs[0] <= mergeAppliedIdx) {
        findings.push('the sole report.plan( (compile/assets) must appear AFTER the merge '
          + 'result is applied to doc.order — planning from doc.order before that silently '
          + 'under-declares a total the compile loop then exceeds');
      }
    }
  }

  examined++;
  for (const name of ['compile', 'assets']) {
    if (!new RegExp(`['"\`]${name}['"\`]`).test(src)) findings.push(`step '${name}' must be declared by name`);
  }
  if (/report\.plan\(\[\{\s*name:\s*['"`]merge['"`]/.test(src)) {
    findings.push('quaude-fuse.js must not itself plan a \'merge\' report step — that step '
      + 'belongs to scripts/merge-step.mjs alone, and a second declaration has no defined '
      + 'behaviour in build-compose.cjs');
  }

  examined++;
  if (/require\(/.test(buildReportSrc)) {
    findings.push('build-report.cjs must not require(...) anything: quaude-fuse.js loads it '
      + 'under txiki.js, not Node');
  }

  return { findings, examined };
}

const guard = defineGuard({
  name: 'quaude-fuse-report-wiring',
  read: () => ({
    src: fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8'),
    buildReportSrc: fs.readFileSync(require.resolve('../libexec/build-report.cjs'), 'utf8'),
  }),
  scan: scanFuseReportWiring,
  // Models the fix-round-1 regression the header below describes: a stale
  // pre-merge total, a re-declared 'merge' step, and no protocol wiring at all.
  control: () => ({
    src: "report.plan([{ name: 'merge', total: 1 }]); report.plan(x); report.plan(y);",
    buildReportSrc: "const x = require('node:fs');",
  }),
});
guardTests(guard);

// The guard above all match SOURCE TEXT — none exercises the actual plan/start/
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
