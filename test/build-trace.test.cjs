const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../libexec/build-trace.cjs');
const P = require('../libexec/clode-paths.cjs');

const STEPS = [
  { component: 'builder', name: 'extract', total: 2, done: 2, elapsedMs: 1400, state: 'finished' },
  { component: 'worker', name: 'compile', total: 1795, done: 1795, elapsedMs: 211700, state: 'finished' },
];
const META = { clodeVersion: '0.0.0', bundleVersion: '2.1.251', target: 'macos-arm64', host: 'darwin-arm64', interpreter: 'node v26.3.0' };

test('traceEvents emits Chrome-trace complete events in microseconds', () => {
  const ev = T.traceEvents(STEPS, META);
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[0].ph, 'X', 'complete events');
  assert.strictEqual(ev[1].dur, 211700 * 1000, 'dur is microseconds, not milliseconds');
  assert.strictEqual(ev[0].name, 'extract');
  assert.notStrictEqual(ev[0].tid, ev[1].tid, 'components get distinct tracks');
});

test('a run appends exactly one line and round-trips', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  T.appendRun(log, { steps: STEPS, meta: META });
  assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
  const runs = T.readRuns(log);
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(runs[0].meta.bundleVersion, '2.1.251');
  assert.strictEqual(runs[0].steps[1].elapsedMs, 211700);
});

test('the interpreter is recorded — a timing without one is not comparable', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  assert.match(T.readRuns(log)[0].meta.interpreter, /node/);
});

test('appendRun creates the parent directory rather than throwing', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'nested', 'deep', 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  assert.strictEqual(T.readRuns(log).length, 1);
});

test('readRuns tolerates a truncated final line instead of throwing', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  fs.appendFileSync(log, '{"partial":');
  assert.strictEqual(T.readRuns(log).length, 1, 'a torn write must not lose the whole history');
});

test('traceLog resolves off-tree, under the HOME/XDG state dir', () => {
  const p = P.traceLog({ HOME: '/h' });
  assert.strictEqual(p.startsWith('/h'), true, `expected a HOME-derived path, got ${p}`);
  assert.match(p, /clode/);
});
