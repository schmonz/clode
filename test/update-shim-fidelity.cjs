#!/usr/bin/env node
'use strict';
// Regenerate test/shim-fidelity.json from the CURRENTLY INSTALLED dep versions.
//
// Run ONLY after an INTENTIONAL, reviewed dep bump (or corpus change):
//   npm ci                              # install the locked dep versions
//   node test/update-shim-fidelity.cjs  # rewrite the snapshot
// then review `git diff test/shim-fidelity.json`.
//
// Uses the SAME compute() as test/shim-fidelity.test.cjs (test/shim-fidelity-lib.cjs), so
// a clean run with unchanged deps reproduces the JSON byte-for-byte.
const fs = require('node:fs');
const path = require('node:path');
const { compute } = require('./shim-fidelity-lib.cjs');

const OUT = path.join(__dirname, 'shim-fidelity.json');
fs.writeFileSync(OUT, JSON.stringify(compute(), null, 2) + '\n');
console.error(`[update-shim-fidelity] wrote ${OUT}`);
