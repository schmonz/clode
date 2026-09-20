'use strict';
// The per-leg reproducibility verdict manifest, its shape rules, its ratchet, and the
// judgement that turns a real double-build observation into a pass or a finding.
//
// THE RED THIS FILE OWES. A reproducibility gate that cannot go red is worthless — this
// repo has found ~11 gates that could not fail. So every rule below is exercised against
// an input that MUST trip it, and the four guards carry positive controls through
// test/guard.cjs. The headline one: a leg recorded `reproducible` whose double-build comes
// back differing is a FINDING, not a shrug.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  VERDICTS, REPRODUCIBLE, KNOWN_NOT_REPRODUCIBLE, UNPROVEN, VERDICT_RANK,
  REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE,
  scanManifestShape, scanCoverage, ratchetVerdicts, judgeObservation, countByVerdict,
  scanScheduling, legNamesFromManifest, ciLegRecords, nonNativeMechanism, tooSlow,
} = require('./repro-verdicts.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// ---- THE FOUR STANDING GUARDS -----------------------------------------------------------
//
// Defined HERE and not in test/repro-verdicts.cjs: test/guards-population.cjs's classifier
// defines "registers a guard" as a file that destructures defineGuard from guard.cjs AND
// calls it directly, and its header records the constraint explicitly ("not a shared factory
// function migrated files merely call into"). A guard defined in the module and re-exported
// would leave this file counted as unmigrated — the ratchet would be right and the code
// wrong. It also keeps node:test out of the module's require graph, which matters because
// that module is also the CLI .github/workflows/repro.yml calls.

const manifestShapeGuard = defineGuard({
  name: 'repro-verdict-manifest-shape',
  read: () => ({ verdicts: VERDICTS }),
  scan: scanManifestShape,
  floor: 44,
  // Every rule at once: an unknown verdict, a reproducible entry with no proof at the wrong
  // grain, a known-not with no reason, and an unproven with no because.
  control: () => ({ verdicts: {
    'a-leg': { verdict: 'probably-fine', cadence: 'weekly' },
    'b-leg': { verdict: REPRODUCIBLE, grain: 'archive', cadence: 'weekly', proofs: [], evidence: '' },
    'c-leg': { verdict: KNOWN_NOT_REPRODUCIBLE, grain: 'mechanism', cadence: 'on-demand' },
    'd-leg': { verdict: UNPROVEN, grain: 'none', cadence: 'none' },
  } }),
});

const coverageGuard = defineGuard({
  name: 'repro-verdict-covers-every-leg',
  read: () => ({ legNames: legNamesFromManifest(), verdicts: VERDICTS, ciRecords: ciLegRecords() }),
  scan: scanCoverage,
  floor: 44,
  // Three violations at once: a new leg with no verdict, a verdict for a leg that no longer
  // exists, and a leg SCHEDULED that the runner cannot honestly build.
  control: () => ({ legNames: ['darwin-arm64', 'a-brand-new-leg'],
    ciRecords: new Map([['netbsd-m68k', { leg: 'netbsd-m68k', os: 'ubuntu-latest', 'netbsd-src': 'netbsd-10' }]]),
    verdicts: { 'darwin-arm64': VERDICTS['darwin-arm64'], 'a-retired-leg': tooSlow('gone'),
      'netbsd-m68k': { verdict: UNPROVEN, grain: 'none', cadence: 'weekly', because: 'x' } } }),
});

const ratchetGuard = defineGuard({
  name: 'repro-verdict-ratchet',
  read: () => ({ counts: countByVerdict(VERDICTS),
    reproducibleBaseline: REPRODUCIBLE_BASELINE, unprovenBaseline: UNPROVEN_BASELINE }),
  scan: ({ counts, reproducibleBaseline, unprovenBaseline }) => {
    const r = ratchetVerdicts(counts, reproducibleBaseline, unprovenBaseline);
    // Two facts examined: the reproducible floor and the unproven ceiling.
    return { findings: r.ok ? [] : [r.message], examined: 2 };
  },
  floor: 2,
  // A manifest that lost a reproducible leg: the demotion the ratchet exists to catch.
  control: () => ({ counts: { [REPRODUCIBLE]: 0, [KNOWN_NOT_REPRODUCIBLE]: 2, [UNPROVEN]: 42 },
    reproducibleBaseline: REPRODUCIBLE_BASELINE, unprovenBaseline: UNPROVEN_BASELINE }),
});

const schedulingGuard = defineGuard({
  name: 'repro-gate-is-actually-scheduled',
  read: () => ({
    workflow: require('node:fs').readFileSync(
      path.join(REPO, '.github/workflows/repro.yml'), 'utf8'),
    verdicts: VERDICTS,
  }),
  scan: scanScheduling,
  floor: 5,
  // The shape this repo already shipped once: an opt-in gate with no schedule, no
  // invocation, a hand-typed matrix, feedback-style cancellation, and nothing marked weekly.
  control: () => ({ workflow: 'name: repro\non: workflow_dispatch: {}\n'
    + 'concurrency:\n  cancel-in-progress: true\n', verdicts: {} }),
});


guardTests(manifestShapeGuard);
guardTests(coverageGuard);
guardTests(ratchetGuard);
guardTests(schedulingGuard);

// ---- the states, and the direction that counts as improvement ----------------------

test('the verdict states rank unproven < known-not-reproducible < reproducible', () => {
  // KNOWING a leg is broken outranks never having looked: a recorded failure carries a
  // reason and a named fix, and it is what stops someone re-deriving it next quarter.
  assert.ok(VERDICT_RANK[UNPROVEN] < VERDICT_RANK[KNOWN_NOT_REPRODUCIBLE]);
  assert.ok(VERDICT_RANK[KNOWN_NOT_REPRODUCIBLE] < VERDICT_RANK[REPRODUCIBLE]);
});

// ---- shape rules: a manifest entry cannot claim more than it measured ---------------

test('a `reproducible` entry with NO proof is a finding', () => {
  const r = scanManifestShape({ verdicts: { 'some-leg': {
    verdict: REPRODUCIBLE, grain: 'whole-binary', cadence: 'weekly', proofs: [], evidence: 'trust me',
  } } });
  assert.ok(r.findings.some((f) => /proof/i.test(f)), JSON.stringify(r.findings));
});

test('a `reproducible` entry proven only at ARCHIVE grain is a finding', () => {
  // Exactly the NetBSD situation: `ar qcD` + `ranlib -D` was proven deterministic on a
  // live guest, and that is an archive-grain fact. It does NOT make the leg's ENGINE
  // reproducible, and recording it as if it did is how this manifest would start lying.
  const r = scanManifestShape({ verdicts: { 'some-leg': {
    verdict: REPRODUCIBLE, grain: 'archive', cadence: 'weekly',
    proofs: [{ sha256: 'a'.repeat(64), bytes: 10, date: '2026-09-19', where: 'a guest' }],
    evidence: 'ar qcD twice, identical',
  } } });
  assert.ok(r.findings.some((f) => /whole-binary/.test(f)), JSON.stringify(r.findings));
});

test('a `known-not-reproducible` entry must name the reason AND what would fix it', () => {
  const r = scanManifestShape({ verdicts: { 'some-leg': {
    verdict: KNOWN_NOT_REPRODUCIBLE, grain: 'mechanism', cadence: 'on-demand',
    measured: '2026-09-20', evidence: 'CI log says so',
  } } });
  assert.ok(r.findings.some((f) => /reason/.test(f)), JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => /wouldFix/.test(f)), JSON.stringify(r.findings));
});

