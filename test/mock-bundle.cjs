#!/usr/bin/env node
'use strict';
// A DETERMINISTIC, self-contained synthetic "claude" binary for the extract+inspect
// regression — no 120 MB provider download required. It's a minimal Bun `--compile`
// layout: a NUL-terminated `src/entrypoints/cli.js` @bun-cjs block whose body carries
// the extractor's sentinels ('commander', '@anthropic-ai/claude-code') and enough
// realistic JS to clear the extractor's 1 MB size floor.
//
// Why the padding is realistic JS and NOT a run of one byte: inspect-claude-bundle
// scans the carved body with several regexes, and a ~1 MB run of a single repeated
// character triggers pathological backtracking (the inspect step hangs). Varied,
// JS-shaped text keeps every scan linear, so both extract AND inspect stay fast and
// deterministic — the whole point of a reliable fixture.
//
// buildMockBundle() returns identical bytes on every platform, so the golden shas in
// test/golden-mock-shas.json are host-independent. Re-bless with test/update-mock-golden.cjs
// after an INTENTIONAL change to the extractor/inspector output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shasForBinary } = require('./golden-shas-lib.cjs');

const SIZE_FLOOR = 1000000; // must exceed MIN_OUTPUT_BYTES in libexec/extract-claude-js.cjs

// One deterministic unit of realistic minified-ish JS. Repeated to fill the body.
// Kept free of the extractor's fail-loud patch anchors so extraction is a clean,
// warn-only pass (the patches don't apply to synthetic input — see extract's transform).
const UNIT =
  'function f$(a,b){return a+b}var c$=require("commander"),u$=require("url");' +
  'let s$={installationType:"native",warnings:[]};class W$ extends Error{}\n';

function buildMockBundle() {
  const header = '\n/* commander @anthropic-ai/claude-code clode-self-contained-regression-fixture */\n';
  const footer = '\nmodule.exports=function main(){console.log("CLODE-MOCK-BUNDLE")};\n';
  const reps = Math.ceil((SIZE_FLOOR + 512 - header.length - footer.length) / UNIT.length);
  const body = header + UNIT.repeat(reps) + footer;
  return Buffer.concat([
    Buffer.from('PADDINGPADDINGPADDING\x00'),
    Buffer.from('src/entrypoints/cli.js\x00'),
    Buffer.from('// @bun @bun-cjs\n'),
    Buffer.from('(function(exports, require, module, __filename, __dirname) {'),
    Buffer.from(body),
    Buffer.from('})\x00TRAILER\x00'),
  ]);
}

// The committed-golden compute for the mock: write it to a temp binary and run the
// SAME extract+inspect pipeline the provider-based regression uses (golden-shas-lib),
// so the two can never drift in methodology.
function mockShas() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-bundle-'));
  const bin = path.join(tmp, 'claude');
  try {
    fs.writeFileSync(bin, buildMockBundle());
    return shasForBinary(bin);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { buildMockBundle, mockShas, SIZE_FLOOR };

// CLI: `node test/mock-bundle.cjs <out>` writes the fixture (for hand-inspection);
// `node test/mock-bundle.cjs --shas` prints the computed golden shas.
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--shas') {
    process.stdout.write(JSON.stringify(mockShas(), null, 2) + '\n');
  } else if (arg) {
    fs.writeFileSync(arg, buildMockBundle());
    process.stderr.write(`wrote mock bundle -> ${arg} (${buildMockBundle().length} bytes)\n`);
  } else {
    process.stderr.write('usage: mock-bundle.cjs <out> | --shas\n');
    process.exit(1);
  }
}
