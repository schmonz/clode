'use strict';
// The libexec files whose bytes shape a staged artifact: the extractor, the two mergers, and every libexec file
// they reach by a static `require('./x')` (libexec/clode-extract.cjs extractorSigOf hashes them; see there for why
// the list is derived). A module of its own because it only READS: it derives a list and never refuses.
const fs = require('node:fs');
const path = require('node:path');

const EXTRACTOR_ROOTS = ['extract-claude-js.cjs', 'scc-merge.cjs', 'graph-scc-merge.cjs'];

function extractorSourcesOf(libexec) {
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    let src;
    try { src = fs.readFileSync(path.join(libexec, f), 'utf8'); } catch { return; }
    const re = /\brequire\('\.\/([\w.-]+\.c?js)'\)/g;
    let m;
    while ((m = re.exec(src))) visit(m[1]);
  };
  EXTRACTOR_ROOTS.forEach(visit);
  return [...EXTRACTOR_ROOTS, ...[...seen].filter((f) => !EXTRACTOR_ROOTS.includes(f)).sort()];
}

module.exports = { EXTRACTOR_ROOTS, extractorSourcesOf };
