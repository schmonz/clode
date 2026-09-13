'use strict';
// Every CLODE_* name shipped code READS must carry a recorded verdict. The population drifted
// from a recorded 51 to a measured 65 with nothing to notice, which is what this gate ends.
const { test } = require('node:test');
const assert = require('node:assert');
const { indexEnvReads } = require('./env-inventory.cjs');
const { VERDICTS, VERDICT_KINDS } = require('./env-verdicts.cjs');
const { surfaceFor } = require('../libexec/cli-surface.cjs');

test('every name shipped code reads has a verdict, and every verdict names a real name', () => {
  const idx = indexEnvReads();
  const shipped = [...idx.entries()].filter(([, v]) => v.prod.length > 0).map(([k]) => k).sort();
  const recorded = new Map(VERDICTS.map((v) => [v.name, v]));

  const missing = shipped.filter((n) => !recorded.has(n));
  assert.deepStrictEqual(missing, [],
    'these names are read by shipped code with no recorded verdict — classify each as '
    + VERDICT_KINDS.join(' / '));

  const phantom = VERDICTS.map((v) => v.name).filter((n) => !idx.has(n));
  assert.deepStrictEqual(phantom, [],
    'these verdicts name env vars nothing reads any more — delete the entry, do not keep a '
    + 'verdict about a name that is gone');
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
