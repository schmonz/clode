'use strict';
// Layer 2 of the shim-fidelity guard: targeted Bun-parity anchors. Unlike Layer 1 (which
// only knows our own past output), these encode KNOWN-GOOD values so a bump that drifts the
// shim away from Bun's behavior fails with a meaningful message. Values below are
// Unicode-standard widths/wraps that Bun.stringWidth / Bun.wrapAnsi agree on for these
// inputs; no Bun runs in CI. Cases where wrap-ansi is KNOWN to diverge from Bun (LONG-TERM.md:
// {trim,hard,wordWrap} option handling) are recorded as `todo` until the shim closes the gap.
const { test } = require('node:test');
const assert = require('node:assert');
const { fns } = require('./shim-fidelity-lib.cjs');
const { stringWidth, wrapAnsi } = fns;

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

// Known divergence (LONG-TERM.md): wrap-ansi's handling of {trim,wordWrap} differs from
// native Bun.wrapAnsi. Recorded as a gap; promote to a real assertion (with the
// Bun-measured expected value) when the shim closes it.
test('wrapAnsi: {wordWrap:false} keeps long words intact like Bun',
  { todo: 'wrap-ansi vs Bun.wrapAnsi option drift — see LONG-TERM.md' }, () => {});
