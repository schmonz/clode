'use strict';
// source-invisible-chars.test.cjs - the ratchet half of task W3. Several committed JS
// files were found (2026-09-24) to contain LITERAL bidi controls and zero-width
// characters inside string literals: agent tooling here (Write/Edit and Bash heredocs)
// silently turned a `\uXXXX` escape the agent authoring the file TYPED into the actual
// invisible character on disk. The code point was the intended one, so every test kept
// passing -- but the byte on disk was invisible in a diff or a review, and a bidi
// control sitting in source is exactly the "Trojan Source" class (CVE-2021-42574): it
// can make a reviewer see one thing while the parser reads another. Nothing in this
// repo noticed, because nothing was looking. This file is the mechanism that would have
// made noticing it easy (see BACKLOG.md's "ratchet: noticed and fixed earlier" note) --
// applied one more time, to the repo's own source bytes instead of an artifact it builds.
//
// SCOPE. Two disjoint code-point sets, both BMP, both from Unicode's own catalog of
// "characters that render as nothing or reorder what renders around them":
//   BIDI  -- U+061C, U+200E-U+200F, U+202A-U+202E, U+2066-U+2069. Directional formatting
//            controls. A comment or string can carry one of these and visually SWAP the
//            order two adjacent tokens appear in, without changing what the parser sees.
//   ZW    -- U+00AD, U+200B-U+200D, U+2060, U+FEFF. Soft hyphen / zero-width space,
//            non-joiner, joiner, word-joiner, BOM. Render as literally nothing.
// A combining mark (e.g. U+0301 COMBINING ACUTE ACCENT) is NOT in scope: it is ordinary,
// legitimate Unicode used constantly in real prose and in real script text (a comment
// naming a person, a non-Latin identifier), and flagging it would make this gate noisy
// exactly where phase 3's own text-fidelity corpora legitimately compose base+mark
// sequences on purpose. Task W3 converted the specific combining-mark literals that were
// standing in for a DECOMPOSED code-point-sequence test case by hand, one at a time, with
// a before/after evaluated-string proof (see task-W3-report.md) -- that is a one-time
// authoring cleanup, not something a repo-wide gate can safely automate, because it
// cannot tell "clearly a code-point fixture" from "clearly someone's name in a comment".
//
// The two sets ARE built from NUMBERS below (0x061c, not a typed `\uXXXX` token) for the
// same reason task W3's rewrite script is Python, not a hand-edited file: this repo's own
// Write/Edit tools can silently turn a typed backslash-u escape into the literal
// character, which for THIS FILE would be exactly the defect under test reappearing in
// its own gate. Scanning is done character-by-character against a Set of code points,
// so no escape text is ever assembled here either -- nothing in this file's own source
// is anything but ASCII.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');

