// test/build-compose.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../libexec/build-report.cjs');
const C = require('../libexec/build-compose.cjs');

function feed(composer, component, fn) {
  const lines = [];
  let t = 0;
  const r = new R.Reporter({ emit: (l) => lines.push(l), now: () => (t += 100) });
  fn(r);
  for (const l of lines) composer.ingest(component, l);
}

test('composes two components without knowing their steps', () => {
  const c = new C.Composer();
  feed(c, 'builder', (r) => { r.plan([{ name: 'extract', total: 2 }]); r.start('extract'); r.finish('extract', 2); });
  feed(c, 'worker', (r) => { r.plan([{ name: 'compile', total: 3 }]); r.start('compile'); r.finish('compile', 3); });
  assert.deepStrictEqual(c.steps().map((s) => `${s.component}:${s.name}`), ['builder:extract', 'worker:compile']);
  assert.deepStrictEqual(c.totals(), { done: 5, total: 5 });
});

test('foreign lines are passed through, not swallowed', () => {
  const c = new C.Composer();
  assert.strictEqual(c.ingest('worker', 'compiled 1795 modules -> graph.qbc'), false);
  assert.strictEqual(c.ingest('worker', R.serialize(R.plan([{ name: 'x' }]))), true);
});

test('a step that reports fewer units than declared is a MISMATCH', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => { r.plan([{ name: 'compile', total: 1795 }]); r.start('compile'); r.finish('compile', 1600); });
  const m = c.mismatches();
  assert.strictEqual(m.length, 1, 'under-reporting must be detected');
  assert.match(m[0].reason, /1600.*1795|declared/);
});

test('an UPPER BOUND total makes under-reporting legitimate — but only when DECLARED', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile', total: 1795, totalIsUpperBound: true }]);
    r.start('compile'); r.finish('compile', 1600);
  });
  assert.deepStrictEqual(c.mismatches(), []);
});

test('over-reporting is ALWAYS a mismatch, upper bound or not', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile', total: 10, totalIsUpperBound: true }]);
    r.start('compile'); r.finish('compile', 11);
  });
  assert.strictEqual(c.mismatches().length, 1, 'exceeding an upper bound is still wrong');
});

test('a step that never finished is a mismatch, not a silent omission', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => { r.plan([{ name: 'compile', total: 3 }]); r.start('compile'); });
  assert.strictEqual(c.mismatches().length, 1);
});
