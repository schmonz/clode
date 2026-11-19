'use strict';
// test/cpu-bound-run.cjs: a bound on the work a child does (CPU), a stall detector, and a wall ceiling, each named.
const { test } = require('node:test');
const assert = require('node:assert');
const { runCpuBounded, parsePsTime, treeOf } = require('./cpu-bound-run.cjs');

const NO_PS = process.platform === 'win32' ? 'ps(1) is POSIX; on Windows only the wall ceiling applies' : false;
const node = (code) => [process.execPath, ['-e', code]];

test('ps CPU times parse in both spellings (macOS fractions, procps days and hours)', () => {
  assert.strictEqual(parsePsTime('0:03.25'), 3250);
  assert.strictEqual(parsePsTime('12:01.00'), 721000);
  assert.strictEqual(parsePsTime('01:02:03'), 3723000);
  assert.strictEqual(parsePsTime('2-00:00:01'), 172801000);
  assert.strictEqual(parsePsTime('TIME'), null);
});

test('the tree is the child and its descendants, not its siblings', () => {
  const rows = [{ pid: 1, ppid: 0, ms: 1 }, { pid: 10, ppid: 1, ms: 5 }, { pid: 11, ppid: 10, ms: 7 }, { pid: 12, ppid: 1, ms: 9 }];
  assert.deepStrictEqual(treeOf(rows, 10).map((r) => r.pid).sort(), [10, 11]);
});

test('a child that finishes inside every bound is untouched', { skip: NO_PS }, async () => {
  const [c, a] = node('let x=0; const t=Date.now(); while (Date.now()-t<300) x++; console.log("done")');
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 60000, stallMs: 30000, wallMs: 60000, pollMs: 100 });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.bound, null);
  assert.match(r.stdout, /done/);
});

test('CONTROL: a child that burns past its CPU budget is killed and named for it', { skip: NO_PS }, async () => {
  const [c, a] = node('for(;;){}');
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 1500, stallMs: 60000, wallMs: 60000, pollMs: 200 });
  assert.match(r.bound || '', /^CPU budget: /);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.wallMs < 30000, `killed late: ${r.wallMs} ms`);
});

test('CONTROL: a child that stops using CPU is killed as STALLED, long before its wall ceiling', { skip: NO_PS }, async () => {
  const [c, a] = node('setInterval(() => {}, 1000)');
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 600000, stallMs: 1500, wallMs: 60000, pollMs: 200 });
  assert.match(r.bound || '', /^STALLED: no CPU progress/);
  assert.ok(r.wallMs < 30000, `killed late: ${r.wallMs} ms`);
});

test('the CPU of a grandchild counts (the work is the tree\'s, not the direct child\'s)', { skip: NO_PS }, async () => {
  const inner = 'for(;;){}';
  const [c, a] = node(`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`);
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 1500, stallMs: 60000, wallMs: 60000, pollMs: 200 });
  assert.match(r.bound || '', /^CPU budget: /);
});

test('without ps, the wall ceiling still holds and the result says CPU was not sampled', async () => {
  const [c, a] = node('setInterval(() => {}, 1000)');
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 1, stallMs: 1, wallMs: 1000, pollMs: 100, snapshot: () => null });
  assert.match(r.bound || '', /^WALL ceiling: /);
  assert.strictEqual(r.cpuSampled, false);
});

// Fake snapshots: the child's own CPU never moves; with `spawning`, one new descendant joins the tree at every poll.
// Fake pids sit above every kernel's pid_max (Linux's ceiling is 4194304), so the STALLED kill cannot reach a real process.
function fakeTree(spawning) {
  let n = 0;
  return (root) => {
    const rows = [{ pid: root, ppid: 1, ms: 100 }];
    if (spawning) { n++; for (let k = 1; k <= n; k++) rows.push({ pid: 5000000 + k, ppid: root, ms: 0 }); }
    return rows;
  };
}
test('a loop that keeps spawning sleepers adds processes but no CPU, and is STALLED', async () => {
  const [c, a] = node('setTimeout(() => {}, 4000)');
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 600000, stallMs: 1000, wallMs: 60000, pollMs: 200, snapshot: fakeTree(true) });
  assert.match(r.bound || '', /^STALLED: no CPU progress/);
});
test('CONTROL: a run that does add CPU between polls is not STALLED', async () => {
  let ms = 0;
  const [c, a] = node('setTimeout(() => {}, 2500)');
  const r = await runCpuBounded(c, a, {}, { cpuBudgetMs: 600000, stallMs: 1000, wallMs: 60000, pollMs: 200,
    snapshot: (root) => [{ pid: root, ppid: 1, ms: (ms += 50) }] });
  assert.strictEqual(r.bound, null);
  assert.strictEqual(r.status, 0);
});
