'use strict';
// scripts/cell-profile-diff.cjs's like-with-like shaping, which decides what a native
// CellSegmenter cell is compared against. Pure: no native, no tjs. The native half is the
// CLI itself (task 4b ran it to 0 differences on every corpus against 2.1.278).
const test = require('node:test');
const assert = require('node:assert');
const { ourCells, dropLoneSurrogates, escapeLayer, main } = require('../scripts/cell-profile-diff.cjs');

const H = (...cps) => cps.map((c) => ((c >= 0xd800 && c <= 0xdfff) ? String.fromCharCode(c) : String.fromCodePoint(c))).join('');

test('ourCells is shaped as CellSegmenter emits cells (measured 2026-09-24)', () => {
  // TAB is a cell of advance 0 with flag bit 256; a zero-width cluster is no cell at all.
  assert.deepStrictEqual(ourCells(H(0x61, 0x9, 0x62), true), [['a', 1], ['\t', 256], ['b', 1]]);
  assert.deepStrictEqual(ourCells(H(0x9, 0x301), true), [['\t', 256]], 'the mark after a tab is its own zero-width cluster');
  assert.deepStrictEqual(ourCells(H(0x61, 0x202e, 0x62), true), [['a', 1], ['b', 1]]);
  // The advance is 8 bits and saturates at 255 (native: 128 x U+1100 -> 255).
  assert.deepStrictEqual(ourCells(H(...new Array(128).fill(0x1100)), true).map((c) => c[1]), [255]);
  // A lone surrogate is not in the cell's text (native: [0061 0308]=1).
  assert.deepStrictEqual(ourCells(H(0x61, 0xdc00, 0x308), true), [[H(0x61, 0x308), 1]]);
  // Both ambiguous settings: U+00B7 is 1 narrow, 2 wide.
  assert.deepStrictEqual(ourCells(H(0xb7), false), [[H(0xb7), 2]]);
});

test('dropLoneSurrogates keeps pairs and drops only lone halves', () => {
  assert.strictEqual(dropLoneSurrogates(H(0x1f600, 0xd83d, 0x61, 0xdc00)), H(0x1f600, 0x61));
  assert.strictEqual(dropLoneSurrogates(H(0xdbff, 0xdbff, 0xdc00)), H(0xdbff, 0xdc00));
});

test('escapeLayer names exactly ESC and the six C1 introducers native consumes', () => {
  for (const c of [0x1b, 0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]) assert.ok(escapeLayer(H(0x61, c, 0x62)), c.toString(16));
  for (const c of [0x7, 0x8, 0xd, 0x7f, 0x85, 0x9a, 0x9c]) assert.ok(!escapeLayer(H(0x61, c, 0x62)), c.toString(16));
});

test('a bad invocation is a harness failure (exit 2), not a difference', async () => {
  const quiet = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.strictEqual(await main([]), 2, 'no --native');
    assert.strictEqual(await main(['--native', '/nonexistent', '--corpus', 'nope']), 2, 'unknown corpus');
    assert.strictEqual(await main(['--native', '/nonexistent', '--corpus', 'composed']), 2, 'a native that is not there');
    assert.strictEqual(await main(['--bogus']), 2);
  } finally { process.stderr.write = quiet; }
});
