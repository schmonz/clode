'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { auditRows } = require('../fidelity/audit.mjs');

const SAMPLE = [
  '| A1 | → theme persists | ok | platform | test/node-shim-fs.test.cjs |',
  '| A2 | ? creds persist  | ok | platform | NEW |',
  '| D1 | → /quit exits    | ok | platform | NEW |',
].join('\n');

test('audit flags regression rows with NEW or missing tests, ignores probes', () => {
  const r = auditRows(SAMPLE, (p) => p === 'test/node-shim-fs.test.cjs');
  assert.deepStrictEqual(r.gaps.map((g) => g.id), ['D1']); // A1 guarded, A2 is a probe
  assert.deepStrictEqual(r.guarded, ['A1']);
});
