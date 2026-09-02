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
  // The HOME we pass must be an ABSOLUTE path in the platform's own shape, and the
  // assertion must compare in that shape too. This read `HOME: '/h'` and
  // `p.startsWith('/h')` until 2026-09-02, which is a POSIX assumption twice over:
  // clode-paths.cjs composes with path.join, so on Windows the result came back
  // `\h\.local\share\clode\build-trace.jsonl` and startsWith('/h') was false.
  // Green on every POSIX leg, red only on windows-latest — the shape of bug this
  // project's `solve-it-portably-not-per-platform` doctrine exists to catch, so it is
  // fixed by making the test platform-neutral, NOT by branching on process.platform.
  const home = path.join(os.tmpdir(), 'clode-tracelog-home');
  const p = P.traceLog({ HOME: home });
  assert.strictEqual(p.startsWith(home), true, `expected a HOME-derived path, got ${p}`);
  assert.match(p, /clode/);
});

// --- Task 3 fix round 1 -----------------------------------------------------------

test('appendRun refuses a run whose meta.interpreter is missing or empty — enforced, not just documented (Finding 1)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  assert.throws(() => T.appendRun(log, { steps: STEPS, meta: { clodeVersion: '0.0.0' } }),
    /interpreter/, 'missing interpreter must throw');
  assert.throws(() => T.appendRun(log, { steps: STEPS, meta: { ...META, interpreter: '' } }),
    /interpreter/, 'empty interpreter must throw');
  // A wholly-missing `meta` is now caught by the shared shape check (round-2 fix,
  // isRunShaped) before the interpreter-specific check ever runs — that's a stricter,
  // earlier gate, so the message names `meta`/`steps` shape rather than `interpreter`
  // specifically. See the round-2 tests below for that check's own coverage.
  assert.throws(() => T.appendRun(log, { steps: STEPS }),
    /meta/, 'missing meta entirely must throw');
  assert.strictEqual(fs.existsSync(log), false, 'a refused run must not partially write the log');
});

test('appendRun still writes a well-formed run (the interpreter check does not break the happy path)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  assert.strictEqual(T.readRuns(log).length, 1);
});

test('readRuns skips a well-formed-JSON-but-not-a-run line, tagged distinctly from a torn write (Finding 2)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  for (const bad of ['{"foo":1}', '42', 'null', '[1,2,3]']) fs.appendFileSync(log, bad + '\n');
  const skips = [];
  const runs = T.readRuns(log, fs, (reason) => skips.push(reason));
  assert.strictEqual(runs.length, 1, 'only the one real run should come back');
  assert.strictEqual(skips.length, 4, `expected 4 skips, got ${skips.length}`);
  assert.ok(skips.every((r) => r === 'malformed'), `expected all 4 tagged malformed, got ${skips.join(',')}`);
});

test('readRuns tags a torn (unparseable) line distinctly from a malformed-but-valid-JSON line (Finding 2)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  fs.appendFileSync(log, '{"partial":');
  const skips = [];
  const runs = T.readRuns(log, fs, (reason) => skips.push(reason));
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(skips, ['torn']);
});

test('traceEvents keeps a PER-COMPONENT ts track rather than one accumulator shared across components, and marks it synthetic (Finding 3)', () => {
  const steps = [
    { component: 'builder', name: 'extract', total: 2, done: 2, elapsedMs: 1000, state: 'finished' },
    { component: 'worker', name: 'compile', total: 1795, done: 1795, elapsedMs: 5000, state: 'finished' },
    { component: 'builder', name: 'smoke', total: 1, done: 1, elapsedMs: 200, state: 'finished' },
  ];
  const ev = T.traceEvents(steps, META);
  // Finding 3's bug: a single accumulator would push the worker's track out to start
  // AFTER builder's 'extract' finished. Real execution may not be serial across
  // components (build-compose.cjs merges streams from any number of them) — each
  // track must own its own timeline.
  assert.strictEqual(ev[1].ts, 0, "the worker track must start its OWN timeline at 0, not after builder's work");
  // Same-track events still accumulate serially against each other.
  assert.strictEqual(ev[2].ts, 1000 * 1000, 'same-track events remain serial against each other');
  assert.strictEqual(ev[0].args.tsSynthetic, true, 'ts is synthesized (no real start timestamp exists on a step yet) — a viewer must be told, not left to assume real wall-clock time');
});

// --- Task 3 fix round 2 -----------------------------------------------------------

test('appendRun refuses a run with no steps array — write and read contracts must match (Finding, round 2)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  assert.throws(() => T.appendRun(log, { meta: META }),
    /steps/, 'a run missing steps entirely must throw, not write a line readRuns will silently drop');
  assert.strictEqual(fs.existsSync(log), false, 'a refused run must not partially write the log');
});

test('appendRun refuses a run whose steps is not an array (Finding, round 2)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  assert.throws(() => T.appendRun(log, { steps: 'not-an-array', meta: META }),
    /steps/, 'a wrongly-typed steps must throw, not write a line readRuns will silently drop');
  assert.strictEqual(fs.existsSync(log), false, 'a refused run must not partially write the log');
});

test('appendRun refuses a run whose meta is missing or not an object (Finding, round 2)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  assert.throws(() => T.appendRun(log, { steps: STEPS }), /interpreter|meta/,
    'a run with no meta at all must throw');
  assert.throws(() => T.appendRun(log, { steps: STEPS, meta: 'nope' }), /interpreter|meta/,
    'a non-object meta must throw');
  assert.strictEqual(fs.existsSync(log), false);
});

test('anything appendRun accepts, readRuns returns — the write and read contracts cannot drift apart (Finding, round 2)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'builds.jsonl');
  T.appendRun(log, { steps: STEPS, meta: META });
  const skips = [];
  const runs = T.readRuns(log, fs, (reason) => skips.push(reason));
  assert.strictEqual(runs.length, 1, 'a run appendRun accepted must never come back unreadable');
  assert.deepStrictEqual(skips, []);
});
