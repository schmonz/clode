'use strict';
// Ours vs NATIVE Bun.ant.CellSegmenter's paint() and setCell(), exact equality: every screen
// cell each op writes (decoded to grapheme / style key / link / width bits, never as pool
// indices) and the packed triple each op returns (end column, damage x1, damage x2).
//
// WHY DAMAGE IS JUDGED EXACTLY. The bundle repaints only inside the union of the previous
// and current frames' damage rectangles (P0/rl, fed by B0 from these returns), so a rect
// narrower than native's leaves a stale cell on screen for a frame, and "no damage" is read
// by value. The user's decision: damage must be EXACTLY native's, not merely covering.
//
// Ours is bun-shim under tjs, so the shipped code is what is judged; native runs the SAME
// probe program (scripts/lib/paint-probe.cjs) inside native Claude's own Bun through
// scripts/lib/native-oracle.cjs (BUN_OPTIONS --preload). The scenarios are
// scripts/lib/paint-corpus.cjs, one named part per question put to native.
//
// WHEN IT RUNS. Only against the native the CellSegmenter work was measured from (ruling
// R11): a different Bun is a different oracle, not a failure of ours, so any other version
// SKIPS and names both. The native is resolveNativeOracle() (ruling R1): CLODE_NATIVE_ORACLE,
// else the frame gate's resolver. The corpus needs no network.
const { before } = require('node:test');
const { defineGuard, guardTests } = require('../guard.cjs');
const { resolveNativeOracle, nativeVersion } = require('../../scripts/lib/native-oracle.cjs');
const { runPaintNative, runPaintOurs, comparePaintResults } = require('../../scripts/lib/paint-probe.cjs');
const { paintCorpus, PAINT_PARTS } = require('../../scripts/lib/paint-corpus.cjs');
const { UNICODE_DATA } = require('../../libexec/unicode-text.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');

// Each part's floor, in SCENARIOS: its size in paintCorpus() as measured on 2026-09-25. The
// corpus is deterministic, so the floor is the count itself, less nothing: a part that shrinks
// has lost a question it was there to ask, and makes the gate BROKEN, naming it.
const PART_FLOORS = {
  ascii: 144,
  clip: 50,
  wide: 31,
  tabs: 72,
  'zero-width': 48,
  overwrite: 37,
  runs: 36,
  setcell: 103,
  grow: 5,
};
// The guard's floor is in the unit its `examined` counts (ruling R2): OPS, every op of every
// scenario of paintCorpus() (526 scenarios), measured on 2026-09-25.
const OPS_FLOOR = 577;

let SKIP = null, SCENARIOS = null, NATIVE = null, OURS = null, WHAT = '';

before(() => {
  if (!tjsPath()) { SKIP = 'no tjs engine (set CLODE_TJS): ours runs under the engine quaude ships'; return; }
  const want = UNICODE_DATA.header.nativeClaude;
  const bin = resolveNativeOracle();
  if (!bin) { SKIP = `no native claude; the CellSegmenter rules were measured against ${want} (set CLODE_NATIVE_ORACLE)`; return; }
  const v = nativeVersion(bin);
  if (v !== want) {
    SKIP = `native is ${JSON.stringify(v)} but the CellSegmenter rules were measured against ${JSON.stringify(want)}; `
      + 'set CLODE_NATIVE_ORACLE to that version';
    return;
  }
  SCENARIOS = paintCorpus();
  NATIVE = runPaintNative(bin, SCENARIOS);
  OURS = runPaintOurs(SCENARIOS);
  WHAT = `${v} (${NATIVE.runtime}) vs ours under tjs; ${SCENARIOS.length} scenarios`;
});

guardTests(defineGuard({
  name: 'paint-differential',
  floor: OPS_FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { scenarios: SCENARIOS, native: NATIVE, ours: OURS, what: WHAT };
  },
  // A part under its floor, or with no floor at all: nothing counts as examined (so the
  // verdict is BROKEN, naming the part), because a verdict over a corpus missing a part says
  // nothing about what that part is in the corpus to ask.
  scan({ scenarios, native, ours, what }) {
    const short = PAINT_PARTS.filter((p) => !(p in PART_FLOORS) || scenarios.filter((s) => s.part === p).length < PART_FLOORS[p]);
    if (short.length) {
      const named = `corpus part(s) under floor: ${short.join(', ')}`;
      return { examined: 0, findings: [named], note: `${what || 'synthetic'}; ${named}` };   // BROKEN prints the note
    }
    const d = comparePaintResults(scenarios, native, ours);
    return { examined: d.examined, findings: d.findings, note: `${what || 'synthetic'}; ${d.count} scenario(s) differ` };
  },
  // The phase-5 regression in miniature: one op's damage one column narrower than native's.
  control() {
    const scenarios = paintCorpus();
    const native = { runtime: 'n', results: scenarios.map((sc) => sc.ops.map(() => ({ ret: [2, 0, 2], grew: false, screen: [] }))) };
    const ours = JSON.parse(JSON.stringify(native));
    ours.results[0][0].ret = [2, 0, 1];
    return { scenarios, native, ours };
  },
}));
