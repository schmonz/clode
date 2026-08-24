'use strict';
// The fidelity NOTES gate.
//
// scripts/tjs-legs.mjs already derives floor coverage from
// test/fidelity/RESULTS.md (floorCoverage(), "derived, not declared"), and
// test/tjs-legs.test.cjs already stops a TIER from being inflated past that
// derivation. What neither of them covered is the `note` string sitting right
// beside the tier: free prose, typed by a human, summarizing the very thing the
// derivation already knows — and therefore able to say anything at all.
//
// It drifted. Twice, that we know of:
//
//   - netbsd-arm64 read "floor 2/6 green (B1,G7)" for weeks after the platform
//     had been honestly re-driven to a clean 6/6 on 2026-08-21. The note
//     understated real evidence, and it contradicted the `tier: 1` on the line
//     directly above it.
//   - haiku-x64 read "it does hold G7: the build-pipeline PONG smoke fuses and
//     runs a quaude inside the Haiku guest on every build" while the leg had
//     been failing at guest package install for 14 consecutive runs. That note
//     overstated coverage to zero-evidence, which is the dangerous direction.
//
// Both are the same defect: a hand-written claim that cannot go stale
// DETECTABLY. This test makes it detectable. A note may describe its evidence
// however it likes — that prose is the point of a note — but the machine-
// readable CLAIM inside it ("floor N/6 green (rows...)" / "zero floor
// coverage" / "... not driven") must agree exactly with what floorCoverage()
// derives from RESULTS.md.
//
// Deliberately NOT time-based. See RESULTS.md, "A `how: ci` row is a claim
// about the PRESENT": a calendar expiry measures elapsed days and pretends to
// measure leg health, and it would redden `npm test` on unrelated changes,
// which scripts/fidelity-ledger.mjs has already ruled against. Catching a leg
// that is red RIGHT NOW needs a fact that is not in the repo, so it lives in
// ci-claim-check.mjs beside this file, which is allowed to use the network.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LEGS = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'tjs-legs.mjs')).href;
const load = () => import(LEGS);

const sorted = (a) => [...a].sort();
const eq = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

test('every fidelity note states exactly the coverage RESULTS.md derives', async () => {
  const {
    publishedRunTargets, fidelityFor, floorCoverage, coverageClaim, coverageSentence,
  } = await load();

  const drift = [];
  for (const rt of publishedRunTargets()) {
    const f = fidelityFor(rt);
    const claim = coverageClaim(f.note);
    if (!claim) continue;                 // silence is allowed; a lie is not
    const { green, missing } = floorCoverage(rt);

    if (!eq(claim.rows, green)) {
      drift.push(`${rt}: note claims green [${claim.rows.join(',') || 'none'}] but RESULTS.md `
        + `derives [${green.join(',') || 'none'}] — correct prefix: "${coverageSentence(rt)}"`);
    } else if (claim.count !== green.length) {
      // Caught separately so a miscounted-but-right-rows note names its own bug.
      drift.push(`${rt}: note says ${claim.count}/6 but lists ${green.length} green rows `
        + `— correct prefix: "${coverageSentence(rt)}"`);
    }
    if (claim.missing && !eq(claim.missing, missing)) {
      drift.push(`${rt}: note's "not driven" list [${claim.missing.join(',')}] != derived missing `
        + `[${missing.join(',') || 'none'}]`);
    }
  }

  assert.deepStrictEqual(drift, [],
    'fidelity notes have drifted from the derived ledger:\n  ' + drift.join('\n  '));
});

// A note is the summary; RESULTS.md is the evidence. A note that claims green
// rows for a run-target with no rows AT ALL in RESULTS.md is citing nothing.
test('a note claiming coverage is backed by real rows in RESULTS.md', async () => {
  const { publishedRunTargets, fidelityFor, floorCoverage, coverageClaim } = await load();
  for (const rt of publishedRunTargets()) {
    const claim = coverageClaim(fidelityFor(rt).note);
    if (!claim || !claim.rows.length) continue;
    assert.ok(floorCoverage(rt).green.length > 0,
      `${rt}: note claims [${claim.rows.join(',')}] green but floorCoverage() derives nothing`);
  }
});

// The obligation that makes a recurring claim checkable at all: if a run-target
// says its evidence is CI, the rows holding up its coverage must name the
// workflow run that produced them. Without a run id, "CI ran it" is unfalsifiable
// — nobody can look it up, and ci-claim-check.mjs has nothing to resolve.
test('a how:ci claim cites the workflow run its coverage rests on', async () => {
  const { ciClaimingRunTargets, floorCoverage, ciEvidenceRuns } = await load();
  for (const rt of ciClaimingRunTargets()) {
    const { green } = floorCoverage(rt);
    if (!green.length) continue;          // nothing claimed, nothing to cite
    const runs = ciEvidenceRuns(rt);
    assert.ok(runs.length > 0,
      `${rt}: how:'ci' with green rows [${green.join(',')}] but no RESULTS.md row cites a `
      + `workflow run id. A CI claim nobody can look up cannot be re-checked when the leg breaks.`);
  }
});

// Guards the parser itself, so the gate above cannot quietly become a no-op by
// failing to recognize the very sentences it is supposed to police.
test('coverageClaim parses the note shapes actually in use', async () => {
  const { coverageClaim } = await load();

  assert.strictEqual(coverageClaim(null), null);
  assert.strictEqual(coverageClaim(''), null);
  assert.strictEqual(coverageClaim('no claim of any kind in this sentence'), null);

  const partial = coverageClaim('floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); '
    + 'A1,B1,B4,C1,D1 not driven — see RESULTS.md');
  assert.deepStrictEqual(partial.rows, ['G7']);
  assert.strictEqual(partial.count, 1);
  assert.deepStrictEqual(partial.missing, ['A1', 'B1', 'B4', 'C1', 'D1']);

  const full = coverageClaim('floor 6/6 GREEN (A1,B1,B4,C1,D1,G7) — driven on real hardware');
  assert.deepStrictEqual(full.rows, ['A1', 'B1', 'B4', 'C1', 'D1', 'G7']);
  assert.strictEqual(full.count, 6);

  const none = coverageClaim('zero floor coverage: this leg smokes --version only');
  assert.deepStrictEqual(none.rows, []);
  assert.strictEqual(none.count, 0);

  // Prose containing row-like tokens must not be mistaken for the claim itself.
  const multi = coverageClaim('floor 3/6 green (B1,C1,G7); A1,B4,D1 not driven; RECIPE G6 also OPEN');
  assert.deepStrictEqual(multi.rows, ['B1', 'C1', 'G7']);
  assert.deepStrictEqual(multi.missing, ['A1', 'B4', 'D1']);
});

// End-to-end proof that the gate has teeth: a deliberately drifted note must be
// rejected by the same comparison the first test performs. Without this, a
// regression in coverageClaim() (returning null for everything, say) would make
// the whole file pass vacuously — the "instruments lie" failure mode.
test('the gate rejects a drifted note (negative control)', async () => {
  const { coverageClaim } = await load();
  const derived = ['G7'];
  const drifted = coverageClaim('floor 6/6 GREEN (A1,B1,B4,C1,D1,G7) — wishful thinking');
  assert.ok(drifted, 'the drifted note must parse, or the gate never sees it');
  assert.ok(!eq(drifted.rows, derived),
    'a note claiming 6/6 against 1/6 of derived coverage must compare unequal');
});
