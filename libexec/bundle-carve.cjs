'use strict';
// Carve Bun @bun-cjs module blocks out of a latin1 view of a bundle. Faithful
// port of extract-claude-js / inspect-claude-bundle's shared carve logic.

// NOTE: operate on a latin1 STRING (1 char == 1 byte). The `g` flag is required
// for matchAll. \b/\x00 behave byte-identically to the Python rb'...' version.
const MARKER = /\/\/ @bun\b[^\n]*@bun-cjs\n\(function\(exports, require, module, __filename, __dirname\) \{/g;

// The module path is a NUL-terminated string just before its @bun-cjs block.
// Scan back up to 4KB for the last `...something.js\0` ending before `start`.
function nearestName(data, start) {
  const lo = Math.max(0, start - 4096);
  const seg = data.slice(lo, start);
  const j = seg.lastIndexOf('.js\x00');
  if (j === -1) return null;
  const k = seg.lastIndexOf('\x00', j - 1); // last NUL before j (=-1 if none)
  return seg.slice(k + 1, j + 3);
}

function carveBlocks(data) {
  const blocks = [];
  for (const m of data.matchAll(MARKER)) {
    const bodyStart = m.index + m[0].length;     // just past the `{`
    const nul = data.indexOf('\x00', bodyStart);
    const end = nul !== -1 ? nul : data.length;
    let block = data.slice(bodyStart, end);
    // Python bytes.rstrip(): ASCII whitespace ONLY. Do NOT use \s (it eats 0xA0).
    block = block.replace(/[ \t\n\r\x0b\x0c]+$/, '');
    if (block.endsWith('})')) block = block.slice(0, -2);
    blocks.push({ offset: m.index, size: block.length, body: block, name: nearestName(data, m.index) });
  }
  return blocks;
}

// MARKER is intentionally NOT exported: it's a `g`-flagged (stateful `lastIndex`)
// regex, so direct `.exec()`/`.test()` by a consumer would give cursor-dependent
// results. carveBlocks owns it via matchAll (which clones it, so it stays reentrant).
module.exports = { carveBlocks, nearestName };
