'use strict';
// The naude ASSEMBLER runs as loose scripts under a fetched node inside a fused
// clode-native (NO scripts/ dir of its own) — libexec/quaude-fuse.js carries an
// explicit list of `scripts/*` members and clode-fuse materializes them. If a staged
// script gains a repo-local sibling require that ISN'T in that list, the miss is
// INVISIBLE to a dev-checkout build (the file is right there on disk) and only
// explodes under clode-native as "Cannot find module './X.cjs'" — the node-shim
// oracle's acceptance 4, a ~26s live build. This guard closes that gap statically:
// BFS the relative-require closure of the assembler entry and assert every sibling
// is a carried member. (Regression: platform-tag.cjs gained ./canonical-name.cjs.)
//
// MEASURED 2026-09-04: the closure check above only ever covered HALF the failure
// mode. Removing 'canonical-name.cjs', 'build-scratch.cjs' or 'build-naude.mjs' from
// the carried-member loop (libexec/quaude-fuse.js:211) made this test RED, as
// designed. But removing 'merge-step.mjs' or 'sea-sign.cjs' — LEAF members nothing
// relatively requires — left it GREEN: the guard checked closure, not membership. A
// dropped leaf does not fail a test; it kills a --self-fused build at tjs.spawn, in
// the field, with no signal. This file now also derives, from real use sites, every
// scripts/<name> the worker (or a carried script) REACHES FOR at runtime and asserts
// each one is carried — see scriptsDirUses() below for why that derivation is scoped
// to the carried set's require-closure rather than all of scripts/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');

