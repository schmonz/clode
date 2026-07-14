'use strict';
// make-min-provider.cjs — pre-carve the ~240MB upstream Claude Code provider
// down to a ~17.5MB SYNTHETIC provider that clode's extractor still carves
// correctly, but in a fraction of the RAM/CPU.
//
// WHY: `clode build` reads the provider bundle by CARVING the JS out of the Bun
// binary (arch-independent — it never execs it). carveBlocks slurps the whole
// file as a latin1 string + matchAll, so a 240MB binary peaks >512MB and scans
// for many minutes. On the netbsd-sparc leg the fuse runs IN the sun4m guest
// (SS-20 @ 512MB RAM, the hardware ceiling, under TCG) — the full binary OOMs
// ("out of swap") and is glacial. A minimal file containing ONLY the
// entrypoints/cli.js @bun-cjs block (with the name sentinel + markers the
// carver keys on) reduces that to ~17.5MB: it fits, and it's fast. The carve is
// arch-independent, so producing it on the x64 runner and shipping the small
// file to the guest changes nothing about the extracted cli.cjs.
//
// Used by BOTH the CI build-leg (qemu-* smoke provider staging) and the local
// docker-loop harness — keep it here (committed) so neither forks the logic.
//
// Usage: node scripts/make-min-provider.cjs <real-provider> <out-min-provider>
const fs = require('node:fs');
const path = require('node:path');
const { carveBlocks } = require(path.join(__dirname, '..', 'libexec', 'bundle-carve.cjs'));

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/make-min-provider.cjs <in-provider> <out-min-provider>');
  process.exit(2);
}

const data = fs.readFileSync(inPath, 'latin1');
const blocks = carveBlocks(data);
const cli = blocks.find((b) => (b.name || '').endsWith('entrypoints/cli.js'));
if (!cli) {
  console.error(`make-min-provider: no entrypoints/cli.js @bun-cjs block in ${inPath} (format changed?)`);
  process.exit(1);
}
console.error(`make-min-provider: carved entrypoints/cli.js: ${cli.body.length} bytes (from a ${data.length}-byte provider)`);

// Reconstruct the minimal carvable form carveBlocks/extract expect:
//   <name>\0 // @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {<body>})\0
// nearestName() scans back <=4KB for `...js\0`; the body runs to the next \0 and
// gets a trailing `})` stripped — so re-append `})` and a NUL.
const NUL = '\x00';
const marker = '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {';
const synth = 'entrypoints/cli.js' + NUL + marker + cli.body + '})' + NUL;
fs.writeFileSync(outPath, Buffer.from(synth, 'latin1'));
console.error(`make-min-provider: wrote ${outPath}: ${synth.length} bytes`);

// Self-check: re-carve the synthetic file; the cli.js body must round-trip.
const rt = carveBlocks(fs.readFileSync(outPath, 'latin1'));
const rtCli = rt.find((b) => (b.name || '').endsWith('entrypoints/cli.js'));
if (!rtCli || rtCli.body.length !== cli.body.length) {
  console.error(`make-min-provider: SELF-CHECK FAILED — re-carve got ${rtCli ? rtCli.body.length : 'none'} vs ${cli.body.length}`);
  process.exit(1);
}
console.error('make-min-provider: self-check ok (synthetic provider re-carves to the same cli.js body)');
