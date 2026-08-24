#!/usr/bin/env node
// ci-claim-check — does a `how: 'ci'` fidelity claim still hold?
//
// THE PROBLEM THIS EXISTS FOR
//
// test/fidelity/RESULTS.md is append-only and latest-wins, which is exactly
// right for the evidence it was designed to hold: a hand-driven row is a FACT
// ABOUT THE PAST ("on 2026-08-09 a human drove D1 on real Windows and it
// passed") and stays true forever.
//
// A `how: 'ci'` row is a different animal. Its claim is present-tense and
// recurring — the build-pipeline smoke "fuses and runs a quaude ... on every
// build". The historical run it cites stays real, but the CLAIM goes false the
// moment the leg stops passing, and an append-only ledger cannot notice. That
// is not hypothetical: haiku-x64 carried a green G7 row through 14 consecutive
// red builds, because the leg died at guest package install and nothing
// existed to say so.
//
// The fact needed to catch that — "is this leg passing right now?" — is not in
// the repo and cannot be. So this check is NOT part of `npm test` (which is
// offline by design). It talks to GitHub via `gh`, and it is the only thing
// that can falsify a recurrence claim. Run it by hand, or on a schedule:
//
//     node test/fidelity/ci-claim-check.mjs            # report + exit nonzero on contradiction
//     node test/fidelity/ci-claim-check.mjs --report   # never fail; just print
//
// Its offline sibling, fidelity-notes.test.cjs, gates the other half: that the
// hand-written notes match the derived ledger. Neither subsumes the other.
//
// WHY NO CALENDAR EXPIRY. The tempting cheap version is "a CI row older than N
// days stops counting". That instrument measures elapsed days and pretends to
// measure leg health, and it is wrong in both directions: it would expire
// linux-x64-musl (green the whole time) while blessing a leg that went red the
// day after someone re-dated it. Worse, it turns `npm test` red on unrelated
// changes on a schedule nobody chose, which scripts/fidelity-ledger.mjs has
// already ruled against ("staleness and gaps are surfaced here, never gated").
// Ask the question you actually mean; do not proxy it.
import { execFileSync } from 'node:child_process';
import {
  ciClaimingRunTargets, floorCoverage, ciEvidenceRuns, legNameForRunTarget,
} from '../../scripts/tjs-legs.mjs';

