'use strict';
// source-scan.cjs — the two source-walking helpers every text-scanning sweep and
// build-gate guard in this repo needs, in ONE place.
//
// WHY THIS EXISTS. `stripLineComments` was duplicated VERBATIM in three files
// (test/guards-population.cjs, test/build-gates/host-provision-gates.test.cjs,
// test/build-gates/target-update-gates.test.cjs) and `discoverFilesByExt` in three,
// each copy carrying its own "mirrors the other one" comment. Three copies of an
// approximation is three places for the approximation to drift apart silently, which
// is the same class of defect these sweeps exist to catch. test/throws-as-findings.cjs
// is the precedent: a shared test-side helper, no production dependency on test/.
const fs = require('node:fs');
const path = require('node:path');

// Strip a same-line `//` comment to end-of-line, so a prose mention of a call in a
// COMMENT does not read as a real call site. The `[^:]` guard keeps `https://` inside
// a string literal alive.
//
// NOT AN AST PARSE, and the direction it fails in is stated on purpose:
//   - A `//` inside a STRING LITERAL that is not preceded by `:` (e.g.
//     `const u = "a//b"; provision('tar', o);` on one line) is treated as the start of
//     a comment, so the rest of that LINE — including a real call site — is dropped.
//     That is a FALSE NEGATIVE: the scanner sees LESS than is there, and a caller that
//     hid behind such a line would go unreported. It never invents a finding.
//   - Conversely it never strips a `/* … */` block comment, so a call site commented
//     out that way reads as real: a FALSE POSITIVE, the safe direction (a look costs a
//     look; see the tuning rule in test/guards-population.cjs).
// Both approximations are cheap and known; a scan that must not miss a hidden call
// site needs a real parse, not this.
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const m = /(^|[^:])\/\//.exec(line);
    if (!m) return line;
    return line.slice(0, m.index + m[1].length);
  }).join('\n');
}

// Every file under `dir` whose name ends in one of `exts`. Dotfiles are skipped —
// which on this NFS checkout also skips the stray macOS AppleDouble shadow files
// (`libexec/._build-compose.cjs` and siblings) that a shell `find` glob would match —
// and `node_modules` is never descended into.
function discoverFilesByExt(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...discoverFilesByExt(p, exts));
    else if (exts.some((ext) => e.name.endsWith(ext))) out.push(p);
  }
  return out;
}

module.exports = { stripLineComments, discoverFilesByExt };
