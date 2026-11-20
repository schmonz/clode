'use strict';
// test/run-crashes.cjs: a test file whose process died of a signal is named, and its evidence kept outside the root.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RC = require('./run-crashes.cjs');

const scratch = (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-crashes-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// The block the full suite on 61d7dae printed (2026-11-20), and a plain failure beside it.
const TAP = [
  '# Subtest: test/procfs-linux-only.test.cjs',
  'not ok 301 - test/procfs-linux-only.test.cjs',
  '  ---',
  '  duration_ms: 377.331459',
  "  type: 'test'",
  "  location: '/w/test/procfs-linux-only.test.cjs:1:1'",
  "  failureType: 'testCodeFailure'",
  '  exitCode: ~',
  "  signal: 'SIGSEGV'",
  "  error: 'test failed'",
  "  code: 'ERR_TEST_FAILURE'",
  '  ...',
  'not ok 302 - an ordinary failure',
  '  ---',
  "  error: 'expected 1'",
  '  ...',
  'ok 303 - fine',
].join('\n');

test('crashedFiles names each file whose process died of a signal, and not an ordinary failure', () => {
  const c = RC.crashedFiles(TAP);
  assert.deepStrictEqual(c.map((x) => [x.file, x.signal]), [['test/procfs-linux-only.test.cjs', 'SIGSEGV']]);
  assert.match(c[0].block, /^not ok 301 - test\/procfs-linux-only\.test\.cjs\n[\s\S]*signal: 'SIGSEGV'[\s\S]*\.\.\.$/);
  assert.deepStrictEqual(RC.crashedFiles(TAP.replace("  signal: 'SIGSEGV'\n", '')), [], 'CONTROL: no signal, no crash');
  assert.deepStrictEqual(RC.crashedFiles(''), []);
});

test('keepCrashes keeps the TAP block, the run\'s diagnostic reports and the system crash reports, outside the root', (t) => {
  const original = scratch(t);
  const diagDir = path.join(scratch(t), 'diagnostics');
  fs.mkdirSync(diagDir);
  fs.writeFileSync(path.join(diagDir, 'report.20261120.1.json'), '{}');
  const ips = path.join(scratch(t), 'node-2026-11-20-101010.ips');
  fs.writeFileSync(ips, 'stack');
  const kept = RC.keepCrashes(TAP, { original, diagDir, since: 0, pid: 7, now: new Date('2026-11-20T10:10:10.123Z'), reports: () => [ips] });
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].kept, path.join(original, RC.CRASHES_DIR, '20261120T101010Z-7-procfs-linux-only.test.cjs'));
  assert.deepStrictEqual(kept[0].held, ['node-2026-11-20-101010.ips', 'report.20261120.1.json', 'tap.txt']);
  assert.match(fs.readFileSync(path.join(kept[0].kept, 'tap.txt'), 'utf8'), /signal: 'SIGSEGV'/);
  assert.match(RC.crashLines(kept)[0], /^run: CRASH: test\/procfs-linux-only\.test\.cjs died of SIGSEGV; evidence kept in .*\(node-.*\.ips, report.*\.json, tap\.txt\)$/);
  // CONTROL: a pass without a crash keeps nothing
  assert.deepStrictEqual(RC.keepCrashes('ok 1 - x', { original, diagDir, since: 0 }), []);
});

test('systemCrashReports reads only node\'s macOS reports since the pass began, and nothing off macOS or without a home', (t) => {
  const home = scratch(t);
  const dir = path.join(home, 'Library', 'Logs', 'DiagnosticReports');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'node-old.ips');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, new Date(1000), new Date(1000));
  fs.writeFileSync(path.join(dir, 'node-new.ips'), 'x');
  fs.writeFileSync(path.join(dir, 'Safari-new.ips'), 'x');
  const since = Date.now() - 60000;
  assert.deepStrictEqual(RC.systemCrashReports(since, { platform: 'darwin', home }).map((p) => path.basename(p)), ['node-new.ips']);
  assert.deepStrictEqual(RC.systemCrashReports(since, { platform: 'linux', home }), []);
  assert.deepStrictEqual(RC.systemCrashReports(since, { platform: 'darwin' }), [], 'no home named: nothing read');
});
