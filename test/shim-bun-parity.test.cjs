'use strict';
// Layer 2 of the shim-fidelity guard: targeted Bun-parity anchors. Unlike Layer 1 (which
// only knows our own past output), these encode KNOWN-GOOD values so a bump that drifts the
// shim away from Bun's behavior fails with a meaningful message. Values below are
// Unicode-standard widths/wraps that Bun.stringWidth / Bun.wrapAnsi agree on for these
// inputs; no Bun runs in CI. (All three are libexec/unicode-text.cjs's now, judged against
// native over whole corpora by test/fidelity/text-differential.test.cjs; these are anchors.)
const { test } = require('node:test');
const assert = require('node:assert');
const { fns } = require('./shim-fidelity-lib.cjs');
const { stringWidth, wrapAnsi, sliceAnsi } = fns;

test('stringWidth: standard East-Asian & emoji widths (Bun agrees for these)', () => {
  assert.strictEqual(stringWidth(''), 0);
  assert.strictEqual(stringWidth('hello'), 5);
  assert.strictEqual(stringWidth('日本語'), 6);          // 3 fullwidth CJK => 2 each
  assert.strictEqual(stringWidth('Ａ'), 2);              // U+FF21 fullwidth Latin A
  assert.strictEqual(stringWidth('👍'), 2);              // emoji presentation
  assert.strictEqual(stringWidth('a\u0300'), 1);         // 'a' + combining grave => 1
  assert.strictEqual(stringWidth('\u200b'), 0);          // zero-width space
  assert.strictEqual(stringWidth('\x1b[31mred\x1b[0m'), 3); // ANSI ignored
});

test('wrapAnsi: hard-breaks a long unbreakable word (Bun agrees)', () => {
  // 21 chars at width 8 => 'longword'(8) 'withoutb'(8) 'reaks'(5)
  assert.strictEqual(
    wrapAnsi('longwordwithoutbreaks', 8, { hard: true }),
    'longword\nwithoutb\nreaks');
});

// wordWrap: false breaks a word that does not fit at the column, into the room left on its
// row, where the default moves it whole to a row of its own (native 2.1.283, 2026-09-26:
// WRAP-HARD). This was a `todo` while Bun.wrapAnsi was npm wrap-ansi, titled as if Bun kept
// the long word intact; measured, it does not.
test('wrapAnsi: {wordWrap:false} breaks a long word at the column (Bun agrees)', () => {
  assert.strictEqual(wrapAnsi('a longwordwithoutbreaks', 8, { wordWrap: false }), 'a longwo\nrdwithou\ntbreaks');
  assert.strictEqual(wrapAnsi('a longwordwithoutbreaks', 8), 'a\nlongwordwithoutbreaks');
});

// Bun.sliceAnsi — NEW in upstream 2.1.278, and the member whose absence made the
// interactive TUI paint nothing at all. Upstream's own use pins the contract:
//
//     function vo(n,s,u){ let f=Bun.sliceAnsi(n,s,u);
//                         while(u>s && se(f)>u-s) u--, f=Bun.sliceAnsi(n,s,u);
//                         return f }
//
// `se` is stringWidth, so the indices are DISPLAY COLUMNS (the correction loop
// only makes sense if a slice can come back WIDER than the column span asked for,
// which is what a fullwidth cell at the boundary does), the range is
// half-open [start, end), and the styles active at `start` must be reopened on the
// slice or every truncated line leaks colour into the next.
test('sliceAnsi: columns in, styles preserved (Bun agrees for these)', () => {
  assert.strictEqual(sliceAnsi('hello world', 0, 5), 'hello');
  assert.strictEqual(sliceAnsi('hello world', 6, 11), 'world');
  assert.strictEqual(sliceAnsi('', 0, 4), '');
  // Fullwidth: 3 CJK glyphs are 6 columns, so [0,4) is the first TWO glyphs.
  assert.strictEqual(sliceAnsi('日本語', 0, 4), '日本');
  // A slice that starts inside a colour run reopens it and closes it.
  assert.strictEqual(sliceAnsi('\x1b[31mred text\x1b[39m', 4, 8), '\x1b[31mtext\x1b[39m');
  // A combining sequence is one cluster of width 1: [0,2) takes it plus 'b'.
  assert.strictEqual(sliceAnsi('a\u0300bc', 0, 2), 'a\u0300b');
});
