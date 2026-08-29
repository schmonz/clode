'use strict';
// Keeps libexec/update-guard.cjs's SUBCOMMANDS honest against what upstream
// actually registers.
//
// WHY IT READS graph.json AND NOT cli.cjs. Until Claude Code 2.1.243 the carve
// WAS the source: `cli.cjs` was one flat bundle and `.command("doctor")` sat in
// it verbatim. From 2.1.243 upstream ships a code-split ESM graph, and clode's
// cli.cjs is a GRAPH RUNNER it generates: every module's source is embedded as a
// JSON string inside a JS string literal, so the same registration arrives as
//
//     d.command(\\\"add-from-claude-desktop\\\")      <- cli.cjs, 3 backslashes
//     d.command(\"add-from-claude-desktop\")          <- graph.json, 1 backslash
//
// Both counts are things this file would have to KNOW, and both change whenever
// the runner's wrapper changes. That is the actual defect: pattern-matching a
// DERIVED artifact for something that belongs to the SOURCE. graph.json carries
// `sources` as real strings — JSON.parse hands back exactly what upstream wrote,
// no escape level to track — so the scan cannot rot the next time the wrapper
// does. Pre-split carves (no graph.json) are still scanned as flat text.
//
// This measured ZERO command names against 2.1.243 and 2.1.251, in every escape
// form, and so demanded the removal of every real subcommand — a gate asserting
// the bundle registers nothing. It had been subtracted from the local suite's
// count as "the baseline" for weeks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SUBCOMMANDS } = require('../libexec/update-guard.cjs');

// DELIBERATELY the highest cached VERSION, not the most recently written file.
// Selecting by mtime (what this did until 2026-08-29) means a re-carve of an old
// provider silently retargets the gate: on this box 2.1.243's cli.cjs was newer
// on disk than 2.1.251's, so the gate was answering about a version two releases
// back without saying so. The gate's question is "has UPSTREAM drifted", so the
// newest upstream we hold is the right subject — and the test says which.
function newestCarve() {
  const root = path.join(os.homedir(), '.cache', 'clode');
  if (!fs.existsSync(root)) return null;
  const cands = [];
  for (const d of fs.readdirSync(root)) {
    if (!/^\d+(?:\.\d+)*$/.test(d)) continue;
    const graph = path.join(root, d, 'graph.json');
    const flat = path.join(root, d, 'cli.cjs');
    if (fs.existsSync(graph)) cands.push({ version: d, file: graph, split: true });
    else if (fs.existsSync(flat)) cands.push({ version: d, file: flat, split: false });
  }
  if (!cands.length) return null;
  const key = (v) => v.split('.').map(Number);
  cands.sort((a, b) => {
    const x = key(a.version); const y = key(b.version);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const d = (y[i] || 0) - (x[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return cands[0];
}

// The four shapes a command keyword reaches commander in. All four are matched
// against REAL source text, so they say what they mean.
//
//   .command("doctor")            registration (may carry args: "init <name>")
//   .alias("kill")                single alias
//   .aliases(["rm","remove"])     literal alias list
//   usage:"plugin prune",aliases:["autoremove"]
//                                 2.1.243 moved `claude plugin`'s sub-subcommand
//                                 metadata into a declaration table and passes it
//                                 as `.aliases($H.prune.aliases)`, so the literal
//                                 array no longer sits at the call site. Anchored
//                                 on the sibling `usage:` key because a bare
//                                 `aliases:[...]` also matches highlight.js
//                                 language tables and slash-command decls — 248
//                                 "subcommands" including `xhtml` and `pycon`.
//
// Over-inclusion is the safe direction here and is why nested names are kept:
// shouldInjectGuard() only consults argv[0], and a name MISSING from SUBCOMMANDS
// is the harmful case (the guard's --settings gets injected into a subcommand
// that rejects it). An extra name costs nothing.
function scanSource(src, names) {
  for (const m of src.matchAll(/\.command\(["']([a-z][a-z0-9-]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\.alias\(["']([a-z][a-z0-9-]*)["']\)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\.aliases\(\[([^\]]*)\]/g)) {
    for (const a of m[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)) names.add(a[1]);
  }
  for (const m of src.matchAll(/usage:\s*["'][^"']*["']\s*,\s*aliases:\s*\[([^\]]*)\]/g)) {
    for (const a of m[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)) names.add(a[1]);
  }
  return names;
}

function carveSubcommands(carve) {
  const names = new Set();
  if (!carve.split) {
    scanSource(fs.readFileSync(carve.file, 'latin1'), names);
    return names;
  }
  const doc = JSON.parse(fs.readFileSync(carve.file, 'utf8'));
  const sources = doc && doc.sources;
  assert.ok(sources && typeof sources === 'object',
    `${carve.file} has no \`sources\` map — the graph shape changed; this scan is blind`);
  for (const src of Object.values(sources)) {
    if (typeof src === 'string') scanSource(src, names);
  }
  return names;
}

test('SUBCOMMANDS matches the bundle-registered command + alias names', (t) => {
  const carve = newestCarve();
  if (!carve) { t.skip('no cached carve under ~/.cache/clode/<version>/'); return; }
  t.diagnostic(`scanning ${carve.version} (${path.basename(carve.file)})`);

  const got = carveSubcommands(carve);
  // A scan that finds nothing is a broken scan, not an empty bundle. Without
  // this the gate's own failure mode is indistinguishable from real drift —
  // exactly how it spent weeks demanding the deletion of every subcommand.
  assert.ok(got.size > 20,
    `found only ${got.size} command names in ${carve.version} — the SCANNER is broken,`
    + ' not upstream. Do not act on the diff below until this is above 20.');

  const missing = [...got].filter((n) => !SUBCOMMANDS.has(n)).sort();
  const extra = [...SUBCOMMANDS].filter((n) => !got.has(n)).sort();
  assert.deepStrictEqual(
    { missing, extra }, { missing: [], extra: [] },
    `SUBCOMMANDS drifted from ${carve.version}:\n`
    + `  add to SUBCOMMANDS: ${JSON.stringify(missing)}\n`
    + `  remove from SUBCOMMANDS: ${JSON.stringify(extra)}\n`
    + '  Both libexec/update-guard.cjs and libexec/quaude-bootstrap.mjs carry the'
    + ' guardGating block; they are drift-tested against each other, so edit both.');
});
