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

test('ASCII-only rstrip: a trailing 0xA0 byte is preserved (not stripped)', () => {
  // Body ends with byte 0xA0 then the wrapper close. Python bytes.rstrip keeps 0xA0.
  const data = buildBlock('/a/cli.js', 'B ');
  const blocks = carveBlocks(data);
  assert.strictEqual(blocks[0].body, 'B ');
});
