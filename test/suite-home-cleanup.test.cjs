'use strict';
// The suite home is removed by the process that made it, and by nothing else (grep-native Task 10b fix round 4).
//
// test/run.mjs used to read SUITE_HOME = process.env.HOME after requiring ./suite-home.cjs and rmSync it at exit. But
// applySuiteHome leaves HOME alone whenever CLODE_TEST_REAL_HOME is already set (a runner started under a suite child,
// a run spreading process.env, a developer exporting it while debugging): then process.env.HOME IS THE REAL HOME, and
// the runner deleted it. Now suite-home.cjs owns the cleanup: an exit hook removes ONLY the dir this process created,
// and only if it lies under os.tmpdir(), carries the clode-test-home- prefix, and is neither the real home nor an
// ancestor of it. EVERY run here points its "real" home at a SENTINEL, never at the developer's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUITE_HOME = path.join(__dirname, 'suite-home.cjs');
const sentinel = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-home-sentinel-'));
  fs.writeFileSync(path.join(d, 'KEEP'), 'the sentinel real home\n');
  return d;
};
// a child that requires suite-home, reports HOME, and exits normally (the exit hook runs)
function child(env, extra = '') {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SUITE_HOME)}); ${extra}
    process.stdout.write(JSON.stringify({ HOME: process.env.HOME }));`], { env, encoding: 'utf8' });
}
const baseEnv = () => {
  const e = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || os.tmpdir() };
  return e;
};

test('with CLODE_TEST_REAL_HOME preset and HOME = that (sentinel) home, nothing of it is removed', () => {
  const s = sentinel();
  try {
    const r = child({ ...baseEnv(), HOME: s, CLODE_TEST_REAL_HOME: JSON.stringify({ HOME: s, USERPROFILE: null, CLAUDE_CONFIG_DIR: null }) },
      // what test/run.mjs did at exit: remove "the suite home" read back from HOME
      "const { removeOwnSuiteHome } = require(" + JSON.stringify(SUITE_HOME) + "); removeOwnSuiteHome(process.env.HOME);");
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s, 'KEEP')), 'the sentinel real home was deleted');
  } finally { fs.rmSync(s, { recursive: true, force: true }); }
});

test('a process that made the suite home removes it at exit: no clode-test-home-* dir is left', () => {
  const s = sentinel();
  try {
    const r = child({ ...baseEnv(), HOME: s });
    assert.strictEqual(r.status, 0, r.stderr);
    const made = JSON.parse(r.stdout).HOME;
    assert.notStrictEqual(made, s);
    assert.match(path.basename(made), /^clode-test-home-/);
    assert.ok(!fs.existsSync(made), `${made} was left behind`);
    assert.ok(fs.existsSync(path.join(s, 'KEEP')), 'the sentinel real home was touched');
  } finally { fs.rmSync(s, { recursive: true, force: true }); }
});

test('removeOwnSuiteHome refuses anything it did not make here, under tmp, with the prefix, and away from the real home', () => {
  const s = sentinel();
  const r = child({ ...baseEnv(), HOME: s }, `
    const { removeOwnSuiteHome } = require(${JSON.stringify(SUITE_HOME)});
    const fs = require('fs'), os = require('os'), path = require('path');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-test-home-'));   // the prefix, but not ours
    const verdicts = {
      real: removeOwnSuiteHome(${JSON.stringify(s)}),
      other: removeOwnSuiteHome(other),
      tmp: removeOwnSuiteHome(os.tmpdir()),
      ancestor: removeOwnSuiteHome(path.dirname(${JSON.stringify(s)})),
    };
    const otherSurvived = fs.existsSync(other); fs.rmSync(other, { recursive: true, force: true });
    process.stderr.write(JSON.stringify({ verdicts, otherSurvived }));`);
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stderr);
    assert.deepStrictEqual(got.verdicts, { real: false, other: false, tmp: false, ancestor: false });
    assert.strictEqual(got.otherSurvived, true);
    assert.ok(fs.existsSync(path.join(s, 'KEEP')));
  } finally { fs.rmSync(s, { recursive: true, force: true }); }
});
