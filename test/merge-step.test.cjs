'use strict';
// scripts/merge-step.mjs — the cyclic-group merge extracted as a protocol-only component
// (Task 7 of docs/superpowers/plans/2026-09-02-phase2-name-the-steps.md). SOURCE assertions
// only, same posture as test/quaude-fuse-merge.test.cjs and test/quaude-fuse-report.test.cjs:
// the actual merge behaviour needs a tjs engine, a staged 50MB graph and minutes, which
// belongs in a real build, not `node --test` (see task-7-report.md for that real-data proof —
// the pre-extraction algorithm and merge-step.mjs were run against the SAME real 2.1.251 graph
// and produced byte-identical order + sources).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tjsPath, isApeFile, wantsTrampoline } = require('./node-shim-helper.cjs');
const { parse } = require('../libexec/build-report.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

// PURE: every check below is a presence/absence assertion against the two
// already-read source files (merge-step.mjs itself, and build-report.cjs).
function scanMergeStepWiring({ src, buildReportSrc }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/Usage/i.test(src.slice(0, 1200))) {
    findings.push('merge-step.mjs does not document an argv contract at the top of the file '
      + '(no "Usage" in the first 1200 bytes)');
  }

  // Points at merge-step.mjs itself, NOT libexec/quaude-fuse.js. The precise mustRead(...)
  // call, not a bare substring, so a comment mentioning scc-merge.cjs elsewhere cannot
  // satisfy it.
  examined++;
  if (!/mustRead\(path\.join\(libexecDir, 'scc-merge\.cjs'\)/.test(src)) {
    findings.push('the cache key no longer derives from the merger source via mustRead(...) '
      + "against the actual libexec/scc-merge.cjs — it may be reading the wrong file or "
      + 'inlining a literal');
  }

  examined++;
  if (!/graph-scc-merge\.cjs/.test(src)) findings.push('must load the shared merge driver (graph-scc-merge.cjs)');
  examined++;
  if (!/scc\.mergeCyclicGroups\(/.test(src)) findings.push('must call the shared driver (scc.mergeCyclicGroups)');
  examined++;
  if (/merger\.mergeGroup\(/.test(src)) {
    findings.push('the merge loop must live in libexec/graph-scc-merge.cjs only — a second copy '
      + 'here is exactly the drift that let a quaude work while every naude and oracle did not');
  }

  examined++;
  if (!/doc\.sccMerge/.test(src)) findings.push('must recognise an already-merged staged graph (doc.sccMerge)');

  examined++;
  if (!/does not report moduleMeta/.test(src)) findings.push('must refuse an engine without moduleMeta (the binding is required, not guessed)');

  examined++;
  if (!/CLODE_ALLOW_CYCLIC_REQUIRES/.test(src)) findings.push('must still honour the named escape hatch CLODE_ALLOW_CYCLIC_REQUIRES');

  // Pin the two STRUCTURAL sites by name (not just /mergerVersion|MERGER_VERSION/, which a
  // JSON field name alone can satisfy even after the value is hardcoded — see the header note).
  examined++;
  if (!/raw\.mergerVersion === merger\.MERGER_VERSION/.test(src)) {
    findings.push('the cache-read validity check must compare against merger.MERGER_VERSION, '
      + 'not a copied/inlined literal');
  }
  examined++;
  if (!/mergerVersion:\s*merger\.MERGER_VERSION,/.test(src)) {
    findings.push('the cache-write payload must record merger.MERGER_VERSION, not a '
      + 'copied/inlined literal');
  }

  examined++;
  if (!/cyclicRequires\s*\|\|\s*\[\]/.test(src)) findings.push('absent and empty cyclicRequires must both take the no-op path');

  examined++;
  if (!/graph-merged\.json/.test(src)) findings.push('must write the result to graph-merged.json (the caller\'s read-back contract)');

  examined++;
  if (/require\(/.test(buildReportSrc)) {
    findings.push('build-report.cjs must not require(...) anything: merge-step.mjs loads it '
      + 'under txiki.js, not Node');
  }

  return { findings, examined };
}

const guard = defineGuard({
  name: 'merge-step-wiring',
  // 13 fixed presence/absence checks (examined++ once per check, unconditionally). The
  // floor is the EXACT count ON PURPOSE (fix round 2, coordinator correction): floor is a
  // MINIMUM, so legitimate growth only ever raises `examined` above it — there is no
  // headroom to leave below the real count. Losing even ONE check from
  // scanMergeStepWiring is supposed to report BROKEN. A legitimate retirement drops
  // `examined`, this fires, and a human lowers the floor deliberately — that is the
  // intended path, not a bug.
  floor: 13,
  read: () => ({
    src: fs.readFileSync(require.resolve('../scripts/merge-step.mjs'), 'utf8'),
    buildReportSrc: fs.readFileSync(require.resolve('../libexec/build-report.cjs'), 'utf8'),
  }),
  scan: scanMergeStepWiring,
  // Models several of the real regressions this guard exists to catch at once:
  // a reintroduced private merge loop, a cache key not tied to the merger's own
  // version, and build-report.cjs gaining a require() (fatal under tjs).
  control: () => ({
    src: 'merger.mergeGroup(g);',
    buildReportSrc: "const x = require('node:fs');",
  }),
});
guardTests(guard);

// BEHAVIORAL, not textual: a source-text match here was satisfied by merge-step.mjs's
// OWN header comment ("Emits the `merge` step (plan/start/finish) through
// libexec/build-report.cjs on stdout", line 27) — stripping the three real
// report.plan/start/finish calls left the comment behind and the old version of this
// test 11/11 green. Run the real file under the real engine and read its actual
// stdout instead. cyclicRequires is deliberately empty (the exact no-op path: no
// staged graph, no scc-merge.cjs, no moduleMeta needed) — the plan/start/finish
// triple fires unconditionally around that branch (merge-step.mjs:90-91,251), so this
// is a real, minimal, fast proof of the protocol claim, not a proof of the merge
// compute itself (which stays the real-data proof in task-7-report.md per the file
// header above).
test('merge-step declares its own steps through the protocol (behavioral)', (t) => {
  const tjs = tjsPath();
  if (!tjs) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs)'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-step-test-'));
  const graphPath = path.join(tmp, 'graph.json');
  fs.writeFileSync(graphPath, JSON.stringify({})); // no cyclicRequires -> the no-op path
  const stageDir = path.join(tmp, 'stage');
  fs.mkdirSync(stageDir);
  const libexecDir = path.resolve(__dirname, '..', 'libexec'); // only build-report.cjs is
  // read on this path — see merge-step.mjs's argv-contract header for why the merger
  // (scc-merge.cjs etc.) is loaded only when cyclicRequires is non-empty.
  const mergeStepPath = require.resolve('../scripts/merge-step.mjs');
  const argv = ['run', mergeStepPath, graphPath, libexecDir, stageDir];
  const [cmd, finalArgv] = wantsTrampoline(process.platform, isApeFile(tjs))
    ? ['/bin/sh', ['-c', '"$@"', 'sh', tjs, ...argv]]
    : [tjs, argv];
  const r = spawnSync(cmd, finalArgv, { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0,
    `merge-step.mjs exited nonzero:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const records = r.stdout.split('\n').map(parse).filter(Boolean);
  const plan = records.find((rec) => rec.type === 'plan');
  assert.ok(plan, `no @clode-step plan record in stdout:\n${r.stdout}`);
  assert.ok(plan.steps.some((s) => s.name === 'merge'),
    `plan did not declare a 'merge' step: ${JSON.stringify(plan)}`);
  assert.ok(records.some((rec) => rec.type === 'started' && rec.name === 'merge'),
    `no started(merge) record in stdout:\n${r.stdout}`);
  assert.ok(records.some((rec) => rec.type === 'finished' && rec.name === 'merge'),
    `no finished(merge) record in stdout:\n${r.stdout}`);
});
