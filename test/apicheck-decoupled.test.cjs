'use strict';
// apicheck's gate logic, driven off injected model runners — proving it no
// longer routes through bin/clode or CLODE_ENGINE. The corpus-level REAL run
// needs a Bun-packaged CC provider and is exercised where one exists; this
// pins the wiring, the axes, and the no-provider skip.
const { test } = require('node:test');
const assert = require('node:assert');

const CORPUS = [
  { id: 'version', args: ['--version'], deterministic: true },
  { id: 'p-plain', args: ['-p', 'hi'], deterministic: false },
];

function sink() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), text: () => lines.join('\n') };
}
const ok = () => ({ status: 0, signal: null, stdout: 'same', stderr: '' });

async function gate() {
  return (await import('../scripts/apicheck.mjs')).runGate;
}

test('no provider: prints a clear skip and passes (exit 0)', async () => {
  const runGate = await gate();
  const out = sink();
  const status = runGate({ stage: () => null, log: out.log, corpus: CORPUS });
  assert.strictEqual(status, 0);
  assert.match(out.text(), /provider/i);
});

test('dispatches BOTH models against the same staged cli — no bin/clode, no CLODE_ENGINE', async () => {
  const runGate = await gate();
  const calls = [];
  runGate({
    stage: () => ({ cli: '/staged/cli.cjs', dir: '/staged' }),
    runNaude: (cli, args, o) => { calls.push({ model: 'naude', cli, args, env: o.env }); return ok(); },
    runQuaude: (cli, args, o) => { calls.push({ model: 'quaude', cli, args, env: o.env }); return ok(); },
    log: sink().log,
    corpus: CORPUS,
  });
  assert.strictEqual(calls.length, 4, 'each corpus item runs under both models');
  assert.ok(calls.every((c) => c.cli === '/staged/cli.cjs'), 'both models run the SAME staged cli');
  assert.ok(calls.every((c) => !c.env || c.env.CLODE_ENGINE === undefined), 'the retired engine selector is gone');
});

test('only the quaude side traces walls (the shim is the subject)', async () => {
  const runGate = await gate();
  const seen = {};
  runGate({
    stage: () => ({ cli: '/c.cjs', dir: '/' }),
    runNaude: (cli, args, o) => { seen.naude = o.env; return ok(); },
    runQuaude: (cli, args, o) => { seen.quaude = o.env; return ok(); },
    log: sink().log,
    corpus: [CORPUS[0]],
  });
  assert.strictEqual(seen.quaude.CLODE_SHIM_TRACE, '1');
  assert.strictEqual(seen.naude.CLODE_SHIM_TRACE, undefined);
});

test('walls found on the quaude side fail the gate and are reported', async () => {
  const runGate = await gate();
  const out = sink();
  const status = runGate({
    stage: () => ({ cli: '/c.cjs', dir: '/' }),
    runNaude: () => ok(),
    runQuaude: () => ({ status: 0, signal: null, stdout: 'same', stderr: '[wall] fs.cpSync\n[wall] fs.cpSync\n' }),
    log: out.log,
    corpus: [CORPUS[0]],
  });
  assert.strictEqual(status, 1);
  assert.match(out.text(), /fs\.cpSync/);
  assert.strictEqual((out.text().match(/fs\.cpSync/g) || []).length, 2, 'walls dedupe (once in the row, once in the axis list)');
});

test('exit divergence between naude and quaude fails the gate', async () => {
  const runGate = await gate();
  const out = sink();
  const status = runGate({
    stage: () => ({ cli: '/c.cjs', dir: '/' }),
    runNaude: () => ({ status: 0, signal: null, stdout: 'x', stderr: '' }),
    runQuaude: () => ({ status: 1, signal: null, stdout: 'x', stderr: '' }),
    log: out.log,
    corpus: [CORPUS[0]],
  });
  assert.strictEqual(status, 1);
  assert.match(out.text(), /DIVERGE/);
});

test('stdout parity is enforced for deterministic commands only', async () => {
  const runGate = await gate();
  const differ = {
    stage: () => ({ cli: '/c.cjs', dir: '/' }),
    runNaude: () => ({ status: 0, signal: null, stdout: 'alpha', stderr: '' }),
    runQuaude: () => ({ status: 0, signal: null, stdout: 'beta', stderr: '' }),
    log: sink().log,
  };
  assert.strictEqual(runGate({ ...differ, corpus: [{ id: 'd', args: [], deterministic: true }] }), 1);
  assert.strictEqual(runGate({ ...differ, corpus: [{ id: 'n', args: [], deterministic: false }] }), 0,
    'model prose varies run to run — never stdout-compared');
});

test('agreement passes the gate', async () => {
  const runGate = await gate();
  const status = runGate({
    stage: () => ({ cli: '/c.cjs', dir: '/' }),
    runNaude: () => ok(),
    runQuaude: () => ok(),
    log: sink().log,
    corpus: CORPUS,
  });
  assert.strictEqual(status, 0);
});