test('an `unproven` entry must say WHY it has not been measured', () => {
  const r = scanManifestShape({ verdicts: { 'some-leg': { verdict: UNPROVEN, cadence: 'none' } } });
  assert.ok(r.findings.some((f) => /because/.test(f)), JSON.stringify(r.findings));
});

test('an `unproven` entry may not carry proofs — that is a contradiction, not a note', () => {
  const r = scanManifestShape({ verdicts: { 'some-leg': {
    verdict: UNPROVEN, cadence: 'none', because: 'too slow',
    proofs: [{ sha256: 'a'.repeat(64), bytes: 10, date: '2026-09-20', where: 'here' }],
  } } });
  assert.ok(r.findings.some((f) => /proof/i.test(f)), JSON.stringify(r.findings));
});

test('an unknown verdict string is a finding, not an unrecognised-but-tolerated value', () => {
  const r = scanManifestShape({ verdicts: { 'some-leg': { verdict: 'probably-fine', cadence: 'none' } } });
  assert.ok(r.findings.some((f) => /probably-fine/.test(f)), JSON.stringify(r.findings));
});

test('a too-short or non-hex sha256 in a proof is a finding', () => {
  // The floor is 8 hex characters, not 64, ON PURPOSE: the linux-x64-glibc measurement
  // that seeds this manifest was recorded in BACKLOG.md as `648221ea...` and nothing
  // longer survives. Demanding a full digest would force whoever seeds an old measurement
  // to either fabricate 56 characters or drop a real proof — both worse than a prefix.
  for (const bad of ['dead', 'nothexx!', '']) {
    const r = scanManifestShape({ verdicts: { 'some-leg': {
      verdict: REPRODUCIBLE, grain: 'whole-binary', cadence: 'weekly', evidence: 'x',
      proofs: [{ sha256: bad, bytes: 10, date: '2026-09-20', where: 'here' }],
    } } });
    assert.ok(r.findings.some((f) => /sha256/.test(f)), `${JSON.stringify(bad)}: ${JSON.stringify(r.findings)}`);
  }
});

