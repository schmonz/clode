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

const SRC = fs.readFileSync(require.resolve('../scripts/merge-step.mjs'), 'utf8');

test('merge-step documents an argv contract at the top of the file', () => {
  const src = fs.readFileSync(require.resolve('../scripts/merge-step.mjs'), 'utf8');
  assert.match(src.slice(0, 1200), /Usage/i, 'a program with a contract says so, like quaude-fuse.js:7-21');
});

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

// Points at merge-step.mjs itself (SRC, loaded once above) — NOT libexec/quaude-fuse.js,
// which was the wrong file: Task 7 moved the merge (and its cache-key derivation) out of
// quaude-fuse.js entirely, leaving only an unrelated carried-member-list mention of
// 'scc-merge.cjs' there. The precise mustRead(...) call, not a bare substring, so a
// comment mentioning scc-merge.cjs elsewhere in this file cannot satisfy it either.
test('the cache key still derives from the merger source, not a literal', () => {
  assert.match(SRC, /mustRead\(path\.join\(libexecDir, 'scc-merge\.cjs'\)/,
    'merge-step.mjs must load the actual merger module (libexec/scc-merge.cjs) to derive '
    + 'the cache key, not read it from the wrong file or inline a literal');
});

// The following carry forward the source assertions that used to live in
// test/quaude-fuse-merge.test.cjs against libexec/quaude-fuse.js, before Task 7 moved the
// actual merge driving logic out of it and into this file.

test('merge-step calls the shared driver, not a private copy of the merge loop', () => {
  assert.match(SRC, /graph-scc-merge\.cjs/, 'it loads the shared merge driver');
  assert.match(SRC, /scc\.mergeCyclicGroups\(/, 'it calls the shared driver');
  assert.doesNotMatch(SRC, /merger\.mergeGroup\(/,
    'the merge loop must live in libexec/graph-scc-merge.cjs only — a second copy here is '
    + 'exactly the drift that let a quaude work while every naude and oracle did not');
});

test('merge-step recognises an already-merged staged graph and does nothing to it', () => {
  assert.match(SRC, /doc\.sccMerge/);
});

// The engine binding is REQUIRED, not optional: guessing names is how a merged module silently
// shadows a binding. Same posture as the stale-engine constants gate.
test('merge-step refuses an engine without moduleMeta', () => {
  assert.match(SRC, /does not report moduleMeta/);
});

// The named escape hatch survives the extraction too — a bisect tool for separating "the merge
// is wrong" from "the graph is wrong" is worthless if only the ORIGINAL file had it.
test('merge-step still honours CLODE_ALLOW_CYCLIC_REQUIRES=0', () => {
  assert.match(SRC, /CLODE_ALLOW_CYCLIC_REQUIRES/);
});

// The cache must be invalidated when OUR merger changes, or editing scc-merge.cjs would have no
// effect on any machine that had already built once — a debugging nightmare that looks like the
// edit did nothing. /mergerVersion|MERGER_VERSION/ alone is satisfied by the JSON field name
// `mergerVersion` (merge-step.mjs:147-148,232) EVEN AFTER its right-hand side is replaced with
// the literal '12' — proven: doing exactly that (merger.MERGER_VERSION -> '12' at both sites)
// left this test 11/11 green. A bare /merger\.MERGER_VERSION/ is not enough either: the string
// also appears in two log lines (:154,:160) that survive the same mutation untouched, so it
// would still match. Pin the two STRUCTURAL sites by name: the cache-read validity check and
// the cache-write payload.
test('the merge cache is keyed on the merger version, not only the provider', () => {
  assert.match(SRC, /raw\.mergerVersion === merger\.MERGER_VERSION/,
    'the cache-read validity check must compare against the merger module\'s own '
    + 'MERGER_VERSION, not a copied/inlined literal');
  assert.match(SRC, /mergerVersion:\s*merger\.MERGER_VERSION,/,
    'the cache-write payload must record the merger module\'s own MERGER_VERSION, not a '
    + 'copied/inlined literal');
});

// A bundle with no cyclic requires must take exactly today's no-op path — merge-step.mjs is now
// the ONLY place that decides this (quaude-fuse.js always spawns it, unconditionally).
test('merge-step does no compute when there are no cyclic requires', () => {
  assert.match(SRC, /cyclicRequires\s*\|\|\s*\[\]/);
});

// Output contract: the caller (quaude-fuse.js) reads this filename back and applies it onto
// its own in-memory doc. Getting the name wrong here is silent until the very next build.
test('merge-step writes the result to graph-merged.json, the caller\'s read-back contract', () => {
  assert.match(SRC, /graph-merged\.json/);
});

test('build-report stays tjs-safe, or this script dies at runtime', () => {
  const src = fs.readFileSync(require.resolve('../libexec/build-report.cjs'), 'utf8');
  assert.strictEqual(/require\(/.test(src), false,
    'build-report.cjs must not require anything: merge-step.mjs loads it under txiki.js, not Node');
});