const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const ZW = [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
const TARGET = new Set([...BIDI, ...ZW]);

function codePointName(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

const DIRS = ['libexec/', 'scripts/', 'test/'];
const EXT_RE = /\.(?:cjs|mjs|js)$/;

function trackedFiles() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

// git ls-files IS the project (see test/no-fuse-gate.test.cjs / test/no-retired-spellings
// .test.cjs for why: it already excludes build/, node_modules/, test/.harness/, docs/ and
// .superpowers/, so the corpus is identical on two checkouts of the same commit).
function candidateFiles() {
  return trackedFiles().filter((rel) => DIRS.some((d) => rel.startsWith(d)) && EXT_RE.test(rel));
}

// read() -- the only I/O.
function readCorpus() {
  const rels = candidateFiles();
  if (rels.length === 0) {
    return { skip: '`git ls-files` returned no candidate .cjs/.mjs/.js file under libexec/, '
      + 'scripts/, or test/ -- repo layout or git invocation changed; nothing to scan' };
  }
  const files = [];
  for (const rel of rels) {
    let src;
    try { src = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    files.push({ rel, src });
  }
  return { files };
}

// PURE. {findings, examined}. One finding per file:line that carries at least one
// literal code point from TARGET, naming every such code point found on that line.
// Deliberately per-LINE, not per-character: a line with two bidi controls is one defect
// to fix, not two entries to triage separately.
function scanSources({ files }) {
  const findings = [];
  let examined = 0;
  for (const { rel, src } of files) {
    if (typeof src !== 'string' || src.length === 0) continue;
    examined++;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const found = new Set();
      for (const c of line) {
        const cp = c.codePointAt(0);
        if (TARGET.has(cp)) found.add(cp);
      }
      if (found.size === 0) continue;
      const names = [...found].sort((a, b) => a - b).map(codePointName).join(', ');
      findings.push(`${rel}:${i + 1}: literal ${names} in source -- rewrite as a JS `
        + '\\uXXXX escape (bidi controls and zero-width/invisible characters must never '
        + 'appear as literal source bytes; this is the "Trojan Source" class, '
        + 'CVE-2021-42574 -- the character can render one way and parse another)');
    }
  }
  return { findings, examined };
}

// Measured 2026-09-24: `git ls-files` lists 540 tracked *.cjs/*.mjs/*.js files under
// libexec/, scripts/, test/. Floor is a round number well under that -- ordinary churn
// (a file renamed, a test split, a module deleted) moves the real count by a handful; a
// floor this far below only trips on the scan going BLIND (a bad cwd, a broken git
// invocation, a filter that regressed to matching nothing), the same margin
// test/no-retired-spellings.test.cjs and test/no-fuse-gate.test.cjs use for the same
// git-ls-files corpus shape.
const guard = defineGuard({
  name: 'source-invisible-chars',
  floor: 500,
  read: readCorpus,
  // control(): a synthetic source string containing one literal U+202E (RIGHT-TO-LEFT
  // OVERRIDE), built from the number via String.fromCharCode -- never typed as an escape
  // or as the literal character in this file's own source, for the reason the header
  // explains.
  control: () => ({
    files: [
      { rel: 'synthetic/control.cjs',
        src: 'const label = "a' + String.fromCharCode(0x202e) + 'b";\n' },
    ],
  }),
  scan: scanSources,
});
guardTests(guard);

// The acceptance table: every BIDI/ZW code point must be caught, and a combining mark
// must NOT be (requirement 2 -- combining marks are legitimate and must stay silent).
test('every BIDI and ZW code point is flagged; a combining mark is not', () => {
  for (const cp of [...BIDI, ...ZW]) {
    const line = 'const x = "a' + String.fromCharCode(cp) + 'b";';
    const r = scanSources({ files: [{ rel: 'f.cjs', src: line }] });
    assert.strictEqual(r.findings.length, 1,
      `${codePointName(cp)} must be flagged: ${JSON.stringify(r.findings)}`);
    assert.ok(r.findings[0].includes(codePointName(cp)),
      `the finding must name ${codePointName(cp)}: ${r.findings[0]}`);
  }
  // U+0301 COMBINING ACUTE ACCENT: ordinary, legitimate, must stay silent.
  const combining = scanSources({ files: [{ rel: 'f.cjs', src: 'const x = "e' + String.fromCharCode(0x0301) + '";' }] });
  assert.deepStrictEqual(combining.findings, [],
    'a combining mark is not a bidi or zero-width control and must not be flagged');
});

test('two flagged code points on one line produce ONE finding naming both', () => {
  const line = 'const x = "a' + String.fromCharCode(0x202e) + 'b' + String.fromCharCode(0x200b) + 'c";';
  const r = scanSources({ files: [{ rel: 'f.cjs', src: line }] });
  assert.strictEqual(r.findings.length, 1, JSON.stringify(r.findings));
  assert.ok(r.findings[0].includes('U+202E') && r.findings[0].includes('U+200B'), r.findings[0]);
});

module.exports = { scanSources, readCorpus, candidateFiles, TARGET, BIDI, ZW, guard };