test('the real manifest passes its own shape rules', () => {
  const r = scanManifestShape({ verdicts: VERDICTS });
  assert.deepStrictEqual(r.findings, []);
  assert.ok(r.examined >= 40, `examined only ${r.examined}`);
});

// ---- coverage: derived from the leg manifest, never hand-listed ---------------------

test('a leg with no verdict entry is a finding', () => {
  const r = scanCoverage({ legNames: ['a', 'b'], verdicts: { a: { verdict: UNPROVEN } } });
  assert.ok(r.findings.some((f) => /\bb\b/.test(f) && /no reproducibility verdict/.test(f)),
    JSON.stringify(r.findings));
});

test('a verdict entry for a leg that no longer exists is a finding', () => {
  const r = scanCoverage({ legNames: ['a'], verdicts: { a: { verdict: UNPROVEN }, gone: { verdict: UNPROVEN } } });
  assert.ok(r.findings.some((f) => /gone/.test(f)), JSON.stringify(r.findings));
});

// ---- the RATCHET: a leg may only move in the improving direction -------------------

test('RATCHET RED: demoting a `reproducible` leg without re-cutting the baseline fails', () => {
  const demoted = { ...VERDICTS, 'darwin-arm64': { verdict: UNPROVEN, cadence: 'none', because: 'shhh' } };
  const r = ratchetVerdicts(countByVerdict(demoted), REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /BELOW the recorded baseline/);
});

test('RATCHET RED: quietly widening `unproven` past its baseline fails', () => {
  const widened = { ...VERDICTS };
  widened['windows-amd64'] = { verdict: UNPROVEN, cadence: 'none', because: 'hard' };
  widened['windows-arm64'] = { verdict: UNPROVEN, cadence: 'none', because: 'hard' };
  const r = ratchetVerdicts(countByVerdict(widened), REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /ABOVE the recorded baseline/);
});

test('RATCHET: improvement passes, and SAYS to re-cut so it cannot drift stale', () => {
  const r = ratchetVerdicts({ [REPRODUCIBLE]: REPRODUCIBLE_BASELINE + 1,
    [KNOWN_NOT_REPRODUCIBLE]: 2, [UNPROVEN]: UNPROVEN_BASELINE - 1 },
  REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE);
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /re-cut|Progress/i);
});

test('the real manifest matches both recorded baselines', () => {
  const r = ratchetVerdicts(countByVerdict(VERDICTS), REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE);
  assert.strictEqual(r.ok, true, r.message);
});

// ---- judgeObservation: what a REAL double-build result means for a recorded verdict --

const IDENTICAL = { identical: true, sha256: 'b'.repeat(64), bytes: 8_191_584, summary: 'identical' };
const DIFFERS = { identical: false, shaA: 'a'.repeat(64), shaB: 'c'.repeat(64), bytes: 8_191_584,
  differingBytes: 571, firstDifferingOffset: 4096, summary: 'DIFFERS: 571 bytes', differingObjects: [] };

test('THE HEADLINE RED: a `reproducible` leg that stops being reproducible is a FINDING', () => {
  const r = judgeObservation(VERDICTS['darwin-arm64'], DIFFERS);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /REGRESSION/);
});

