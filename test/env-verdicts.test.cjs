'use strict';
// Every CLODE_* name shipped code READS must carry a recorded verdict. The population drifted
// from a recorded 51 to a measured 65 with nothing to notice, which is what this gate ends.
//
// AND THEN THE GATE ITSELF HAD THE HOLE IT WAS BUILT TO CLOSE (fix round 3, 2026-09-13).
// env-inventory.cjs only saw names spelled LITERALLY beside `env.`/`env[`, so seven shipped
// names read through one indirection had no verdict and nothing could ever say so — 65 was
// never the population; 72 was. The two mechanisms added below are what make that class
// un-missable rather than merely fixed once:
//   1. every COMPUTED env access in shipped code must be recorded (test/env-indirect.cjs),
//      and its reachable names are folded into the inventory, so they need verdicts;
//   2. environment-stamp.cjs's SAFE_GATE_NAMES — a SECOND in-repo list of env names, edited
//      in the same phase, already carrying CLODE_TAR/GZIP/UNZIP while the inventory had
//      never heard of them — must be a subset of what the inventory sees. Two lists of the
//      same thing that nobody compares is how this was catchable and uncaught.
const { test } = require('node:test');
const assert = require('node:assert');
const { indexEnvReads } = require('./env-inventory.cjs');
const { VERDICTS, VERDICT_KINDS } = require('./env-verdicts.cjs');
const { INDIRECT_SITES, findIndirectEnvSites, indirectLiteralAudit } = require('./env-indirect.cjs');
const { SAFE_GATE_NAMES } = require('./environment-stamp.cjs');
const { surfaceFor } = require('../libexec/cli-surface.cjs');

test('every name shipped code reads has a verdict, and every verdict names a real name', () => {
  const idx = indexEnvReads();
  const shipped = [...idx.entries()].filter(([, v]) => v.prod.length > 0).map(([k]) => k).sort();
  const recorded = new Map(VERDICTS.map((v) => [v.name, v]));

  const missing = shipped.filter((n) => !recorded.has(n));
  assert.deepStrictEqual(missing, [],
    'these names are read by shipped code with no recorded verdict — classify each as '
    + VERDICT_KINDS.join(' / '));

  // PHANTOM MEANS "NO PRODUCTION READER", NOT "NO READER AT ALL" (fix round 3). This used
  // to filter on `!idx.has(n)`, and `idx` counts test/ reads too — so a name whose LAST
  // production call site was deleted stayed green here forever, as long as one test still
  // mentioned it, while --help went on documenting a knob that no longer existed. Proven by
  // deleting libexec/clode-watch.cjs's sole read of CLODE_NO_WATCH: the inventory reported
  // `prod: []`, all three assertions passed, and help kept the entry. Four absorbed names
  // were live in that shape (CLODE_NO_WATCH 1 prod/2 test, CLODE_TARGET_TEMPLATE 1/1,
  // CLODE_CLAUDE_BIN 1/12, CLODE_FETCH_PLATFORM 1/1). The header of env-verdicts.cjs sells
  // exactly this guarantee for the `dead` verdict; now it holds.
  const phantom = VERDICTS.map((v) => v.name).filter((n) => !(idx.get(n)?.prod.length > 0));
  assert.deepStrictEqual(phantom, [],
    'these verdicts name env vars no SHIPPED code reads any more (a test may still mention '
    + 'them) — delete the entry, or re-classify it `dead`, but do not keep a build-input '
    + 'verdict about a name production no longer reads');
});

// ---- Mechanism 1: no indirect env reader may be invisible again. -----------------------
test('every computed env access in shipped code is a recorded indirect site', () => {
  const sites = findIndirectEnvSites();
  const recorded = new Set(INDIRECT_SITES.map((s) => s.file));
  const unrecorded = sites.filter((s) => !recorded.has(s.file));
  assert.deepStrictEqual(unrecorded.map((s) => `${s.file}:${s.line}  env[${s.key}]`), [],
    'these shipped files read the environment with a COMPUTED key, which test/env-inventory'
    + ".cjs's literal-name regex cannot see. Record each in test/env-indirect.cjs's "
    + 'INDIRECT_SITES: name the CLODE_* names it can reach (they then need verdicts) or '
    + 'declare it KEY_AGNOSTIC with a reason.');
});

test('every recorded indirect site still performs a computed env read', () => {
  const files = new Set(findIndirectEnvSites().map((s) => s.file));
  const stale = INDIRECT_SITES.map((s) => s.file).filter((f) => !files.has(f));
  assert.deepStrictEqual(stale, [],
    'these INDIRECT_SITES entries describe a computed env read that is no longer there — '
    + 'delete the entry rather than carry a record of a site that is gone');
});

