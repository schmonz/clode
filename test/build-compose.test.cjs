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

test('finish() called twice with an EARLIER larger value is a mismatch — the composer keeps the first report and does not silently drop to the smaller duplicate', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile' }]); // no total: isolate the duplicate-finish check from the total mismatch checks
    r.start('compile');
    r.finish('compile', 5);
    r.finish('compile', 3); // stale or duplicate finish
  });
  assert.strictEqual(c.mismatches().length, 1, 'a duplicate finish must be flagged');
  const step = c.steps().find((s) => s.name === 'compile');
  assert.strictEqual(step.done, 5, 'the first report is the truth; a duplicate must not clobber it');
});

test('finish() called twice with a LATER larger value is equally a protocol violation, not a self-correction', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile' }]);
    r.start('compile');
    r.finish('compile', 3);
    r.finish('compile', 5); // looks like a correction, but is still a second finish for the same step
  });
  assert.strictEqual(c.mismatches().length, 1, 'a duplicate finish must be flagged regardless of direction');
  const step = c.steps().find((s) => s.name === 'compile');
  assert.strictEqual(step.done, 3, 'the first report is kept; the duplicate does not overwrite even when it looks like a correction');
});

test('a stale PROGRESSED after FINISHED, with NO total declared, is a mismatch and must not change done (the silent-corruption case)', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile' }]); // no total: this is exactly the shape a total-based check cannot catch
    r.start('compile');
    r.finish('compile', 5);
    r.progress('compile', 999); // stale/late progress arriving after finish
  });
  assert.strictEqual(c.mismatches().length, 1, 'a post-finish PROGRESSED must be flagged even with no total to compare against');
  const step = c.steps().find((s) => s.name === 'compile');
  assert.strictEqual(step.done, 5, 'the finished report is the truth; a later PROGRESSED must not clobber it');
});

test('a stale PROGRESSED after FINISHED, WITH a total declared, is a mismatch whose reason names the real cause (not merely the incidental over-report)', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile', total: 5 }]);
    r.start('compile');
    r.finish('compile', 5); // matches total exactly: no total-mismatch on its own
    r.progress('compile', 999); // would look like "exceeding a total" if it clobbered done
  });
  const m = c.mismatches();
  assert.strictEqual(m.length, 1, 'exactly one mismatch: the post-finish anomaly, not a total-exceeded one');
  assert.match(m[0].reason, /PROGRESSED|already finished/i, 'the reason must name the real cause: an event after finish');
  assert.doesNotMatch(m[0].reason, /exceeding a total/, 'must not be mislabeled as a total-exceeded mismatch');
  const step = c.steps().find((s) => s.name === 'compile');
  assert.strictEqual(step.done, 5, 'the finished report is the truth; the stale PROGRESSED must not clobber it');
});

test('a STARTED after FINISHED is also a mismatch, not a silent reversion to running', () => {
  const c = new C.Composer();
  feed(c, 'worker', (r) => {
    r.plan([{ name: 'compile' }]);
    r.start('compile');
    r.finish('compile', 5);
    r.start('compile'); // a late/duplicate start arriving after finish
  });
  assert.strictEqual(c.mismatches().length, 1, 'a post-finish STARTED must be flagged');
  const step = c.steps().find((s) => s.name === 'compile');
  assert.strictEqual(step.state, 'finished', 'the step must not revert to running');
});
