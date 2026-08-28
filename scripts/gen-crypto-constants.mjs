// Emit node-shim's crypto.constants table FROM the running node, so the 55 numbers in
// libexec/node-shim/modules/crypto.cjs are transcribed by a machine rather than by hand.
//
// WHY THIS EXISTS. Platform tables (fs O_*, errno, signals) are generated because hand-
// writing them put 8 of 11 fs.O_* wrong on the BSD legs. crypto.constants escaped that
// rule on the argument that SSL constants are fixed OpenSSL numbers rather than per-
// platform ones. True, and beside the point: they are still per-VERSION (node 24.20.0
// added RSA_SSLV23_PADDING, which 24.19.0 and 26.3.0 do not have), and 52 of the 55
// values had no test looking at them at all. Fixed numbers typed by a human are still
// typed by a human.
//
//   node scripts/gen-crypto-constants.mjs           # print the table
//   node scripts/gen-crypto-constants.mjs --write   # rewrite the literal in place
//
// RUN IT UNDER THE PINNED REFERENCE NODE (.tool-versions), not whatever node is on your
// PATH — the table should mirror the node the oracle compares against, not this box.
//
// Keys the shim has that this node lacks are PRESERVED, not dropped: a superset is
// deliberate (see the value-equality test in test/node-shim-constants.test.cjs). Dropping
// them would silently narrow the surface every time someone regenerated under a newer node.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(here, '..', 'libexec', 'node-shim', 'modules', 'crypto.cjs');

const host = require('node:crypto').constants;
const existing = require(TARGET).constants;

const merged = {};
for (const k of Object.keys(host)) if (typeof host[k] === 'number') merged[k] = host[k];
const preserved = [];
for (const k of Object.keys(existing)) {
  if (!(k in merged)) { merged[k] = existing[k]; preserved.push(k); }
}

const literal = 'const constants = ' + JSON.stringify(merged) + ';';

if (!process.argv.includes('--write')) {
  console.log(literal);
  console.error(`# ${Object.keys(merged).length} constants from ${process.version}`
    + (preserved.length ? `; preserved shim-only: ${preserved.join(', ')}` : ''));
} else {
  const src = readFileSync(TARGET, 'utf8');
  const re = /^const constants = \{.*\};$/m;
  if (!re.test(src)) {
    console.error('gen-crypto-constants: could not find the `const constants = {...};` line to replace');
    process.exit(1);
  }
  writeFileSync(TARGET, src.replace(re, literal));
  console.error(`gen-crypto-constants: wrote ${Object.keys(merged).length} constants from ${process.version}`
    + (preserved.length ? `; preserved shim-only: ${preserved.join(', ')}` : ''));
}
