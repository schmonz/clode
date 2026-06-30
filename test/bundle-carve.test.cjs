const { test } = require('node:test');
const assert = require('node:assert');
const { carveBlocks, nearestName } = require('../libexec/bundle-carve.cjs');

// A minimal synthetic block: NUL-terminated name, then marker, body, trailing })NUL.
function buildBlock(name, body) {
  return name + '\x00' +
    '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {' +
    body + '})\x00';
}

test('carves one block, strips wrapper, finds the name', () => {
  const data = 'JUNK\x00' + buildBlock('/x/src/entrypoints/cli.js', 'BODYHERE');
  const blocks = carveBlocks(data);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].body, 'BODYHERE');
  assert.strictEqual(blocks[0].name, '/x/src/entrypoints/cli.js');
});

test('ASCII-only rstrip preserves a trailing 0xA0 byte (would die under \\s)', () => {
  // The carved region ends in byte 0xA0 (explicit \xa0 escape so no editor can
  // normalize it to a space). Python bytes.rstrip() leaves 0xA0 — so the region
  // does NOT end in "})" and the wrapper is NOT trimmed. Under JS \s, 0xA0 would
  // be stripped, then "})" trimmed -> "BODY"; this asserts the ASCII-only result.
  const NBSP = '\xa0'; // charCode 0xA0 == latin1 byte 0xA0
  const data = '/a/cli.js\x00' +
    '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {' +
    'BODY})' + NBSP + '\x00';
  const blocks = carveBlocks(data);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].body, 'BODY})' + NBSP);
});

test('no markers -> empty list', () => {
  assert.deepStrictEqual(carveBlocks('nothing to see here\x00plain text'), []);
});

test('block with no preceding .js name -> name is null', () => {
  const data = 'no-name-here\x00' +
    '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {' +
    'X})\x00';
  const blocks = carveBlocks(data);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].name, null);
  assert.strictEqual(blocks[0].body, 'X');
});

test('multiple blocks carved in order with their names', () => {
  const data =
    '/a/first.js\x00' +
    '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {ONE})\x00' +
    '/b/second.js\x00' +
    '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {TWO})\x00';
  const blocks = carveBlocks(data);
  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual([blocks[0].name, blocks[0].body], ['/a/first.js', 'ONE']);
  assert.deepStrictEqual([blocks[1].name, blocks[1].body], ['/b/second.js', 'TWO']);
  assert.ok(blocks[1].offset > blocks[0].offset);
});