const REPORT_ONLY = process.argv.includes('--report');
const SCAN = 15;   // runs of history to scan for each leg's latest decisive verdict

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function haveGh() {
  try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

if (!haveGh()) {
  console.error('ci-claim-check: `gh` not found. This check needs GitHub; there is no offline answer.');
  process.exit(2);
}

// A leg's CURRENT verdict = its conclusion in the most recent run where that
// job actually reached one. Cancelled runs are common on a busy branch (a push
// supersedes the run in flight) and say nothing about the leg, so they are
// skipped rather than counted as failures.
const DECISIVE = new Set(['success', 'failure']);

// THE GRANULARITY THAT MATTERS. "The leg is red" is NOT the same claim as "G7
// stopped happening", and conflating them makes this checker itself an
// instrument that lies. The first draft of this file did conflate them and
// promptly accused windows-arm64 of a dead G7 across 11 red runs — when its log
// plainly shows `clode: smoke: PONG round-trip ok, attest ok` and the job then
// fails in a LATER, unrelated SSE probe. The smoke ran. The row is honest. Only
// a leg that dies BEFORE the smoke (haiku-x64, which never survives guest
// package install) has actually stopped delivering G7.
//
// So the question is not the job's conclusion, it is whether the smoke got to
// print its success line — the exact line libexec/clode-fuse.cjs emits after the
// PONG round-trip that "What earns a row" #2 blesses as G7.
const SMOKE_OK = /smoke: PONG round-trip ok/;

console.error(`ci-claim-check: scanning the last ${SCAN} ci.yml runs on main ...`);
const runs = gh(['run', 'list', '--workflow', 'ci.yml', '--branch', 'main',
  '--limit', String(SCAN), '--json', 'databaseId,conclusion,createdAt,headSha']);

// leg -> { conclusion, runId, createdAt, streak } for the newest decisive verdict,
// plus how many consecutive decisive runs share that verdict (a 14-long failure
// streak is a different animal from one red run, and the distinction is the
// whole "not flaky, broken" argument).
const verdicts = new Map();
for (const run of runs) {
  let jobs;
  try { jobs = gh(['run', 'view', String(run.databaseId), '--json', 'jobs']).jobs || []; } catch { continue; }
  for (const job of jobs) {
    const m = job.name && job.name.match(/\bleg \(([a-z0-9-]+),/);
    if (!m || !DECISIVE.has(job.conclusion)) continue;
    const leg = m[1];
    const seen = verdicts.get(leg);
    if (!seen) {
      verdicts.set(leg, {
        conclusion: job.conclusion, runId: run.databaseId, createdAt: run.createdAt,
        jobId: job.databaseId, streak: 1,
      });
    } else if (seen.conclusion === job.conclusion && seen.streak >= 0) seen.streak += 1;
    else seen.streak = -Math.abs(seen.streak);   // streak broken; freeze it
  }
}

// Did the build-pipeline smoke actually reach its PONG in this job? Only asked
// of FAILING jobs — a green leg ran its smoke by definition, and pulling logs is
// slow. Returns true/false, or null when the log cannot be read (unknown is not
// evidence of absence, and must not be reported as a contradiction).
function smokeReachedPong(jobId) {
  try {
    const log = execFileSync('gh', ['run', 'view', '--job', String(jobId), '--log'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return SMOKE_OK.test(log);
  } catch {
    return null;
  }
}

const contradictions = [];
const rows = [];

for (const rt of ciClaimingRunTargets()) {
  const { green } = floorCoverage(rt);
  const leg = legNameForRunTarget(rt);
  const v = verdicts.get(leg);
  const cited = ciEvidenceRuns(rt);

  if (!green.length) {
    rows.push([rt, leg, v ? v.conclusion : 'unknown', 'claims nothing', '']);
    continue;   // a withdrawn claim cannot be contradicted
  }
  if (!v) {
    rows.push([rt, leg, 'unknown', `claims ${green.join(',')}`, 'no decisive run in scan window']);
    continue;
  }
  const detail = `cited run${cited.length === 1 ? '' : 's'} ${cited.map((c) => c.runId).join(',') || 'none'}`;
  const reds = Math.abs(v.streak);

  if (v.conclusion !== 'failure') {
    rows.push([rt, leg, v.conclusion, `claims ${green.join(',')}`, detail]);
    continue;
  }

  // Red leg. Whether that falsifies the claim depends entirely on whether the
  // smoke still ran — see SMOKE_OK above.
  const pong = smokeReachedPong(v.jobId);
  if (pong === null) {
    rows.push([rt, leg, `failure x${reds}`, `claims ${green.join(',')}`, 'log unreadable — UNVERIFIED']);
  } else if (pong) {
    rows.push([rt, leg, `failure x${reds}`, `claims ${green.join(',')}`,
      'red AFTER a passing smoke — G7 intact, leg broken elsewhere']);
  } else {
    contradictions.push(
      `${rt} (leg ${leg}): RESULTS.md records ${green.join(',')} green via how:'ci', but the leg has `
      + `failed ${reds} consecutive decisive run(s) WITHOUT the smoke ever reaching its PONG `
      + `(run ${v.runId}, ${v.createdAt}, job ${v.jobId}). ${detail}. The recurring claim is no longer `
      + `happening. Either the leg is fixed, or the claim is withdrawn with a dated row in RESULTS.md.`,
    );
    rows.push([rt, leg, `FAILURE x${reds}`, `claims ${green.join(',')}`, 'no PONG — CONTRADICTED']);
  }
}

const w = (s, n) => String(s).padEnd(n);
console.log(`\n${w('run-target', 24)}${w('leg', 20)}${w('ci now', 16)}${w('ledger', 22)}note`);
for (const r of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${w(r[0], 24)}${w(r[1], 20)}${w(r[2], 16)}${w(r[3], 22)}${r[4]}`);
}

if (!contradictions.length) {
  console.log(`\nOK: ${rows.length} how:'ci' run-target(s) checked, no claim contradicted by current CI.`);
  process.exit(0);
}

console.log(`\n${contradictions.length} CONTRADICTED fidelity claim(s):`);
for (const c of contradictions) console.log(`  - ${c}`);
console.log(
  '\nA green row for a leg that is red right now is fiction, not evidence. The ledger is\n'
  + 'append-only: withdraw the claim by APPENDING a dated `fail` row to test/fidelity/RESULTS.md\n'
  + '(latest-wins revokes the coverage automatically), then re-run this check.',
);
process.exit(REPORT_ONLY ? 0 : 1);
