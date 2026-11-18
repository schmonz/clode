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
//
// 2026-09-05 (task-8 fix round 1): "the highest cached VERSION" was the wrong axis.
// It fixed the mtime bug (a re-carve of an old provider retargeting the gate
// silently) but conflated "newest we happen to hold" with "the version we actually
// ship against." Measured on the dev box: with 2.1.246/250/251/252 cached and
// UPSTREAM_PIN naming 2.1.251, the old newestCarve() picked 2.1.252 — one version
// PAST the pin, which is exactly the axis UPSTREAM_PIN's own comment warns is
// deliberately NOT absorbed for the versions ahead of it (2.1.257 breaks the SCC
// merger outright; 2.1.252/2.1.257 lie strictly outside what `clode build` ships).
// Placing this gate into node-shim-oracle (task-8) sharpened the defect into a
// contradiction: the CI seed step populates ONLY the pin, so CI would report on
// 2.1.251 while a dev box with a broader cache reports on whatever is newest there
// — one gate, two different bundles, nothing in the output saying so. That
// violates this project's own standing condition verbatim ("the suite tests the
// PINNED provider, exactly, or says why it cannot") — the same fix Task 3 round 5
// made for the wall tripwires, applied here. So: select the version UPSTREAM_PIN
// names (via test/provider-resolve.cjs's pinnedVersion(), not a re-derived
// literal), and SKIP — never fall back to "highest" — when that exact version
// isn't cached, naming the pin and what was actually found. Within the pinned
// version's own directory there is exactly one cache entry (keyed by version, not
// write time), so the retired mtime-vs-highest ordering no longer has anything to
// choose between — see the task-8 report for the full trace.
const fs = require('node:fs');
const { userCacheDir } = require('./suite-home.cjs');
const os = require('node:os');
const path = require('node:path');
const { SUBCOMMANDS } = require('../libexec/update-guard.cjs');
const { pinnedVersion } = require('./provider-resolve.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

// The CACHED carve for the version UPSTREAM_PIN names — never "highest cached"
// (see the dated note above) and never mtime. Returns { carveFile, split, version }
// on a hit or { skip: reason } naming the pin and what the cache actually holds —
// a verdict about the wrong bundle is worse than no verdict, so absence is
// reported, not papered over with a substitute version.
function pinnedCarve() {
  const pin = pinnedVersion();
  if (!pin) return { skip: 'UPSTREAM_PIN is missing or malformed — no pinned version to scan' };
  const root = userCacheDir();
  const have = fs.existsSync(root)
    ? fs.readdirSync(root).filter((d) => /^\d+(?:\.\d+)*$/.test(d)
        && (fs.existsSync(path.join(root, d, 'graph.json')) || fs.existsSync(path.join(root, d, 'cli.cjs'))))
    : [];
  const dir = path.join(root, pin);
  const graph = path.join(dir, 'graph.json');
  const flat = path.join(dir, 'cli.cjs');
  if (fs.existsSync(graph)) return { carveFile: graph, split: true, version: pin };
  if (fs.existsSync(flat)) return { carveFile: flat, split: false, version: pin };
  return { skip: `UPSTREAM_PIN names ${pin}; cache under ~/.cache/clode/ holds `
    + `${have.length ? have.sort().join(', ') : '(nothing usable)'}. Build or fetch ${pin} `
    + '(e.g. `clode build`, or run this suite\'s node-shim-oracle CI seed step) — never '
    + 'substituted with a different cached version.' };
}

// The four shapes a command keyword reaches commander in. All four are matched
// against REAL source text, so they say what they mean. PURE.
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

// PURE: `rawContent` is the already-read carve bytes; `subcommands` is
// libexec/update-guard.cjs's SUBCOMMANDS, already loaded by read().
function scanSubcommands({ rawContent, split, subcommands }) {
  const names = new Set();
  if (split) {
    const doc = JSON.parse(rawContent);
    const sources = doc && doc.sources;
    if (!sources || typeof sources !== 'object') {
      return { findings: [`the graph has no \`sources\` map — the graph shape changed; this scan is blind`], examined: 0 };
    }
    for (const src of Object.values(sources)) {
      if (typeof src === 'string') scanSource(src, names);
    }
  } else {
    scanSource(rawContent, names);
  }

  const missing = [...names].filter((n) => !subcommands.has(n)).sort();
  const extra = [...subcommands].filter((n) => !names.has(n)).sort();
  const findings = [];
  if (missing.length || extra.length) {
    findings.push(`SUBCOMMANDS drifted:\n  add to SUBCOMMANDS: ${JSON.stringify(missing)}\n`
      + `  remove from SUBCOMMANDS: ${JSON.stringify(extra)}\n`
      + '  Both libexec/update-guard.cjs and libexec/quaude-bootstrap.mjs carry the'
      + ' guardGating block; they are drift-tested against each other, so edit both.');
  }
  // examined = names.size, floored at 21 by the guard below: a scan that finds
  // fewer than 20 command names is a BROKEN SCANNER, not an empty bundle — without
  // this the gate's own failure mode would be indistinguishable from real drift,
  // exactly how it spent weeks demanding the deletion of every subcommand.
  return { findings, examined: names.size };
}

const guard = defineGuard({
  name: 'guard-subcommands-gate',
  // RE-CUT (coordinator, I2, 2026-09-04): floor 21 vs a measured 54 unique names is
  // exactly the wrong-direction looseness the whole-branch review named — this scanner
  // is CORPUS-driven (it walks the pinned carve's real `sources`), so a broken walk
  // (wrong graph key, an escape-level regression like the one this file's own header
  // documents) shrinks `examined` SILENTLY, and 21 was already cleared by the
  // control's synthetic 22-name fixture, not by anything about today's real corpus.
  // 45 sits close to the measured 54 (comfortable margin for a subcommand or two
  // coming/going between provider bumps) while still catching a walk that quietly
  // regresses to reading only PART of the real command surface.
  floor: 45,
  read: () => {
    const carve = pinnedCarve();
    if (carve.skip) return { skip: carve.skip };
    return {
      rawContent: fs.readFileSync(carve.carveFile, carve.split ? 'utf8' : 'latin1'),
      split: carve.split,
      subcommands: SUBCOMMANDS,
    };
  },
  scan: scanSubcommands,
  // Models the real drift this gate exists to catch: the bundle registers a
  // command SUBCOMMANDS does not know about. Padded with 21 known dummy names
  // so the control also clears the floor (a scan finding too few names is a
  // broken scanner, not a real answer).
  control: () => {
    const known = Array.from({ length: 21 }, (_, i) => `known-cmd-${i}`);
    const subcommands = new Set(known);
    const rawContent = known.map((n) => `.command("${n}")`).join('\n')
      + '\n.command("totally-new-unlisted-command")\n';
    return { rawContent, split: false, subcommands };
  },
});
guardTests(guard);

// ---------------------------------------------------------------------------------------------------------------------
// THE OPTION TABLE (grep-native sandbox round 3, I1). shouldInjectGuard() decides "is argv a subcommand?" by the
// bundle's own rule: skip option VALUES, then read the first positional. Which options take a value is a hand copy in
// libexec/update-guard.cjs (VALUE_OPTIONS / VARIADIC_OPTIONS / OPTIONAL_VALUE_OPTIONS), so this guard derives the same
// three sets from the pinned carve and reports any difference. A missing value option is the harmful direction (its
// value read as a subcommand skips the update guard and the sandbox fail-closed setting); an extra one is harmful too
// (a real subcommand after a boolean flag would get --settings, which subcommands reject). So: equality.
//
// Two sources in the carve, both upstream's own:
//   - the eager argv scanner (the module whose first-positional helper the bundle uses for `mcp`): three Sets, told
//     apart by content — the one holding "--settings" (takes a value), the one holding "--add-dir" but not
//     "--settings" (variadic), the one holding "--resume" (optional value);
//   - commander's ROOT program (`X.name("claude")`): every `.option("…")` / `.addOption(new C("…"))` on its chain and on
//     the root object, `<v>` required, `[v]` optional, `...` variadic. What dispatches subcommands is commander, so a
//     root option that takes a value and is missing from the eager scanner (2.1.283: --attach-serve,
//     --project-config-root) belongs in the table too.
function optionNamesOf(spec) {
  const head = spec.split(/[<[]/)[0];
  return [...head.matchAll(/(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]);
}
function scanOptionTable({ sources, table }) {
  const findings = [];
  let eager = null;
  let root = null;
  for (const src of sources) {
    if (!eager && src.includes('"--prefill"') && src.includes('"--settings"')) {
      const sets = [...src.matchAll(/new Set\(\[([^\]]*)\]\)/g)].map((m) => new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])));
      const value = sets.find((s) => s.has('--settings'));
      const variadic = sets.find((s) => s.has('--add-dir') && !s.has('--settings'));
      const optional = sets.find((s) => s.has('--resume'));
      if (value && variadic && optional) eager = { value, variadic, optional };
    }
    const m = !root && /let ([\w$]+)=([\w$]+)\.name\("claude"\)/.exec(src);
    if (m) {
      const [, chainVar, rootVar] = m;
      const end = src.indexOf(`${chainVar}.action(`, m.index);
      const chain = src.slice(m.index, end === -1 ? undefined : end);
      const esc = rootVar.replace(/\$/g, '\\$');
      const specs = [
        ...[...chain.matchAll(/\.(?:option\(|addOption\(new [\w$]+\()"([^"]+)"/g)].map((x) => x[1]),
        ...[...src.matchAll(new RegExp(`(?<![\\w$.])${esc}\\.(?:option\\(|addOption\\(new [\\w$]+\\()"([^"]+)"`, 'g'))].map((x) => x[1]),
      ];
      root = { required: new Set(), optional: new Set(), variadic: new Set(), count: specs.length };
      for (const spec of specs) {
        const names = optionNamesOf(spec);
        if (/</.test(spec)) names.forEach((n) => root.required.add(n));
        else if (/\[/.test(spec)) names.forEach((n) => root.optional.add(n));
        if (/\.\.\.[>\]]/.test(spec)) names.forEach((n) => root.variadic.add(n));
      }
    }
  }
  if (!eager) return { findings: ['the eager argv scanner\'s three option Sets were not found in the carve: this scan is blind'], examined: 0 };
  if (!root) return { findings: ['commander\'s root program (`.name("claude")`) was not found in the carve: this scan is blind'], examined: 0 };
  const union = (a, b) => new Set([...a, ...b]);
  const want = {
    VALUE_OPTIONS: union(eager.value, [...root.required].filter((n) => !eager.optional.has(n))),
    VARIADIC_OPTIONS: union(eager.variadic, root.variadic),
    OPTIONAL_VALUE_OPTIONS: union(eager.optional, [...root.optional].filter((n) => !eager.value.has(n))),
  };
  for (const [name, w] of Object.entries(want)) {
    const have = table[name];
    const add = [...w].filter((n) => !have.has(n)).sort();
    const drop = [...have].filter((n) => !w.has(n)).sort();
    if (add.length || drop.length) {
      findings.push(`${name} drifted from the carve:\n  add: ${JSON.stringify(add)}\n  remove: ${JSON.stringify(drop)}\n`
        + '  libexec/update-guard.cjs and libexec/quaude-bootstrap.mjs carry the guardGating block (drift-tested); edit both.');
    }
  }
  return { findings, examined: want.VALUE_OPTIONS.size + want.VARIADIC_OPTIONS.size + want.OPTIONAL_VALUE_OPTIONS.size,
    note: `${eager.value.size}/${eager.variadic.size}/${eager.optional.size} eager-scanner options, ${root.count} commander root option specs` };
}

const ug = require('../libexec/update-guard.cjs');
const optionTableGuard = defineGuard({
  name: 'guard-option-table-gate',
  // Measured on the pinned 2.1.283 carve: 84 value + 11 variadic + 14 optional = 109. The floor catches a scan that
  // finds only part of either source (the control's fixture examines 4).
  floor: 90,
  read: () => {
    const carve = pinnedCarve();
    if (carve.skip) return { skip: carve.skip };
    if (!carve.split) return { skip: `the pinned carve ${carve.version} is not a split graph: this scan reads graph.json's sources` };
    const doc = JSON.parse(fs.readFileSync(carve.carveFile, 'utf8'));
    return {
      sources: Object.values(doc.sources || {}).filter((s) => typeof s === 'string'),
      table: { VALUE_OPTIONS: ug.VALUE_OPTIONS, VARIADIC_OPTIONS: ug.VARIADIC_OPTIONS, OPTIONAL_VALUE_OPTIONS: ug.OPTIONAL_VALUE_OPTIONS },
    };
  },
  scan: scanOptionTable,
  // The real drift: upstream adds a root option that takes a value (here `--new-thing <x>`) the table does not know.
  control: () => ({
    sources: [
      'var i=new Set(["--prefill","--settings"]),Z=new Set(["--add-dir"]),a=new Set(["--resume"]);',
      'let P=e.name("claude").option("--settings <file-or-json>","").option("--new-thing <x>","");P.action(()=>{})',
    ],
    table: {
      VALUE_OPTIONS: new Set(['--prefill', '--settings']), VARIADIC_OPTIONS: new Set(['--add-dir']),
      OPTIONAL_VALUE_OPTIONS: new Set(['--resume']),
    },
  }),
});
guardTests(optionTableGuard);
