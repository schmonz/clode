'use strict';
// scripts/cell-profile-diff.cjs's like-with-like shaping, which decides what a native
// CellSegmenter cell is compared against. Pure: no native, no tjs. The native half is the
// CLI itself (task 4b ran it to 0 differences on every corpus against 2.1.278). The rules
// themselves live in libexec/unicode-text.cjs (escapeLayer, forEachCell), each pinned by a
// same-named test in test/unicode-text.test.cjs; this checks the CLI goes through them.
const test = require('node:test');
const assert = require('node:assert');
const { ourCells, main } = require('../scripts/cell-profile-diff.cjs');

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
  // Through the escape layer, as native (task 6): `a ESC b c` -> [a] [c], `a U+009F b c` ->
  // [a], and a cluster spans an escape: `e ESC[1m U+0301` -> [e U+0301].
  assert.deepStrictEqual(ourCells(H(0x61, 0x1b, 0x62, 0x63), true), [['a', 1], ['c', 1]]);
  assert.deepStrictEqual(ourCells(H(0x61, 0x9f, 0x62, 0x63), true), [['a', 1]]);
  assert.deepStrictEqual(ourCells(H(0x65, 0x1b, 0x5b, 0x31, 0x6d, 0x301), true), [[H(0x65, 0x301), 1]]);
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

// A native of ANOTHER version is a different oracle (ruling R11), so the CLI refuses it
// before comparing anything, naming both versions. It used to warn and compare, which as a
// CI step would pass. Node stands in for the wrong native: it answers --version (v24...),
// and exits 0 without running any preload, so only the version check can name the reason.
test('a native of another version than the tables were generated from is refused (exit 2), naming both', async () => {
  const quiet = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  let code;
  try {
    code = await main(['--native', process.execPath, '--corpus', 'composed']);
  } finally { process.stderr.write = quiet; }
  assert.strictEqual(code, 2);
  const { UNICODE_DATA } = require('../libexec/unicode-text.cjs');
  assert.ok(err.includes(JSON.stringify(process.version)), `the refusal names the native's version: ${err}`);
  assert.ok(err.includes(JSON.stringify(UNICODE_DATA.header.nativeClaude)), `and the table's: ${err}`);
  assert.match(err, /different native is a different oracle/);
});
