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

// TWO SHAPES. Through 2.1.241 a provider carves to ONE @bun-cjs block and the synthetic
// form below reproduces it. From 2.1.243 it is a code-split ESM graph with no such block,
// and this script exited 1 with "format changed?" — which is what broke the netbsd-sparc
// leg on 2026-08-25, the ONE leg that needs a minimised provider at all.
//
// The split shape needs a real (if minimal) Bun container: the module table plus the
// Offsets struct and trailer, so libexec/bun-graph.cjs can decode it. We keep only the JS
// module rows and drop the bytecode blobs, sourcePaths and non-JS assets — which is where
// the size goes. Rows are emitted in the layout bun-graph asserts:
//     [name]\0[contents]\0   with contents at name.off + name.len + 1
// and the whole file is laid out base=0, so every offset is a file offset.
function writeMinSplitProvider(inPath, outPath) {
  const { loadGraphFull } = require(path.join(__dirname, '..', 'libexec', 'bun-graph.cjs'));
  const g = loadGraphFull(inPath);
  const src = fs.readFileSync(inPath);
  const rows = g.rows.filter((r) => r.loader === 1);
  if (!rows.length) throw new Error('no js-loader rows in the module table');

  const enc = new TextEncoder();
  const chunks = [];
  const meta = [];
  let off = 0;
  for (const r of rows) {
    const name = enc.encode(r.name);
    const body = src.subarray(r.contentsStart, r.contentsEnd);
    meta.push({ nameOff: off, nameLen: name.length,
                bodyOff: off + name.length + 1, bodyLen: body.length,
                loader: r.loader, moduleFormat: r.moduleFormat, name: r.name });
    chunks.push(name, Uint8Array.of(0), body, Uint8Array.of(0));
    off += name.length + 1 + body.length + 1;
  }
  const dataLen = off;
  const tableOff = dataLen;
  const table = new Uint8Array(rows.length * 52);
  const dv = new DataView(table.buffer);
  meta.forEach((m, i) => {
    const b = i * 52;
    dv.setUint32(b + 0, m.nameOff, true);  dv.setUint32(b + 4, m.nameLen, true);
    dv.setUint32(b + 8, m.bodyOff, true);  dv.setUint32(b + 12, m.bodyLen, true);
    // +16 must be {0,0}; +24/+32/+40 (blobA/blobB/sourcePath) stay empty — that is the
    // whole size win, and bun-graph skips empty fields in its contiguity walk.
    table[b + 49] = m.loader;
    table[b + 50] = m.moduleFormat;
  });
  const entryIdx = meta.findIndex((m) => m.name === g.entryName);
  if (entryIdx < 0) throw new Error(`entry ${g.entryName} is not a js row`);

  const h = tableOff + table.length + 1;            // 1 pad byte, as real containers have
  const offs = new Uint8Array(32);
  const odv = new DataView(offs.buffer);
  odv.setBigUint64(0, BigInt(h), true);             // byteCount, with base = 0
  odv.setUint32(8, tableOff, true);
  odv.setUint32(12, table.length, true);
  odv.setUint32(16, entryIdx, true);

  const TRAILER = enc.encode('\n---- Bun! ----\n');
  const out = Buffer.concat([
    ...chunks.map((c) => Buffer.from(c)),
    Buffer.from(table), Buffer.alloc(1), Buffer.from(offs), Buffer.from(TRAILER),
  ]);
  fs.writeFileSync(outPath, out);
  return { modules: rows.length, bytes: out.length, entry: g.entryName, from: src.length };
}

const { isSplitBundle } = require(path.join(__dirname, '..', 'libexec', 'extract-claude-js.cjs'));
if (isSplitBundle(inPath)) {
  let r;
  try { r = writeMinSplitProvider(inPath, outPath); }
  catch (e) {
    console.error(`make-min-provider: could not minimise the code-split provider ${inPath}: ${e.message}`);
    process.exit(1);
  }
  console.error(`make-min-provider: ${r.modules} modules -> ${outPath}: ${r.bytes} bytes (from ${r.from})`);
  // SELF-CHECK, same contract as the CJS path: the product must decode to the same graph.
  const check = require(path.join(__dirname, '..', 'libexec', 'bun-graph.cjs')).loadGraph(outPath);
  if (check.size !== r.modules) {
    console.error(`make-min-provider: SELF-CHECK FAILED — re-decode got ${check.size} modules, wanted ${r.modules}`);
    process.exit(1);
  }
  if (!isSplitBundle(outPath)) {
    console.error('make-min-provider: SELF-CHECK FAILED — the minimised provider is not recognised as split');
    process.exit(1);
  }
  console.error(`make-min-provider: self-check ok (${check.size} modules, entry ${r.entry})`);
  process.exit(0);
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
