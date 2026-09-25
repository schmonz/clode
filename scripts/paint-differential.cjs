#!/usr/bin/env node
'use strict';
// Run ours vs native over the paint corpus and print classified counts. Phase 5's progress
// meter: run it before a change and after.
//
//   node scripts/paint-differential.cjs --native BIN [--part NAME] [--out DIR]
//
// Exit 0 when identical, 1 when paint()/setCell() differ, 2 on harness failure.
const fs = require('node:fs');
const path = require('node:path');
const { paintCorpus } = require('./lib/paint-corpus.cjs');
const { runPaintNative, runPaintOurs, comparePaintResults } = require('./lib/paint-probe.cjs');

function main(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') o.native = argv[++i];
    else if (argv[i] === '--part') o.part = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else { process.stderr.write(`paint-differential: unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!o.native) { process.stderr.write('usage: paint-differential.cjs --native BIN [--part NAME] [--out DIR]\n'); return 2; }
  let scenarios = paintCorpus();
  if (o.part) scenarios = scenarios.filter((s) => s.part === o.part);
  if (scenarios.length === 0) { process.stderr.write(`paint-differential: no scenarios for part ${o.part}\n`); return 2; }
  // A thrown error (a missing/refusing native binary, a tjs launch failure, an empty
  // corpus) is a HARNESS failure, distinct from "differences were found" (exit 1) — both
  // runPaintNative and runPaintOurs throw plain Errors, never exit the process themselves.
  let native, ours;
  try {
    native = runPaintNative(o.native, scenarios);
    ours = runPaintOurs(scenarios);
  } catch (e) {
    process.stderr.write(`paint-differential: ${e && e.message ? e.message : e}\n`);
    return 2;
  }
  const d = comparePaintResults(scenarios, native, ours);
  // Per-part counts computed directly from the already-fetched results (sliced by index),
  // not by parsing `d.findings`: the summary's findings list is capped at 200, so parsing
  // it would silently undercount a part once the cap is hit.
  const perPart = {};
  const byPart = new Map();
  scenarios.forEach((sc, i) => { if (!byPart.has(sc.part)) byPart.set(sc.part, []); byPart.get(sc.part).push(i); });
  for (const [part, idxs] of byPart) {
    const scPart = idxs.map((i) => scenarios[i]);
    const nativePart = { runtime: native.runtime, results: idxs.map((i) => native.results[i]) };
    const oursPart = { runtime: ours.runtime, results: idxs.map((i) => ours.results[i]) };
    perPart[part] = comparePaintResults(scPart, nativePart, oursPart).count;
  }
  if (o.out) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, 'paint.json'), JSON.stringify({ native, ours, d, perPart }));
  }
  process.stdout.write(`paint: examined ${d.examined} ops over ${scenarios.length} scenarios `
    + `(${native.runtime} vs ${ours.runtime}) differing=${d.count}\n`);
  for (const [part, n] of Object.entries(perPart)) process.stdout.write(`  ${part}: ${n}\n`);
  for (const f of d.findings.slice(0, 20)) process.stdout.write(`  ${f}\n`);
  return d.count ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
