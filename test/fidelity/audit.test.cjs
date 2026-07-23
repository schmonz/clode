'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { auditRows } = require('../fidelity/audit.mjs');

const SAMPLE = [
  '| A1 | → theme persists | ok | platform | test/node-shim-fs.test.cjs |',
  '| A2 | ? creds persist  | ok | platform | NEW |',
  '| D1 | → /quit exits    | ok | platform | NEW |',
  '| J1 | → rc connects | ok | - | test/websocket-oracle.test.cjs |',
  '| J9 | → future | ok | - | NEW |',
].join('\n');

test('audit flags regression rows with NEW or missing tests, ignores probes', () => {
  const r = auditRows(SAMPLE, (p) => p === 'test/node-shim-fs.test.cjs' || p === 'test/websocket-oracle.test.cjs');
  assert.deepStrictEqual(r.gaps.map((g) => g.id), ['D1', 'J9']); // A1/J1 guarded, A2 is a probe
  assert.deepStrictEqual(r.guarded, ['A1', 'J1']);
});

test('every → row in the real RECIPE.md cites a live guarding test (gaps: 0)', () => {
  const repo = path.resolve(__dirname, '..', '..');
  const text = fs.readFileSync(path.join(repo, 'test/fidelity/RECIPE.md'), 'utf8');
  const r = auditRows(text, (p) => fs.existsSync(path.join(repo, p)));
  assert.deepStrictEqual(r.gaps, [], `unguarded → rows: ${JSON.stringify(r.gaps)}`);
  assert.ok(r.guarded.length >= 19, `expected ≥19 guarded rows, got ${r.guarded.length}`);
});