test('a `reproducible` leg that still reproduces passes', () => {
  const r = judgeObservation(VERDICTS['darwin-arm64'], IDENTICAL);
  assert.strictEqual(r.ok, true, r.message);
});

test('an `unproven` leg measured as DIFFERING is a finding that says to record it', () => {
  const r = judgeObservation(VERDICTS['netbsd-amd64'], DIFFERS);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /known-not-reproducible/);
});

test('an `unproven` leg measured as IDENTICAL passes, and says to promote it', () => {
  const r = judgeObservation(VERDICTS['netbsd-amd64'], IDENTICAL);
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /promote/i);
});

test('a `known-not-reproducible` leg that now reproduces passes, and says to promote it', () => {
  const r = judgeObservation(VERDICTS['windows-amd64'], IDENTICAL);
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /promote/i);
});

test('a `known-not-reproducible` leg that still differs passes, unchanged', () => {
  const r = judgeObservation(VERDICTS['windows-amd64'], DIFFERS);
  assert.strictEqual(r.ok, true, r.message);
});

// ---- the work-count floor outranks EVERY verdict --------------------------------------
//
// A run that compared two builds neither of which compiled anything is not evidence about
// any leg, whatever that leg is recorded as. The three cases below are the three recorded
// verdicts; missing one would leave a state where a vacuous run still votes.

const VACUOUS = { identical: true, sha256: 'b'.repeat(64), bytes: 8_191_584,
  summary: 'identical', insufficientWork: 'phase b wrote 0 of 372 object file(s)' };

test('an insufficient-work run FAILS for a `reproducible` leg, instead of confirming it', () => {
  const r = judgeObservation(VERDICTS['darwin-arm64'], VACUOUS);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /INSUFFICIENT WORK/);
  assert.doesNotMatch(r.message, /still reproducing/,
    'the most confident sentence in this file must not be attached to the least evidence');
});

test('an insufficient-work run FAILS for an `unproven` leg, instead of promoting it', () => {
  const r = judgeObservation(VERDICTS['netbsd-amd64'], VACUOUS);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /INSUFFICIENT WORK/);
  assert.doesNotMatch(r.message, /Promote/,
    'promoting a leg to `reproducible` on a run that compiled nothing is how a manifest '
    + 'starts lying');
});

test('an insufficient-work run FAILS for a `known-not-reproducible` leg too', () => {
  const r = judgeObservation(VERDICTS['windows-amd64'], VACUOUS);
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /INSUFFICIENT WORK/);
});

test('judgeObservation REFUSES an unknown leg rather than silently passing it', () => {
  assert.throws(() => judgeObservation(undefined, IDENTICAL), /no reproducibility verdict/,
    'a runner pointed at a leg the manifest has never heard of must stop, not report OK');
});

// ---- the seeded state, pinned so a silent edit is visible ---------------------------

test('SEEDED: only the legs actually measured claim `reproducible`', () => {
  const proven = Object.entries(VERDICTS)
    .filter(([, v]) => v.verdict === REPRODUCIBLE).map(([k]) => k).sort();
  assert.deepStrictEqual(proven, ['darwin-arm64', 'linux-x64-glibc'],
    'darwin-arm64 and linux-x64-glibc are the ONLY two legs anyone has double-built. '
    + 'Adding a name here without a proof entry measured on that leg is the exact thing '
    + 'this manifest exists to prevent.');
});

test('SEEDED: both Windows legs are known-not-reproducible, for the lib.exe reason', () => {
  for (const leg of ['windows-amd64', 'windows-arm64']) {
    assert.strictEqual(VERDICTS[leg].verdict, KNOWN_NOT_REPRODUCIBLE);
    assert.match(VERDICTS[leg].reason, /lib\.exe/);
    assert.match(VERDICTS[leg].wouldFix, /\/Brepro/);
  }
});

test('SEEDED: every leg too slow to double-build says SO, in its own `because`', () => {
  // The honesty clause. A leg nobody can afford to measure must carry the cost as its
  // stated reason — "unproven" with no reason reads as "not got round to it", which sends
  // the next person to run a four-hour job that was never going to be scheduled.
  const slow = Object.entries(VERDICTS).filter(([, v]) => v.cadence === 'none'
    && v.verdict === UNPROVEN && /too slow/.test(v.because || ''));
  assert.ok(slow.length >= 20, `only ${slow.length} legs record the cost as their reason`);
});

