#!/usr/bin/env node
// Regenerate test/golden-mock-shas.json from the self-contained mock bundle.
//
// Run AFTER an INTENTIONAL change to the JS extractor/inspector output:
//   node test/update-mock-golden.cjs
// then review `git diff test/golden-mock-shas.json`.
//
// Uses the SAME compute as test/regression.test.cjs (test/mock-bundle.cjs -> mockShas),
// so a clean run with unchanged tools reproduces the manifest byte-for-byte. Unlike the
// provider-based manifest, this needs no provider binaries — it always runs.
const fs = require('node:fs');
const path = require('node:path');
const { mockShas } = require('./mock-bundle.cjs');

const MANIFEST_PATH = path.join(__dirname, 'golden-mock-shas.json');
const shas = mockShas();
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(shas, null, 2) + '\n');
console.error(`[update-mock-golden] cli_sha256=${shas.cli_sha256}`);
console.error(`[update-mock-golden] inspect_json_sha256=${shas.inspect_json_sha256}`);
console.error(`[update-mock-golden] wrote ${MANIFEST_PATH}`);
