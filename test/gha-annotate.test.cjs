'use strict';
// test/gha-annotate.cjs: the stale-record warning as a GitHub Actions annotation and a step-summary line.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { annotate } = require('./gha-annotate.cjs');

test('annotate: in GitHub Actions, a ::warning command (collected for run.mjs) and a step-summary line; elsewhere nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-gha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { GITHUB_ACTIONS: 'true', CLODE_GHA_ANNOTATIONS: path.join(dir, 'ann'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum') };
  const msg = 'NetBSD/arm64 VM record stale since 9e20ba4c5df8 (drivers changed); run node scripts/netbsd-arm64-evidence.mjs';
  annotate({ title: 'NetBSD/arm64 record stale', message: msg }, env);
  assert.strictEqual(fs.readFileSync(env.CLODE_GHA_ANNOTATIONS, 'utf8'), `::warning title=NetBSD/arm64 record stale::${msg}\n`);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*WARNING: NetBSD\/arm64 record stale\*\*: NetBSD\/arm64 VM record stale since 9e20ba4c5df8/);
  // GitHub's escaping: a newline or % in the data, a : or , in a property
  annotate({ title: 'a:b,c', message: '50%\nnext' }, env);
  assert.match(fs.readFileSync(env.CLODE_GHA_ANNOTATIONS, 'utf8'), /^::warning title=a%3Ab%2Cc::50%25%0Anext$/m);
  // CONTROL: outside GitHub Actions it writes nothing
  assert.strictEqual(annotate({ title: 'x', message: 'y' }, { CLODE_GHA_ANNOTATIONS: path.join(dir, 'none') }), null);
  assert.ok(!fs.existsSync(path.join(dir, 'none')));
});

test('run.mjs prints the collected annotations raw after the run (the TAP reporter would bury them behind "# ")', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8');
  assert.match(src, /process\.env\.CLODE_GHA_ANNOTATIONS = GHA_ANNOTATIONS;/);
  assert.match(src, /process\.stdout\.write\(fs\.readFileSync\(GHA_ANNOTATIONS, 'utf8'\)\)/);
});
