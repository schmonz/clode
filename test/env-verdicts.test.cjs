'use strict';
// Every CLODE_* name shipped code READS must carry a recorded verdict. The population drifted
// from a recorded 51 to a measured 65 with nothing to notice, which is what this gate ends.
const { test } = require('node:test');
const assert = require('node:assert');
const { indexEnvReads } = require('./env-inventory.cjs');
const { VERDICTS, VERDICT_KINDS } = require('./env-verdicts.cjs');
const { surfaceFor, renderHelp } = require('../libexec/cli-surface.cjs');

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
// never re-checked against the surface it claims to describe. Render surfaceFor('checkout')
// (the superset: every verb a shipped clode has, PLUS the checkout-only ones like bootstrap)
// and require every 'absorbed' name to appear in it BY NAME. A name declared with a suffix
// (CLODE_NO_WATCH=1, CLODE_ALLOW_FOREIGN_CARVE=1) still matches: the bare name is a substring
// of its own '=1' spelling, so this does not need to know which names carry one.
test('every absorbed verdict is actually on the CLI surface, not just recorded as one', () => {
  const help = renderHelp('1.2.3', surfaceFor('checkout'));
  const absorbed = VERDICTS.filter((v) => v.verdict === 'absorbed');
  const missing = absorbed.filter((v) => !help.includes(v.name)).map((v) => v.name);
  assert.deepStrictEqual(missing, [],
    'these names are recorded as verdict \'absorbed\' (a real build-input selector) but do '
    + 'not appear anywhere in --help — either wire the name onto cli-surface.cjs\'s SURFACE '
    + '(or CHECKOUT_ONLY_VERBS) table, or this verdict is wrong and belongs to a different '
    + 'kind. An absorbed name --help never mentions is indistinguishable from a knob that '
    + 'does not exist, in the one binary that ships no other documentation.');
});
