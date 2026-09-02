// test/build-report.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../libexec/build-report.cjs');

test('a plan record round-trips through serialize/parse', () => {
  const rec = R.plan([{ name: 'compile', total: 1795 }, { name: 'sign' }]);
  const back = R.parse(R.serialize(rec));
  assert.strictEqual(back.type, R.PLAN);
  assert.deepStrictEqual(back.steps, [{ name: 'compile', total: 1795 }, { name: 'sign' }]);
});

test('serialize never emits an embedded newline', () => {
  const rec = R.plan([{ name: 'weird\nname', total: 1 }]);
  const line = R.serialize(rec);
  assert.strictEqual(line.includes('\n'), false, `line had a newline: ${JSON.stringify(line)}`);
  assert.strictEqual(R.parse(line).steps[0].name, 'weird\nname');
});

test('parse returns null for foreign lines, so child chatter is ignored', () => {
  assert.strictEqual(R.parse('compiled 1795 modules -> graph.qbc'), null);
  assert.strictEqual(R.parse(''), null);
  assert.strictEqual(R.parse('{"not":"ours"}'), null);
});

test('Reporter emits plan, start, progress, finish with elapsed from an injected clock', () => {
  const lines = [];
  let t = 1000;
  const r = new R.Reporter({ emit: (l) => lines.push(l), now: () => t });
  r.plan([{ name: 'compile', total: 3 }]);
  r.start('compile');
  t = 1200; r.progress('compile', 2);
  t = 1500; r.finish('compile', 3);
  const recs = lines.map(R.parse);
  assert.deepStrictEqual(recs.map((x) => x.type), [R.PLAN, R.STARTED, R.PROGRESSED, R.FINISHED]);
  assert.strictEqual(recs[1].name, 'compile', 'STARTED record must carry the step name for Composer matching');
  assert.strictEqual(recs[2].done, 2);
  assert.strictEqual(recs[3].done, 3);
  assert.strictEqual(recs[3].elapsedMs, 500, 'elapsed must be measured from start, not from plan');
});

test('an upper-bound total is carried on the record, not inferred', () => {
  const rec = R.plan([{ name: 'compile', total: 1795, totalIsUpperBound: true }]);
  assert.strictEqual(R.parse(R.serialize(rec)).steps[0].totalIsUpperBound, true);
});

test('Reporter.finish() without prior start() yields elapsedMs: 0', () => {
  const lines = [];
  let t = 1000;
  const r = new R.Reporter({ emit: (l) => lines.push(l), now: () => t });
  r.finish('out-of-order-step', 42);
  const rec = R.parse(lines[0]);
  assert.strictEqual(rec.type, R.FINISHED);
  assert.strictEqual(rec.elapsedMs, 0, 'elapsed must be 0 when step was never started');
  assert.strictEqual(rec.done, 42);
});
