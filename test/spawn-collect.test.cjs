'use strict';
// spawn-collect.cjs: resolves on 'close' with all of the child's output, names a spawn failure, and never hangs on a
// child that outlives its timeout.
const test = require('node:test');
const assert = require('node:assert');
const { spawnCollect, KILLED_BY_TIMEOUT } = require('./spawn-collect.cjs');

test('spawnCollect: the whole of stdout and stderr, with the status, once stdio has closed', async () => {
  // A large tail written just before exit: the bytes 'exit' could precede.
  const prog = "process.stderr.write('e'); process.stdout.write('x'.repeat(1 << 20)); process.stdout.write('END', () => process.exit(3));";
  const r = await spawnCollect(process.execPath, ['-e', prog]);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout.length, (1 << 20) + 3);
  assert.ok(r.stdout.endsWith('END'));
  assert.strictEqual(r.stderr, 'e');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.timedOut, false);
});
test('spawnCollect: a command that cannot start resolves with its error, never rejects', async () => {
  const r = await spawnCollect('/no/such/command-spawn-collect', []);
  assert.strictEqual(r.status, null);
  assert.strictEqual(r.error.code, 'ENOENT');
  assert.match(r.stderr, /ENOENT/);
});
test('spawnCollect: a child past its timeout is killed and reported as timed out', async () => {
  const r = await spawnCollect(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {}, { timeoutMs: 200 });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.status, null);
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.ok(r.stderr.includes(`${KILLED_BY_TIMEOUT}: no exit within 200 ms`), `the kill is on the page: ${r.stderr}`);
});
test('spawnCollect: onSpawn gets the child, to feed its stdin', async () => {
  const r = await spawnCollect(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'pipe'] },
    { onSpawn: (c) => c.stdin.end('fed') });
  assert.strictEqual(r.stdout, 'fed');
});
