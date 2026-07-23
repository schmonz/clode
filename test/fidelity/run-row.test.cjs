'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runRow } = require('../fidelity/run-row.mjs');

test('runRow runs the action on all three engines and reports agreement', async () => {
  const fakeRun = (bin) => Promise.resolve({ status: 0, signal: null, stdout: 'PONG', stderr: '', files: [] });
  const r = await runRow(
    { id: 'X1', args: ['-p', 'say pong'] },
    { claude: '/c', naude: '/n', quaude: '/q' },
    { run: fakeRun });
  assert.strictEqual(r.verdict, 'agree');
  assert.strictEqual(r.perEngine.quaude.stdout, 'PONG');
});

test('runRow localizes a quaude-only divergence to the engine/shim', async () => {
  const fakeRun = (bin) => Promise.resolve({ status: bin === '/q' ? 1 : 0, signal: null, stdout: '', stderr: '', files: [] });
  const r = await runRow({ id: 'X2', args: [] }, { claude: '/c', naude: '/n', quaude: '/q' }, { run: fakeRun });
  assert.match(r.verdict, /diverge/);
  assert.match(r.verdict, /engine\/shim/);
});
