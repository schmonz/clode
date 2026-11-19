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

// windows-amd64-tui (CI 44443821699) died at exit with node's bare "EPERM, Permission denied: <the suite home>": node's
// rm names the root, never the entry that refused. Now the failure names each refusing entry by path, code and mode,
// and still fails. A held file is simulated by an rm that refuses it (and the root while it is there), as Windows does.
test('a suite home that cannot be removed fails naming the entry that refused, not just the root', () => {
  const s = sentinel();
  const r = child({ ...baseEnv(), HOME: s }, `
    const { removeOwnSuiteHome } = require(${JSON.stringify(SUITE_HOME)});
    const fs = require('fs'), path = require('path');
    const home = process.env.HOME, held = path.join(home, '.claude', 'held.txt');
    fs.writeFileSync(held, 'x');
    fs.writeFileSync(path.join(home, 'free.txt'), 'x');
    const rm = (p, o) => {
      if (p === held || (p === home && fs.existsSync(held))) { const e = new Error('EPERM, Permission denied: ' + p); e.code = 'EPERM'; throw e; }
      return fs.rmSync(p, o);
    };
    let err = null;
    try { removeOwnSuiteHome(home, { rm }); } catch (e) { err = { code: e.code, message: e.message }; }
    const left = { held: fs.existsSync(held), free: fs.existsSync(path.join(home, 'free.txt')) };
    process.stderr.write('RESULT:' + JSON.stringify({ err, left }) + '\\n');`);
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stderr.split('RESULT:')[1]);
    assert.ok(got.err, 'a refused removal must fail, never pass silently');
    assert.strictEqual(got.err.code, 'EPERM');
    const want = `1 entry under it refused removal: ${path.join('.claude', 'held.txt')} (EPERM, mode `;
    assert.ok(got.err.message.includes(want), `${got.err.message}\nmust name: ${want}`);
    assert.deepStrictEqual(got.left, { held: true, free: false }, 'the free entries are removed on the way; the held one is not');
  } finally { fs.rmSync(s, { recursive: true, force: true }); }
});

// A delete-pending entry on Windows (another process holds it open with FILE_SHARE_DELETE) still sits in readdir but
// fails lstat with EPERM: that is the entry to name, never one to count as gone. Only ENOENT is gone. Simulated by an
// lstat and an rm that refuse it (fix round 1, review finding 1).
test('an entry whose lstat fails other than ENOENT is named (mode ?), never counted as gone', () => {
  const { removeNamingRefusals } = require(SUITE_HOME);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-home-pending-'));
  const pending = path.join(dir, 'sub', 'pending.txt');
  fs.mkdirSync(path.dirname(pending));
  fs.writeFileSync(pending, 'x');
  fs.writeFileSync(path.join(dir, 'free.txt'), 'x');
  const eperm = (p) => { const e = new Error(`EPERM, Permission denied: ${p}`); e.code = 'EPERM'; return e; };
  const rm = (p, o) => { if (p === pending || (fs.existsSync(pending) && pending.startsWith(p + path.sep))) throw eperm(p); return fs.rmSync(p, o); };
  const lstat = (p) => { if (p === pending) throw eperm(p); return fs.lstatSync(p); };
  try {
    let err = null;
    try { removeNamingRefusals(dir, { rm, lstat, what: 'the fixture' }); } catch (e) { err = e; }
    assert.ok(err, 'a refused removal must fail');
    assert.strictEqual(err.code, 'EPERM');
    const want = `1 entry under it refused removal: ${path.join('sub', 'pending.txt')} (EPERM, mode ?)`;
    assert.ok(err.message.includes(want), `${err.message}\nmust name: ${want}`);
    assert.ok(err.message.startsWith(`could not remove the fixture ${dir} (EPERM)`), err.message);
    assert.ok(!fs.existsSync(path.join(dir, 'free.txt')), 'the free entry is removed on the way');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
