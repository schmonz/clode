'use strict';
// The fuse worker's half of the SCC merge (design memo:
// docs/superpowers/specs/2026-08-28-cyclic-scc-merge-design.md). These are SOURCE assertions,
// not behavioural ones: the behaviour needs a tjs engine, a staged 50MB graph and minutes,
// which belongs in the acceptance build, not in `node --test`. What a source assertion CAN do
// cheaply is stop the four ways this wiring silently reverts to a no-op.
//
// TASK 7: the merge driver call, the moduleMeta guard and the merger-version cache keying all
// moved OUT of this file and into scripts/merge-step.mjs (a protocol-only component — see
// test/merge-step.test.cjs, which now carries the assertions that used to live here against
// quaude-fuse.js's own source). What stays true of quaude-fuse.js itself is narrower: it
// recognises an already-merged staged graph (so it does not even bother spawning work for it —
// no, it still spawns, but skips applying anything back), it does no merge work when there are
// no cyclic requires, and it reaches the merge ONLY by spawning scripts/merge-step.mjs — never
// by calling the driver directly.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.join(__dirname, '..');

// PURE: every check is a presence/absence assertion against the already-read
// quaude-fuse.js source.
function scanFuseMergeWiring({ src }) {
  const findings = [];
  let examined = 0;

  // The merge now happens at STAGING (libexec/clode-extract.cjs) OR, for a doc staged before
  // that moved, inside scripts/merge-step.mjs — either way the staged graph both targets
  // consume ends up merged before this worker's compile step ever runs.
  examined++;
  if (!/merge-step\.mjs/.test(src)) findings.push('must spawn the protocol-only merge component (merge-step.mjs)');
  examined++;
  if (!/tjs\.spawn\(/.test(src)) findings.push('the merge must be a real subprocess (tjs.spawn), not an in-process call');
  examined++;
  if (/scc\.mergeCyclicGroups\(/.test(src)) {
    findings.push('the driver call belongs to scripts/merge-step.mjs alone — a second copy (or a '
      + 'direct call) here is exactly the drift that let a quaude work while every naude and '
      + 'oracle did not');
  }
  examined++;
  if (/merger\.mergeGroup\(/.test(src)) findings.push('the merge loop must live in libexec/graph-scc-merge.cjs only');

  examined++;
  if (!/term_signal/.test(src)) findings.push('must check tjs\'s STRING term_signal — a killed child is not exit 0');
  examined++;
  if (!/exit_status/.test(src)) findings.push('must check exit_status explicitly too');

  examined++;
  if (!/doc\.sccMerge/.test(src)) findings.push('must recognise an already-merged staged graph (doc.sccMerge)');

  examined++;
  if (!/cyclicRequires\s*\|\|\s*\[\]/.test(src)) findings.push('absent and empty cyclicRequires must both be a no-op');

  examined++;
  if (!/graph-merged\.json/.test(src)) findings.push('must read the merge result back from the same cache filename merge-step.mjs writes');

  return { findings, examined };
}

const guard = defineGuard({
  name: 'quaude-fuse-merge-wiring',
  read: () => ({ src: fs.readFileSync(path.join(REPO, 'libexec', 'quaude-fuse.js'), 'utf8') }),
  scan: scanFuseMergeWiring,
  // Models the real regression this guards against: a direct driver call
  // reintroduced (the exact drift that let a quaude work while naude/oracles
  // did not), alongside every other marker missing.
  control: () => ({ src: 'scc.mergeCyclicGroups(doc); merger.mergeGroup(g);' }),
});
guardTests(guard);
