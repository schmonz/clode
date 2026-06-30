#!/usr/bin/env node
// Regenerate test/golden-shas.json from the present provider binaries.
//
// Run AFTER an INTENTIONAL change to the JS extractor/inspector output:
//   node test/update-golden-shas.cjs
// then review `git diff test/golden-shas.json`.
//
// Uses the SAME compute as test/regression.test.cjs (test/golden-shas-lib.cjs),
// so a clean run with unchanged tools reproduces the manifest byte-for-byte.
// Versions whose provider binary is absent keep their existing manifest entry
// (if any) so a partial provider set doesn't drop known-good shas.
const fs = require('node:fs');
const path = require('node:path');
const { VERSIONS, providerBin, shasForBinary } = require('./golden-shas-lib.cjs');

const MANIFEST_PATH = path.join(__dirname, 'golden-shas.json');
let existing = {};
try { existing = require('./golden-shas.json'); } catch { /* first run: none */ }

const out = {};
const covered = [];
const skipped = [];
for (const v of VERSIONS) {
  const bin = providerBin(v);
  if (bin) {
    out[v] = shasForBinary(bin);
    covered.push(v);
  } else if (existing[v]) {
    out[v] = existing[v];
    skipped.push(v);
  } else {
    skipped.push(v);
  }
}

// Pretty-printed with sorted keys for stable, reviewable diffs.
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n');

console.error(`[update-golden-shas] covered (recomputed): ${covered.join(', ') || '(none)'}`);
console.error(`[update-golden-shas] skipped (no provider binary): ${skipped.join(', ') || '(none)'}`);
console.error(`[update-golden-shas] wrote ${MANIFEST_PATH}`);