test('every bare CLODE_* literal in an indirect-site file is accounted for', () => {
  assert.deepStrictEqual(indirectLiteralAudit().map((f) => `${f.site}: ${f.name || '(unreadable)'}`), [],
    'these files read env by a computed key and contain a bare CLODE_* name literal that is '
    + "in neither the site's `reaches` nor its `notEnv` — the site grew a knob nobody "
    + 'classified. Add it to `reaches` (and give it a verdict) or to `notEnv` with the reason '
    + 'it is not an environment variable.');
});

// ---- Mechanism 2: the second list of env names must agree with the first. --------------
test("environment-stamp's SAFE_GATE_NAMES are all names the env inventory actually sees", () => {
  const idx = indexEnvReads();
  const unknown = [...SAFE_GATE_NAMES].filter((n) => !idx.has(n)).sort();
  assert.deepStrictEqual(unknown, [],
    'test/environment-stamp.cjs allow-lists these names as safe to PRINT, but the env '
    + 'inventory has never seen a read of them anywhere in libexec/, scripts/ or test/. '
    + 'Either the name is retired (delete it there) or the inventory is blind to how it is '
    + 'read (add the reader to test/env-indirect.cjs). This cross-check exists because that '
    + 'list already named CLODE_TAR/CLODE_GZIP/CLODE_UNZIP while the inventory did not — two '
    + 'lists of the same thing, never compared, for a whole phase.');
});

test('every verdict carries a kind and a reason', () => {
  for (const v of VERDICTS) {
    assert.ok(VERDICT_KINDS.includes(v.verdict), `${v.name}: unknown verdict '${v.verdict}'`);
    assert.ok(v.because && v.because.trim().length > 10,
      `${v.name}: a verdict without a reason is a guess someone will have to redo`);
  }
});

// Phase 3b task 2's gate extension. Task 1's own two tests above check that VERDICTS and the
// real env-read corpus agree with each other; NEITHER checks that an 'absorbed' verdict is
// actually WIRED onto cli-surface.cjs's table. That gap is exactly how phase 3a's `env: []`
// placeholders could have silently PINNED an absence forever — a verdict recorded once and
// never re-checked against the surface it claims to describe.
//
// FIX ROUND 1 (reviewer): the first cut of this test matched `help.includes(v.name)` against
// RENDERED HELP TEXT, which is a substring check on prose — and `CLODE_TJS` is a substring of
// `CLODE_TJS_PIN`. Deleting CLODE_TJS's own table entry (proven: its "blobulated builder" doc
// text vanishes from help) left the gate reporting `missing: []`, because CLODE_TJS_PIN's
// entry alone still made the substring "CLODE_TJS" appear somewhere in the rendered text. That
// is exactly the "silently PINNED absence" failure mode this gate exists to close — closing it
// with a hole in the same shape would have been worse than not having it. Fixed by collecting
// the EXACT names cli-surface.cjs's own table declares (every verb's `env` plus the top-level
// `env`, each stripped of a trailing `=NAME` the same way `CLODE_NO_WATCH=1` and
// `CLODE_ALLOW_FOREIGN_CARVE=1` carry one), then checking Set membership — no rendered text,
// no substrings, so a `_PIN`/`_RECIPE`/whatever-suffixed sibling can never stand in for a
// deleted name again.
function declaredEnvNames(surface) {
  const names = new Set();
  for (const def of Object.values(surface.verbs)) {
    for (const e of def.env) names.add(e.name.split('=')[0]);
  }
  for (const e of surface.env) names.add(e.name.split('=')[0]);
  return names;
}

test('every absorbed verdict is actually on the CLI surface, not just recorded as one', () => {
  const declared = declaredEnvNames(surfaceFor('checkout'));
  const absorbed = VERDICTS.filter((v) => v.verdict === 'absorbed');
  const missing = absorbed.filter((v) => !declared.has(v.name)).map((v) => v.name);
  assert.deepStrictEqual(missing, [],
    'these names are recorded as verdict \'absorbed\' (a real build-input selector) but no '
    + 'verb\'s (or the top-level) `env` array in cli-surface.cjs declares them — either wire '
    + 'the name onto cli-surface.cjs\'s SURFACE (or CHECKOUT_ONLY_VERBS) table, or this '
    + 'verdict is wrong and belongs to a different kind. An absorbed name --help never '
    + 'mentions is indistinguishable from a knob that does not exist, in the one binary that '
    + 'ships no other documentation.');
});
