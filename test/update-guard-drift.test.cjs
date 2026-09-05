'use strict';
// Task 3: quaude-bootstrap.mjs cannot require('./update-guard.cjs') (it is
// compiled RAW to tjs bytecode with no local imports), so it carries an
// INLINE copy of guardVerdict. This test forces the two copies to move
// together: extract the text between the agreed
// `// >>> guardVerdict ... >>>` / `// <<< guardVerdict <<<` markers from both
// files and assert they are byte-identical (after trimming).
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const LIBEXEC = path.join(__dirname, '..', 'libexec');

// PURE: extracts the text between two named markers. Returns { text } on
// success or { error } naming what went wrong, rather than throwing — scan()
// (below) turns an error into a finding instead of an uncaught exception, so a
// missing/reordered marker in either file is reported the same way as a real
// content drift.
function extractMarked(src, name) {
  const start = new RegExp(`\\/\\/ >>> ${name}.*>>>\\s*\\n`).exec(src);
  if (!start) return { error: `missing "// >>> ${name} ... >>>" marker` };
  const startIdx = start.index + start[0].length;
  const end = new RegExp(`\\/\\/ <<< ${name} <<<`).exec(src);
  if (!end) return { error: `missing "// <<< ${name} <<<" marker` };
  if (end.index <= startIdx) return { error: 'markers out of order' };
  return { text: src.slice(startIdx, end.index).trim() };
}

const PAIRS = [
  { marker: 'guardVerdict', canonical: 'canonical', inlined: 'bootstrap',
    label: "update-guard.cjs's guardVerdict" },
  { marker: 'guardGating', canonical: 'canonical', inlined: 'bootstrap',
    label: 'update-guard.cjs guardGating' },
  { marker: 'clodeAttest', canonical: 'attest', inlined: 'bootstrap',
    label: 'clode-attest.cjs' },
];

// PURE: `sources` maps a short key (canonical/bootstrap/attest) to that
// file's already-read text.
function scanInlinedCopies({ sources }) {
  const findings = [];
  let examined = 0;
  for (const { marker, canonical, inlined, label } of PAIRS) {
    examined++;
    const c = extractMarked(sources[canonical], marker);
    const i = extractMarked(sources[inlined], marker);
    if (c.error) { findings.push(`${canonical} (${label}): ${c.error}`); continue; }
    if (i.error) { findings.push(`${inlined} (${label}): ${i.error}`); continue; }
    if (c.text !== i.text) {
      findings.push(`${inlined}'s inline copy of ${label} has drifted from the canonical source`);
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'update-guard-inline-copies',
  read: () => ({
    sources: {
      canonical: fs.readFileSync(path.join(LIBEXEC, 'update-guard.cjs'), 'utf8'),
      attest: fs.readFileSync(path.join(LIBEXEC, 'clode-attest.cjs'), 'utf8'),
      bootstrap: fs.readFileSync(path.join(LIBEXEC, 'quaude-bootstrap.mjs'), 'utf8'),
    },
  }),
  scan: scanInlinedCopies,
  // I2 (coordinator, 2026-09-04): table-driven — three fixed marked blocks compared
  // across three named files. Floored at the exact measured count (3).
  floor: 3,
  // Models the real drift risk: the bootstrap's inline copy has fallen out of
  // sync with the canonical module for all three marked blocks.
  control: () => ({
    sources: {
      canonical: '// >>> guardVerdict >>>\nCANONICAL A\n// <<< guardVerdict <<<\n'
        + '// >>> guardGating >>>\nCANONICAL B\n// <<< guardGating <<<\n',
      attest: '// >>> clodeAttest >>>\nCANONICAL C\n// <<< clodeAttest <<<\n',
      bootstrap: '// >>> guardVerdict >>>\nDRIFTED A\n// <<< guardVerdict <<<\n'
        + '// >>> guardGating >>>\nDRIFTED B\n// <<< guardGating <<<\n'
        + '// >>> clodeAttest >>>\nDRIFTED C\n// <<< clodeAttest <<<\n',
    },
  }),
});
guardTests(guard);
