#!/usr/bin/env node
// text-format-demo.cjs — visual diagnostic for the shim's text helpers.
//
// Loads the REAL bun-shim.cjs and renders the four text-formatting behaviors
// that drive TUI layout, so you can see by eye which ones are wrong:
//
//   1. wrapAnsi   — long-line wrapping (known: identity, never wraps)
//   2. stringWidth — display width (alignment under wide chars: emoji/CJK)
//   3. stripANSI  — escape-sequence removal (do raw codes leak through?)
//   4. wrap+style — does color survive across a wrap boundary?
//
// Run:  node test/text-format-demo.cjs            (auto width from terminal)
//       COLUMNS=40 node test/text-format-demo.cjs (force a narrow width)
//
// Not named *.test.cjs on purpose — run-all.sh skips it; it has no assertions.

'use strict';
const Bun = require('../libexec/bun-shim.cjs');
const { stringWidth, stripANSI, wrapAnsi } = Bun;

const WIDTH = Number(process.env.COLUMNS) || process.stdout.columns || 60;
const E = '\x1b'; // ESC, so this source file itself has no raw escapes
const dim = (s) => `${E}[2m${s}${E}[0m`;
const bold = (s) => `${E}[1m${s}${E}[0m`;

function rule(label) {
  const bar = '─'.repeat(Math.max(0, WIDTH - label.length - 4));
  process.stdout.write(`\n${bold(`── ${label} `)}${bar}\n\n`);
}
// A column guide exactly WIDTH wide: anything spilling past the `|` overflows.
function guide() {
  process.stdout.write(dim(`${'.'.repeat(WIDTH - 1)}|  (col ${WIDTH})\n`));
}

process.stdout.write(bold(`text-format-demo  —  target width = ${WIDTH} cols\n`));

// ---------------------------------------------------------------------------
rule('1. wrapAnsi — long lines should wrap at the width');
guide();
const long =
  'The quick brown fox jumps over the lazy dog, and then keeps on running ' +
  'well past the right edge of any sensible terminal window without stopping.';
process.stdout.write('shim wrapAnsi(text, WIDTH):\n');
process.stdout.write(wrapAnsi(long, WIDTH) + '\n');
process.stdout.write(dim('\n^ If that printed as ONE line spilling past the `|`, wrapAnsi is identity.\n'));
process.stdout.write(dim('  A correct wrapper would break it into lines <= WIDTH.\n'));

// ---------------------------------------------------------------------------
rule('2. stringWidth — width drives column alignment');
process.stdout.write(dim('Each row prints a string, then a dashed line of length stringWidth(s).\n'));
process.stdout.write(dim('If the dashes end UNDER the last glyph, the width is right.\n\n'));
const samples = [
  'plain ascii',
  'CJK 你好世界 here',          // wide chars
  'emoji 🚀🔥 done',         // rocket, fire (width 2 each)
  'flag 🇺🇸 done',          // regional-indicator pair
  'family 👩‍👩‍👧 x', // ZWJ sequence
  'combining é́ accent',              // combining marks (width 0)
  'zero​width space',                       // ZWSP (width 0)
];
for (const s of samples) {
  const w = stringWidth(s);
  process.stdout.write(s + '\n');
  process.stdout.write(dim('─'.repeat(w) + ` (width ${w})\n`));
}
process.stdout.write(dim('\n^ Mismatches here = misaligned boxes/borders/columns in the TUI.\n'));

// ---------------------------------------------------------------------------
rule('3. stripANSI — should remove ALL escape sequences');
const cases = {
  'SGR bold/reset': `${E}[1mbold${E}[0m`,
  '256-color fg': `${E}[38;5;201mpink${E}[0m`,
  'truecolor fg': `${E}[38;2;255;128;0morange${E}[0m`,
  'cursor move': `${E}[2Aup-two`,
  'erase line': `${E}[2Kcleared`,
  'OSC hyperlink': `${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\`,
  'OSC title': `${E}]0;window title${E}\\after`,
};
for (const [name, raw] of Object.entries(cases)) {
  const out = stripANSI(raw);
  // Render escapes visibly as <ESC> so leaks are obvious in the output.
  const shown = out.replace(/\x1b/g, '<ESC>');
  const leaked = out.includes('\x1b') || /\][08]|\[[0-9;]*[A-Za-z]/.test(shown);
  process.stdout.write(`${leaked ? bold('LEAK') : ' ok '}  ${name.padEnd(16)} -> "${shown}"\n`);
}
process.stdout.write(dim('\n^ Any LEAK / <ESC> / bracket codes = raw sequences showing as text.\n'));

// ---------------------------------------------------------------------------
rule('4. wrap + style — color across a wrap boundary');
guide();
const styled = `${E}[32m` + 'green text that is long enough to need wrapping ' +
  'so we can see whether the color survives the break or bleeds/resets' + `${E}[0m`;
process.stdout.write(wrapAnsi(styled, WIDTH) + '\n');
process.stdout.write(dim('\n^ Each wrapped line should stay green and reset cleanly at the end.\n'));
process.stdout.write(dim('  If only line 1 is green, the wrapper dropped the SGR across the break.\n'));

process.stdout.write('\n');
