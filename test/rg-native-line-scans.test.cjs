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
// WHAT IS A BACKWARD SCAN, per line of source, comments set aside (a loop header written across lines is
// not seen; the module's style keeps them on one). Broadened in Task 8's review (M1), each shape with a
// control below:
//   - any `.lastIndexOf(`, `.findLastIndex(` or `.reverse(`, whatever it is given;
//   - a decrement (`--`, `-= 1`, `[--i]`, `[i--]`) on a line that also names a newline (0x0a in any case,
//     0xa, 10, NL, or a quoted newline escape), in either order (`0x0a !== t[i - 1]` too), inside a loop
//     header or as an index.
// Allowed: inside `function lineStart(` (the counted helper), and the one named exception, the
// `const prev = ` line of eachPrintedLine (RG-CONTEXT's before-context: from a line's start to the
// line before it, each line's bytes stepped over once).
// A single comparison of the LAST byte (`text[text.length - 1] !== 0x0a`) is not a scan: no decrement.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const SOURCE = path.resolve(__dirname, '..', 'libexec', 'rg-native.cjs');

const NEWLINE = new RegExp(String.raw`(?:\b0x0?a\b|\b10\b|\bNL\b|'\\n'|"\\n"|` + '`' + String.raw`\\n` + '`' + ')', 'i');
const ANY_BACKWARD = /\.(?:lastIndexOf|findLastIndex|reverse)\(/;
const DECREMENT = /--|-=\s*1\b/;
const LOOP = /\b(?:while|for|do)\b/;
const INDEX_DECREMENT = /\[\s*(?:--\s*\w+|\w+\s*--)\s*\]/;
// A line with its // comment set aside (a // inside a string or regex literal ends the code early: the
// module writes none on a scanning line).
const code = (l) => l.replace(/(^|\s)\/\/.*$/, '$1');
const isBackwardScan = (line) => {
  const l = code(line);
  return ANY_BACKWARD.test(l) || (NEWLINE.test(l) && ((LOOP.test(l) && DECREMENT.test(l)) || INDEX_DECREMENT.test(l)));
};

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
    if (!isBackwardScan(l)) continue;
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
  // the evasions the review tried (M1), and the shapes before them
  for (const bad of [
    'const s = text.lastIndexOf(0x0a, at) + 1;',
    "const s = text.lastIndexOf('\\n', at) + 1;",
    'const s = text.lastIndexOf(nl, at) + 1;',
    'const s = text.subarray(0, at).lastIndexOf(LF);',
    'const j = [...text.subarray(0, at)].findLastIndex((c) => c === 10);',
    'const j = [...text.subarray(0, at)].reverse().indexOf(10);',
    'for (let i = at; i > 0 && b[i - 1] != 10; i--) {}',
    'while (j > 0 && text[j - 1] !== NL) j--;',
    'while (j > 0 && text[j - 1] !== 0x0A) j--;',
    'while (j > 0 && text[j - 1] !== 0xa) j--;',
    'while (j > 0 && 0x0a !== text[j - 1]) j--;',
    'while (j > 0 && text[j - 1] !== 0x0a) j -= 1;',
    'while (j > 0 && text[--j] !== 0x0a) {}',
    'if (text[j--] === 0x0a) break;',
    'for (j = i - 1; j >= 0; j--) if (t[j] === 0x0a) break;',
    "do { j--; } while (j > 0 && t[j] !== '\\n'.charCodeAt(0));",
  ]) assert.strictEqual(scan(bad + '\n').findings.length, 1, bad);
  for (const fine of [
    'const unterminated = text.length > 0 && text[text.length - 1] !== 0x0a;',
    'const e = text.indexOf(0x0a, ls);',
    'const prev = (ls) => (ls === 0 ? -1 : text.lastIndexOf(0x0a, ls - 2) + 1);',
    '// a comment naming lastIndexOf(0x0a) and i-- is not code',
    'for (let i = 0; i < n; i++) if (t[i] === 0x0a) k++;',
    'while (pend > 0) pend--;',
  ]) assert.deepStrictEqual(scan(fine + '\n').findings, [], fine);
});

module.exports = { scanLineScans, guard };
