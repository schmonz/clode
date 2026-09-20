'use strict';
// The per-leg reproducibility verdict manifest, its shape rules, its ratchet, and the
// judgement that turns a real double-build observation into a pass or a finding.
//
// THE RED THIS FILE OWES. A reproducibility gate that cannot go red is worthless — this
// repo has found ~11 gates that could not fail. So every rule below is exercised against
// an input that MUST trip it, and the two guards carry positive controls through
// test/guard.cjs. The headline one: a leg recorded `reproducible` whose double-build comes
// back differing is a FINDING, not a shrug.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  VERDICTS, REPRODUCIBLE, KNOWN_NOT_REPRODUCIBLE, UNPROVEN, VERDICT_RANK,
  REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE,
  scanManifestShape, scanCoverage, ratchetVerdicts, judgeObservation, countByVerdict,
  manifestShapeGuard, coverageGuard, ratchetGuard,
} = require('./repro-verdicts.cjs');
const { guardTests } = require('./guard.cjs');

guardTests(manifestShapeGuard);
guardTests(coverageGuard);
guardTests(ratchetGuard);

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