// ---- the runner can only honestly measure a NATIVELY built leg -----------------------
//
// THE LIE THIS REFUSES. test/repro-double-build.cjs drives scripts/build-tjs.cjs natively
// on whatever host the job runs on. It does not start a VM, enter an alpine container,
// build an osxcross image or bake inside a qemu guest — each of which is how some leg's
// engine is really produced. Point it at netbsd-m68k on an ubuntu box and it will happily
// double-build the UBUNTU engine and record the verdict under `netbsd-m68k`. An untrue
// verdict is worse than no verdict, so this is a refusal keyed on the leg record's own
// orchestration fields, not on a hand-kept list of names.

const { matrixFor, matrixForLegs } = require('./repro-verdicts.cjs');

test('nonNativeMechanism names the FIELD that makes a leg non-native', () => {
  assert.strictEqual(nonNativeMechanism({ leg: 'x' }), null);
  assert.strictEqual(nonNativeMechanism({ 'guest-platform': 'netbsd' }), 'guest-platform');
  assert.strictEqual(nonNativeMechanism({ 'cross-dockerfile': 'ci/osxcross-darwin' }), 'cross-dockerfile');
  assert.strictEqual(nonNativeMechanism({ 'netbsd-src': 'netbsd-10' }), 'netbsd-src');
  assert.strictEqual(nonNativeMechanism({ cosmo: true }), 'cosmo');
});

test('RED: asking for a cross leg in the matrix is REFUSED, not silently mislabelled', () => {
  assert.throws(() => matrixForLegs(['netbsd-m68k'], 'test'), /NOT built\s+natively|NOT built natively/);
  assert.throws(() => matrixForLegs(['linux-x64-musl'], 'test'), /guest-platform/);
  assert.throws(() => matrixForLegs(['cosmo'], 'test'), /cosmo/);
});

test('RED: a leg with no verdict cannot be scheduled at all', () => {
  assert.throws(() => matrixForLegs(['not-a-leg'], 'test'), /no reproducibility verdict/);
});

test('the weekly matrix is non-empty and every entry is natively buildable', () => {
  const m = matrixFor('weekly');
  assert.ok(m.length >= 3, `weekly matrix has only ${m.length} leg(s) — a gate that runs `
    + 'nowhere is not a gate');
  assert.deepStrictEqual(m.map((e) => e.leg),
    ['darwin-arm64', 'linux-arm64-glibc', 'linux-x64-glibc']);
  for (const e of m) assert.ok(e.os, `${e.leg} has no runner image`);
});

test('the on-demand matrix resolves too, so workflow_dispatch cannot fail on a bad list', () => {
  assert.deepStrictEqual(matrixFor('on-demand').map((e) => e.leg),
    ['windows-amd64', 'windows-arm64']);
});

// ---- the scheduling promise ----------------------------------------------------------

test('RED: a weekly cadence with no cron anywhere is a finding', () => {
  const r = scanScheduling({
    workflow: 'name: repro\non:\n  workflow_dispatch: {}\n'
      + 'jobs:\n  x:\n    steps:\n      - run: node test/repro-double-build.cjs --leg a\n'
      + '      - run: node test/repro-verdicts.cjs --matrix weekly\n',
    verdicts: { a: { cadence: 'weekly' } },
  });
  assert.ok(r.findings.some((f) => /cron/.test(f)), JSON.stringify(r.findings));
});

test('RED: a workflow that schedules but never invokes the runner is a finding', () => {
  const r = scanScheduling({
    workflow: "on:\n  schedule:\n    - cron: '0 0 * * 1'\n"
      + '      - run: node test/repro-verdicts.cjs --matrix weekly\n',
    verdicts: { a: { cadence: 'weekly' } },
  });
  assert.ok(r.findings.some((f) => /measures nothing/.test(f)), JSON.stringify(r.findings));
});

test('the real workflow keeps the promise the manifest makes', () => {
  const r = scanScheduling({
    workflow: fs.readFileSync(path.join(REPO, '.github/workflows/repro.yml'), 'utf8'),
    verdicts: VERDICTS,
  });
  assert.deepStrictEqual(r.findings, []);
});
