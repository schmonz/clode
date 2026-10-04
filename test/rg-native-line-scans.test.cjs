'use strict';
// rg-native-line-scans.test.cjs — quaude's rg finds a line's start in ONE place (grep-native Task 8,
// Step 0; ruling G19, from Task 7's review M1).
//
// WHY. Selecting each match's line by scanning back from every match to its line's start was
// quadratic: every match of one 5 MB minified line took 191 s (Task 7). The fix routed every such
// lookup through libexec/rg-native.cjs's `lineStart`, which steps back no further than a floor and
// COUNTS every byte it steps over (searchStats.scannedBack), so test/rg-native.test.cjs can assert
// "linear" as an operation count. But the counter only counts what goes through the helper: a
// rewrite that scans back with its own loop is invisible to it (Task 7 fix round 2's own caveat).
// This guard closes that hole: a backward newline scan anywhere else in the module is a finding.
//
// WHAT IS A BACKWARD NEWLINE SCAN, per line of source (a loop header written across lines is not
// seen; the module's style keeps them on one):
//   - a `while`/`for` that decrements (`--`) and compares a byte BEFORE an index (`[x - 1]`) with
//     a newline (0x0a, 10 or NL);
//   - `lastIndexOf(` a newline (0x0a, 10, NL, or a quoted newline escape).
// Allowed: inside `function lineStart(` (the counted helper), and the one named exception, the
// `const prev = ` line of eachPrintedLine (RG-CONTEXT's before-context: from a line's start to the
// line before it, each line's bytes stepped over once).
// A single comparison of the LAST byte (`text[text.length - 1] !== 0x0a`) is not a scan: no loop.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const SOURCE = path.resolve(__dirname, '..', 'libexec', 'rg-native.cjs');

const NEWLINE = String.raw`(?:0x0a|10\b|NL\b|'\\n'|"\\n")`;
const LOOP_SCAN = new RegExp(String.raw`\[[^\]\n]*-\s*1\]\s*[!=]==?\s*` + NEWLINE);
const LAST_INDEX = new RegExp(String.raw`\.lastIndexOf\(\s*` + NEWLINE);

// The [first, last] line numbers (1-based) of the body of `function name(`, by brace depth; null
// when the module has no such function.
function functionSpan(lines, name) {
  const at = lines.findIndex((l) => new RegExp(String.raw`^\s*function\s+${name}\s*\(`).test(l));
  if (at === -1) return null;
  let depth = 0, opened = false;
  for (let i = at; i < lines.length; i++) {
    for (const c of lines[i]) {
      if (c === '{') { depth++; opened = true; } else if (c === '}') depth--;
    }
    if (opened && depth === 0) return [at + 1, i + 1];
  }
  return null;
}

// PURE: { findings, examined } over { src }. `examined` counts the backward scans found (the
// allowed ones included), so a scanner gone blind (both allowed scans unseen) falls under the floor.
function scanLineScans({ src }) {
  const lines = String(src).split('\n');
  const span = functionSpan(lines, 'lineStart');
  const findings = [];
  if (!span) findings.push('libexec/rg-native.cjs has no `function lineStart(`: the one counted line-start helper is gone');
  let examined = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const loop = /\b(?:while|for)\b/.test(l) && /--/.test(l) && LOOP_SCAN.test(l);
    if (!loop && !LAST_INDEX.test(l)) continue;
    examined++;
    const n = i + 1;
    if (span && n >= span[0] && n <= span[1]) continue;
    if (/^\s*const prev = /.test(l)) continue;
    findings.push(`libexec/rg-native.cjs:${n}: a backward newline scan outside lineStart (route it through lineStart, `
      + `which bounds and counts it; searchStats.scannedBack cannot see this one): ${l.trim().slice(0, 160)}`);
  }
  return { findings, examined, note: 'backward newline scans in libexec/rg-native.cjs (lineStart\'s and prev\'s are allowed)' };
}

const guard = defineGuard({
  name: 'rg-native-line-scans',
  // lineStart's loop and prev's lastIndexOf: fewer than two seen means the scanner went blind.
  floor: 2,
  read: () => ({ src: fs.readFileSync(SOURCE, 'utf8') }),
  scan: scanLineScans,
  // The module as it is, plus one hand-rolled backward scan of the shape Task 7 removed.
  control: () => ({
    src: fs.readFileSync(SOURCE, 'utf8')
      + '\nfunction lineOf(text, at) { let ls = at; while (ls > 0 && text[ls - 1] !== 0x0a) ls--; return ls; }\n',
  }),
});
guardTests(guard);

test('rg-native-line-scans: each shape is a finding outside lineStart, and a last-byte check is not', () => {
  const base = 'function lineStart(text, at, floor) {\n  let ls = at;\n  while (ls > floor && text[ls - 1] !== 0x0a) ls--;\n  return ls;\n}\n';
  const scan = (extra) => scanLineScans({ src: base + extra });
  assert.deepStrictEqual(scan('').findings, []);
  assert.strictEqual(scan('').examined, 1);
  for (const bad of [
    'const s = text.lastIndexOf(0x0a, at) + 1;',
    "const s = text.lastIndexOf('\\n', at) + 1;",
    'for (let i = at; i > 0 && b[i - 1] != 10; i--) {}',
    'while (j > 0 && text[j - 1] !== NL) j--;',
  ]) assert.strictEqual(scan(bad + '\n').findings.length, 1, bad);
  for (const fine of [
    'const unterminated = text.length > 0 && text[text.length - 1] !== 0x0a;',
    'const e = text.indexOf(0x0a, ls);',
    'const prev = (ls) => (ls === 0 ? -1 : text.lastIndexOf(0x0a, ls - 2) + 1);',
  ]) assert.deepStrictEqual(scan(fine + '\n').findings, [], fine);
});

module.exports = { scanLineScans, guard };
