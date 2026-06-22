// Text helpers in bun-shim.cjs drive TUI layout. Bun provides these natively;
// the shim must match closely enough that boxes/columns/wrapping render right.
// These pin the three bugs the demo surfaced:
//   - stringWidth over-counts zero-width / combining / ZWJ characters
//   - stripANSI leaves OSC sequences (hyperlinks, titles) in the text
//   - wrapAnsi is identity (never wraps) and so can't preserve style across breaks
const { test } = require('node:test');
const assert = require('node:assert');
const Bun = require('../libexec/bun-shim.cjs');
const { stringWidth, stripANSI, wrapAnsi } = Bun;

const E = '\x1b';

test('stringWidth: ascii is one column per char', () => {
  assert.strictEqual(stringWidth('hello'), 5);
  assert.strictEqual(stringWidth(''), 0);
});

test('stringWidth: CJK and basic emoji are two columns', () => {
  assert.strictEqual(stringWidth('中'), 2);
  assert.strictEqual(stringWidth('你好'), 4);
  assert.strictEqual(stringWidth('🚀'), 2);
});

test('stringWidth: combining marks add zero width', () => {
  assert.strictEqual(stringWidth('é'), 1);        // e + combining acute
  assert.strictEqual(stringWidth('á́'), 1);  // base + two marks
});

test('stringWidth: zero-width characters count as zero', () => {
  assert.strictEqual(stringWidth('a​b'), 2);  // ZWSP
  assert.strictEqual(stringWidth('a‍b'), 2);  // ZWJ
  assert.strictEqual(stringWidth('﻿hi'), 2);  // BOM / ZWNBSP
});

test('stringWidth: ignores ANSI escapes', () => {
  assert.strictEqual(stringWidth(`${E}[1mhi${E}[0m`), 2);
});

test('stripANSI: removes SGR/CSI sequences', () => {
  assert.strictEqual(stripANSI(`${E}[1mbold${E}[0m`), 'bold');
  assert.strictEqual(stripANSI(`${E}[38;5;201mpink${E}[0m`), 'pink');
  assert.strictEqual(stripANSI(`${E}[2Aup`), 'up');
});

test('stripANSI: removes OSC hyperlinks and titles', () => {
  // OSC 8 hyperlink, ST-terminated
  assert.strictEqual(
    stripANSI(`${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\`),
    'link');
  // OSC title, ST-terminated
  assert.strictEqual(stripANSI(`${E}]0;window title${E}\\after`), 'after');
  // OSC, BEL-terminated
  assert.strictEqual(stripANSI(`${E}]0;t\x07after`), 'after');
});

test('wrapAnsi: short text is returned unchanged', () => {
  assert.strictEqual(wrapAnsi('hi', 80), 'hi');
});

test('wrapAnsi: preserves explicit newlines', () => {
  assert.strictEqual(wrapAnsi('a\nb', 80), 'a\nb');
});

test('wrapAnsi: wraps long text so every line fits the width', () => {
  const text = 'the quick brown fox jumps over the lazy dog again and again';
  const out = wrapAnsi(text, 20);
  const lines = out.split('\n');
  assert.ok(lines.length > 1, 'expected multiple lines');
  for (const line of lines) assert.ok(stringWidth(line) <= 20, `line too wide: ${line}`);
  // no words lost or reordered
  assert.strictEqual(stripANSI(out).split('\n').join(' '), text);
});

test('wrapAnsi: hard-breaks a word longer than the width', () => {
  const out = wrapAnsi('x'.repeat(10), 4);
  const lines = out.split('\n');
  for (const line of lines) assert.ok(stringWidth(line) <= 4);
  assert.strictEqual(stripANSI(out).split('\n').join(''), 'x'.repeat(10));
});

test('wrapAnsi: preserves whitespace when text fits (input editor relies on this)', () => {
  // Anything within the width must come back byte-for-byte: the editor computes
  // the cursor from the buffer and renders the wrapped string; if they disagree
  // it indexes past the end and the TUI crashes.
  assert.strictEqual(wrapAnsi('hello  world', 80), 'hello  world');   // internal run
  assert.strictEqual(wrapAnsi('   indented', 80), '   indented');     // leading
  assert.strictEqual(wrapAnsi('trailing   ', 80), 'trailing   ');     // trailing
  assert.strictEqual(wrapAnsi('a\tb', 80), 'a\tb');                   // tab kept verbatim
  assert.strictEqual(wrapAnsi('    ', 80), '    ');                   // spaces-only
  assert.strictEqual(wrapAnsi('a\n  b', 80), 'a\n  b');               // indent after newline
});

test('wrapAnsi: only the wrap-point separator is dropped, other whitespace survives', () => {
  const out = wrapAnsi('alpha   beta gamma', 8);   // 3-space run between alpha and beta
  const lines = out.split('\n');
  for (const line of lines) assert.ok(stringWidth(line) <= 8, `line too wide: ${JSON.stringify(line)}`);
  // alpha is 5 wide; "alpha   beta" would be 12 > 8, so beta wraps and the run is consumed there
  assert.deepStrictEqual(lines, ['alpha', 'beta', 'gamma']);
});

test('wrapAnsi: a span opening after a space does not bleed onto the previous line', () => {
  // "...dddd " wraps right before the reverse-video span; the [7m must travel
  // with "eeee", not get stamped onto the end of the "cccc dddd" line. A leaked
  // reset/highlight here is the "funny highlighting" seen in the TUI.
  const out = wrapAnsi(`aaaa bbbb cccc dddd ${E}[7meeee${E}[0m ffff`, 12);
  const lines = out.split('\n');
  for (const line of lines){
    assert.ok(stringWidth(line) <= 12, `line too wide: ${JSON.stringify(line)}`);
    const opens = (line.match(/\x1b\[7m/g) || []).length;
    const resets = (line.match(/\x1b\[0m/g) || []).length;
    assert.strictEqual(opens, resets, `SGR open/close unbalanced on line: ${JSON.stringify(line)}`);
  }
  assert.strictEqual(stripANSI(out).split('\n').join(' '), 'aaaa bbbb cccc dddd eeee ffff');
});

test('wrapAnsi: re-opens and closes active SGR on each wrapped line', () => {
  const text = 'green text that is long enough to span several wrapped lines here';
  const styled = `${E}[32m${text}${E}[0m`;
  const out = wrapAnsi(styled, 20);
  const lines = out.split('\n');
  assert.ok(lines.length > 1, 'expected multiple lines');
  for (const line of lines) assert.ok(stringWidth(line) <= 20, `line too wide: ${line}`);
  // color is reopened at the start of every line and reset at the end of every line
  assert.strictEqual((out.match(new RegExp(`${'\\x1b'}\\[32m`, 'g')) || []).length, lines.length);
  assert.strictEqual((out.match(new RegExp(`${'\\x1b'}\\[0m`, 'g')) || []).length, lines.length);
  assert.strictEqual(stripANSI(out).split('\n').join(' '), text);
});
