#!/usr/bin/env node
// The fidelity ledger, as a REPORT. Deliberately never fails: the right response
// to stale or missing evidence is usually to re-drive it, and a hard gate would
// punish shipping unrelated changes. Ambient redness is how a real P0 goes
// unnoticed (memory: silently-gated-tests-hide-p0s), so this stays a report by
// design — see Step 4 below and process.exit(0) at the bottom.
//
// MAINTAINER RULING 2026-08-04 changed what this report must show: tier 1 is
// now STRICT (all six FLOOR_ROWS green, no partial credit), and as of this
// writing every one of the 47 published run-targets is tier 0. A flat
// tier-grouped dump would print one 47-long list of identical tier-0 rows and
// convey nothing. The gradient that actually exists lives in PARTIAL floor
// coverage (derived from test/fidelity/RESULTS.md via floorCoverage()), so
// this report surfaces that within each tier: covered run-targets sorted by
// coverage descending with their provenance, and the (currently large) group
// of zero-coverage run-targets summarized as a count instead of one row each.
import { publishedRunTargets, fidelityFor, floorCoverage, FLOOR_ROWS } from './tjs-legs.mjs';

const NAMES = { 0: 'built', 1: 'floor', 2: 'daily' };

const rows = publishedRunTargets().map((rt) => {
  const fidelity = fidelityFor(rt); // never null — invariant in test/tjs-legs.test.cjs
  const { green, missing } = floorCoverage(rt);
  return { rt, ...fidelity, green, missing };
});

const byTier = { 0: [], 1: [], 2: [] };
for (const r of rows) byTier[r.tier].push(r);

for (const tier of [2, 1, 0]) {
  const list = byTier[tier];
  console.log(`\ntier ${tier} (${NAMES[tier]}) — ${list.length}`);

  const covered = list
    .filter((r) => r.green.length > 0)
    .sort((a, b) => b.green.length - a.green.length || a.rt.localeCompare(b.rt));
  const uncovered = list.filter((r) => r.green.length === 0).sort((a, b) => a.rt.localeCompare(b.rt));

  for (const r of covered) {
    const prov = r.date ? `  ${r.date}  bundle ${r.bundle}  via ${r.how}` : '';
    console.log(
      `  ${r.rt.padEnd(22)}floor ${r.green.length}/${FLOOR_ROWS.length} (${r.green.join(',')})  `
      + `missing ${r.missing.join(',')}${prov}`,
    );
    if (r.note) console.log(`      note: ${r.note}`);
  }
  if (uncovered.length) {
    console.log(`  ${uncovered.length} with zero floor coverage: ${uncovered.map((r) => r.rt).join(', ')}`);
  }
}

const tier1plus = rows.filter((r) => r.tier >= 1);
const anyCoverage = rows.filter((r) => r.green.length > 0);

console.log(`\n${tier1plus.length} of ${rows.length} run-targets are tier 1 or better.`);
console.log(
  `${anyCoverage.length} of ${rows.length} run-targets have ANY floor coverage `
  + `(at least one of ${FLOOR_ROWS.join(',')} green) — that is the leading edge, not the bar.`,
);

if (anyCoverage.length) {
  const missingEverywhere = FLOOR_ROWS.filter((row) => anyCoverage.every((r) => r.missing.includes(row)));
  if (missingEverywhere.length) {
    console.log(
      `Missing on EVERY run-target that has any coverage: ${missingEverywhere.join(', ')} — `
      + `the gap between our best-covered platform and a defensible tier-1 claim.`,
    );
  }
}

// Always exit 0: staleness and gaps are surfaced here, never gated. A hard
// failure would punish shipping unrelated changes, and this repo has already
// learned (memory: ci-job-is-to-tell-the-truth, silently-gated-tests-hide-p0s)
// that ambient redness — not an honest report — is how a real P0 hides.
process.exit(0);
