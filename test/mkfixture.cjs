#!/usr/bin/env node
'use strict';
// Write a fake "claude" binary: a Bun @bun-cjs entry block named
// src/entrypoints/cli.js wrapping a trivial body that prints the label. The real
// extractor carves it and Node boots it. Distinct labels => distinct sizes => sigs.
const fs = require('node:fs');

const MIN_OUTPUT_BYTES = 1000000; // must match libexec/extract-claude-js(.cjs)

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2) {
    process.stderr.write('mkfixture.cjs <out> <label>\n');
    process.exit(1);
  }
  const [out, label] = argv;
  const padding = Buffer.alloc(MIN_OUTPUT_BYTES + label.length, 0x78); // 'x'
  const body = Buffer.concat([
    Buffer.from('\n/* '), padding,
    Buffer.from(' commander @anthropic-ai/claude-code '),
    Buffer.from(label),
    Buffer.from(' */\nconsole.log("CLODE-FIXTURE '), Buffer.from(label), Buffer.from('");\n'),
  ]);
  const blob = Buffer.concat([
    Buffer.from('PADDINGPADDINGPADDING\x00'),
    Buffer.from('src/entrypoints/cli.js\x00'),
    Buffer.from('// @bun @bun-cjs\n'),
    Buffer.from('(function(exports, require, module, __filename, __dirname) {'),
    body,
    Buffer.from('})\x00TRAILER\x00'),
  ]);
  fs.writeFileSync(out, blob);
}
main();
