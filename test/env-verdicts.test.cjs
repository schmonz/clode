'use strict';
// Every CLODE_* name shipped code READS must carry a recorded verdict. The population drifted
// from a recorded 51 to a measured 65 with nothing to notice, which is what this gate ends.
const { test } = require('node:test');
const assert = require('node:assert');
const { indexEnvReads } = require('./env-inventory.cjs');
const { VERDICTS, VERDICT_KINDS } = require('./env-verdicts.cjs');

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