// Parsed from quaude-fuse.js's builder-role loop so the test tracks the ACTUAL
// source (not a hand-copy that could drift the other way).
// for (const f of ['build-naude.mjs', 'platform-tag.cjs', 'canonical-name.cjs', 'sea-sign.cjs']) {
function parseCarriedMembers(fuseSrc) {
  const m = fuseSrc.match(/for \(const f of \[([^\]]*)\]\)\s*\{\s*\n?\s*members\.push\(\{ name: `scripts\//);
  if (!m) {
    // A parse failure must be a FINDING-bearing broken state, not a silent empty list —
    // an empty member list would make every closure check trivially pass.
    throw new Error('could not locate the naude-assembler member loop in quaude-fuse.js — '
      + 'the loop moved or changed shape; this guard is blind until the pattern is updated');
  }
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// Every `require('./x.cjs')` / `import … from './x.mjs'` that resolves to a sibling
// in scripts/ (relative, same dir). Node builtins / bare specifiers / node_modules
// are NOT carried as script members (handled elsewhere), so ignore non-relative.
function siblingRequires(src) {
  const out = new Set();
  const re = /(?:require\(|from\s+)['"]\.\/([A-Za-z0-9_.-]+\.(?:c?js|mjs))['"]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

// Every scripts/<name> the worker or a carried script REACHES FOR at runtime. Two shapes,
// both real and both measured: path.join(scriptsDir, 'x') in quaude-fuse.js:318, and
// path.join(REPO, 'scripts', 'x') in build-naude.mjs:415. Returns [where, name] pairs.
//
// SCOPED TO WHAT IS REACHABLE, and this is not optional. Prototyped against the real tree
// 2026-09-04: scanning EVERY file in scripts/ yields five false positives
// (probe-run.mjs -> probe-run-preload.cjs / apicheck.mjs, stage-provider.mjs ->
// find-provider.mjs / make-min-provider.cjs) because those scripts are not carried and
// never run inside a fused builder. Scoped to the carried set plus its require-closure the
// same derivation reports ZERO findings on a clean tree and still finds both real sites.
function scriptsDirUses(fuseSrc, scriptSources, members) {
  const reachable = new Set(members);
  const queue = [...members];
  while (queue.length) {
    const f = queue.shift();
    const body = scriptSources[f];
    if (body === undefined) continue;
    for (const dep of siblingRequires(body)) {
      if (!reachable.has(dep)) { reachable.add(dep); queue.push(dep); }
    }
  }
  const out = [];
  const re = /path\.join\(\s*(?:scriptsDir|[A-Za-z_$][\w$]*\s*,\s*['"]scripts['"])\s*,\s*['"]([A-Za-z0-9_.-]+\.(?:c?js|mjs))['"]\s*\)/g;
  const scan = (where, src) => {
    let m; re.lastIndex = 0;
    while ((m = re.exec(src))) out.push([where, m[1]]);
  };
  scan('quaude-fuse.js', fuseSrc);   // the worker is ALWAYS scanned
  for (const name of reachable) {
    if (scriptSources[name] !== undefined) scan(name, scriptSources[name]);
  }
  return out;
}

function readScriptsDir() {
  const out = {};
  for (const name of fs.readdirSync(SCRIPTS)) {
    if (!/\.(c?js|mjs)$/.test(name)) continue;
    try { out[name] = fs.readFileSync(path.join(SCRIPTS, name), 'utf8'); } catch { /* not a file */ }
  }
  return out;
}

// PURE. Inputs: the quaude-fuse.js source text, and a map of scripts/ filename -> source.
// Two DISTINCT properties, because measuring this guard on 2026-09-04 showed it only ever
// had the first one:
//   closure   — every relative sibling require of a carried script is itself carried
//   membership— every carried name actually exists in scripts/, AND every script the
//               worker (or a carried script) actually REACHES FOR is carried
// The blind half was closure-only: a LEAF member (merge-step.mjs, sea-sign.cjs) could be
// dropped from the list with the guard silent, and a dropped member does not fail a test —
// it fails a --self-fused build at tjs.spawn, in the field, with no signal.
//
// `examined` counts each carried member TWICE — once in the membership loop below, once
// again as a BFS node in the closure loop — because those are two genuinely distinct
// checks over the same member (does it exist / does its require graph stay closed), not
// one check counted twice. Not dishonest, but not 1:1 with "how many files" either: mind
// this if a floor tighter than 1 is ever set against this guard's `examined` count.
function scanAssembler({ fuseSrc, scriptSources }) {
  const members = parseCarriedMembers(fuseSrc);
  const findings = [];
  let examined = 0;

  // REQUIREDNESS (the half that was blind): every script the worker actually REACHES FOR
  // must be carried. Derived from use sites, never declared — `path.join(scriptsDir, 'X')`
  // in quaude-fuse.js (:318 reaches merge-step.mjs) and the same shape inside any carried
  // script (build-naude.mjs:415 reaches sea-sign.cjs). This is what catches a dropped LEAF.
  for (const [where, name] of scriptsDirUses(fuseSrc, scriptSources, members)) {
    examined++;
    if (!members.includes(name)) {
      findings.push(`${where} reaches scripts/${name}, which is NOT a carried member `
        + `(a fused builder will die at that call with ENOENT)`);
    }
  }

  // membership: a carried name that is not a real file
  for (const m of members) {
    examined++;
    if (!Object.prototype.hasOwnProperty.call(scriptSources, m)) {
      findings.push(`carried member '${m}' does not exist in scripts/`);
    }
  }

  // closure: BFS the relative-require graph from every carried script
  const memberSet = new Set(members);
  const seen = new Set();
  const queue = [...members];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = scriptSources[f];
    if (src === undefined) continue;
    examined++;
    for (const dep of siblingRequires(src)) {
      if (!memberSet.has(dep)) {
        findings.push(`${f} -> ./${dep} (not a carried member)`);
      }
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'naude-assembler-closure',
  read: () => ({
    fuseSrc: fs.readFileSync(path.join(REPO, 'libexec', 'quaude-fuse.js'), 'utf8'),
    scriptSources: readScriptsDir(),
  }),
  scan: scanAssembler,
  // I2 (coordinator, 2026-09-04): scriptSources comes from a real DIRECTORY WALK
  // (readScriptsDir()), so unlike a fixed-file table-driven guard this one's `examined`
  // can shrink for a legitimate reason (scripts refactored/consolidated) as well as a
  // broken one (scripts/ misresolved, the closure BFS short-circuiting). Measured 14
  // today; floored at 10 rather than exact, for the same reason the corpus-driven
  // guards above got a margin instead of an exact match.
  floor: 10,
  // The control models the DANGEROUS case measured on 2026-09-04: a script the worker
  // REACHES FOR that is not carried. A control modelling only the sibling-require case
  // would pass against the pre-phase-5 guard, certifying one that was half blind.
  control: () => ({
    fuseSrc: "for (const f of ['build-naude.mjs']) {\n    members.push({ name: `scripts/"
      + "\nconst p = path.join(scriptsDir, 'merge-step.mjs');",
    scriptSources: { 'build-naude.mjs': '' },
  }),
});
guardTests(guard);

test('regression: a dropped LEAF member is reported (BLIND until 2026-09-04)', () => {
  // merge-step.mjs is spawned via path.join(scriptsDir, 'merge-step.mjs') but nothing
  // REQUIRES it, so the closure-only scan was silent — and a dropped member does not fail
  // a test, it kills a --self-fused build at tjs.spawn in the field.
  const r = scanAssembler({
    fuseSrc: "for (const f of ['build-naude.mjs']) {\n    members.push({ name: `scripts/"
      + "\nconst p = path.join(scriptsDir, 'merge-step.mjs');",
    scriptSources: { 'build-naude.mjs': '' },
  });
  assert.deepStrictEqual(r.findings, [
    'quaude-fuse.js reaches scripts/merge-step.mjs, which is NOT a carried member '
    + '(a fused builder will die at that call with ENOENT)',
  ]);
});

test('regression: a leaf reached from a CARRIED SCRIPT is reported too', () => {
  // build-naude.mjs:415 reaches sea-sign.cjs the same way. A derivation that only read
  // quaude-fuse.js would still be blind to this one.
  const r = scanAssembler({
    fuseSrc: "for (const f of ['build-naude.mjs']) {\n    members.push({ name: `scripts/",
    scriptSources: {
      'build-naude.mjs': "spawn(node, [path.join(REPO, 'scripts', 'sea-sign.cjs'), phase]);",
    },
  });
  assert.deepStrictEqual(r.findings, [
    'build-naude.mjs reaches scripts/sea-sign.cjs, which is NOT a carried member '
    + '(a fused builder will die at that call with ENOENT)',
  ]);
});

test('a use site in an UNREACHABLE script is not a finding', () => {
  // probe-run.mjs and stage-provider.mjs reach for scripts that are not carried, and that
  // is correct — they never run inside a fused builder. Scanning all of scripts/ produced
  // five such false positives when this was prototyped; scoping to the reachable set
  // removed all five without losing either real site.
  const r = scanAssembler({
    fuseSrc: "for (const f of ['build-naude.mjs']) {\n    members.push({ name: `scripts/",
    scriptSources: {
      'build-naude.mjs': '',
      'probe-run.mjs': "path.join(REPO, 'scripts', 'apicheck.mjs')",   // not carried, not reachable
    },
  });
  assert.deepStrictEqual(r.findings, []);
});

test('a member that IS carried and IS reached produces no finding', () => {
  const r = scanAssembler({
    fuseSrc: "for (const f of ['build-naude.mjs', 'merge-step.mjs']) {\n    members.push({ name: `scripts/"
      + "\nconst p = path.join(scriptsDir, 'merge-step.mjs');",
    scriptSources: { 'build-naude.mjs': '', 'merge-step.mjs': '' },
  });
  assert.deepStrictEqual(r.findings, []);
  // Exact, not a loose lower bound: 1 use site (quaude-fuse.js -> merge-step.mjs) + 2
  // members counted in the membership loop + 2 members counted again in the closure BFS
  // (see the double-count note on scanAssembler) = 5. A strict count catches a change in
  // what the scan examines; a >= threshold would let one slide under unnoticed.
  assert.strictEqual(r.examined, 5, 'must examine the use site, both members (membership), '
    + 'and both members again (closure BFS)');
});

test('regression: a carried member that does not exist is reported', () => {
  const r = scanAssembler({
    fuseSrc: "for (const f of ['build-naude.mjs', 'ghost.cjs']) {\n    members.push({ name: `scripts/",
    scriptSources: { 'build-naude.mjs': '' },
  });
  assert.deepStrictEqual(r.findings, ["carried member 'ghost.cjs' does not exist in scripts/"]);
});
