'use strict';
// THE GATE ON THE FORCED-WIN32 PASS ITSELF.
//
// The pass (test/forced-win32.cjs + test/forced-win32-preload.cjs, run by test/run.mjs
// straight after the main suite) exists because FOUR consecutive rounds of Windows-only
// CI failures were POSIX assumptions in TEST code that no local run could reach. Its own
// failure mode is the one this repo keeps paying for: a gate that runs, reports green,
// and is structurally unable to fail. So this file pins four separate things —
//
//   1. the FILE SET IS DERIVED, not a list. Three hand-maintained lists have gone stale
//      here (which is why scripts/engine-recipe.mjs's FILES is derived); a fourth would
//      rot the same way.
//   2. the pass CAN FAIL. A control fixture with a plain POSIX assumption is run through
//      the real pass and required to go RED — and required to go GREEN without the
//      preload, so the redness is provably the forcing and not the fixture.
//   3. the LIMITS ARE TRUE. The pass's documented blind spots (path separators, a real
//      filesystem) are asserted against the running preload rather than merely written
//      down, so a future preload that quietly acquires more reach makes this red instead
//      of letting the docs lie.
//   4. it is WIRED IN. A pass that test/run.mjs stops invoking is a gate that never runs,
//      which this repo has also already paid for.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { defineGuard, guardTests } = require('./guard.cjs');
const F = require('./forced-win32.cjs');
const REPO = path.join(__dirname, '..');
const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clode-forced-win32-'));

const T = path.resolve(path.sep === '\\' ? 'C:\\t' : '/t');
const A = path.join(T, 'a.test.cjs');
const HELPER = path.join(T, 'helper.cjs');

// A fake tree, so the derivation is tested on inputs this file controls rather than on
// whatever happens to be in test/ today.
//
// NATIVE paths, not POSIX literals. forcedWin32Files() follows a file's relative
// requires with path.resolve(path.dirname(file), spec), so on Windows a key spelled
// '/t/helper.cjs' is never what the lookup asks for — path.resolve there answers
// 'D:\\t\\helper.cjs' (the cwd's drive), io.exists() misses, the helper is never
// followed, and the transitive-exclusion case silently stopped testing the transitive
// rule: it went red on windows-latest in CI run 35521083887, test 1138, expecting [] and
// getting the file back. Building the fixture's paths the way the code under test builds
// its own is the fix, and it makes the fixture exercise real resolution on every OS
// instead of only on the ones whose separator happens to match the literal.
function fakeIo(files) {
  return {
    read: (f) => {
      if (!(f in files)) throw new Error(`fake io: no ${f}`);
      return files[f];
    },
    exists: (f) => f in files,
  };
}

// ---------------------------------------------------------------- derivation ----

test('a platform-sensitive file with no reach into the real OS is IN the pass', () => {
  const io = fakeIo({ [A]: "if (process.platform === 'win32') {}\n" });
  assert.deepStrictEqual(F.forcedWin32Files([A], io), [A]);
});

test('a file with no platform sensitivity at all is OUT — nothing to force', () => {
  const io = fakeIo({ [A]: 'assert.ok(1 + 1 === 2);\n' });
  assert.deepStrictEqual(F.forcedWin32Files([A], io), []);
});

test('a sensitive file that SPAWNS is OUT, because the child sees the real OS', () => {
  // This is the pass's central honesty constraint, not a convenience: forcing
  // process.platform is a lie told to ONE process. Anything it spawns — a shell, a
  // compiler, an engine, `cmd.exe` — still runs on the real machine, so a forced run of
  // such a file reports a contradiction between the lie and the box rather than anything
  // about Windows. MEASURED, before this rule existed: of the 177 test files matching
  // the sensitivity pattern, 100 went red under forcing, and 85 of those died in ONE
  // place — scripts/build-scratch.cjs's exec probe spawning `cmd.exe`, which a Mac does
  // not have. That is 341 of 424 failures carrying no information about Windows.
  const io = fakeIo({ [A]: "process.platform; spawnSync('sh', []);\n" });
  assert.deepStrictEqual(F.forcedWin32Files([A], io), []);
});

test('the reach is TRANSITIVE: a sensitive file whose helper spawns is OUT too', () => {
  // The helper is where this would otherwise hide — test/*.cjs helpers are shared by
  // dozens of test files, and a per-file text scan would call every one of them clean.
  const io = fakeIo({
    [A]: "require('./helper.cjs'); process.platform;\n",
    [HELPER]: "const { execFileSync } = require('node:child_process');\n",
  });
  assert.deepStrictEqual(F.forcedWin32Files([A], io), []);
  // ...and the same file is IN once the helper stops reaching the real OS, which proves
  // the exclusion is the helper and not the require itself.
  const clean = fakeIo({
    [A]: "require('./helper.cjs'); process.platform;\n",
    [HELPER]: 'module.exports = {};\n',
  });
  assert.deepStrictEqual(F.forcedWin32Files([A], clean), [A]);
  // And the fixture really did exercise resolution rather than getting the right answer
  // by never looking: the helper key is the path the closure walk asks for.
  assert.strictEqual(path.resolve(path.dirname(A), './helper.cjs'), HELPER);
});

test('the real set is DERIVED from the tree and meets a floor', () => {
  const files = F.forcedWin32Files(F.discover(path.join(REPO, 'test')));
  assert.ok(files.length >= F.FLOOR,
    `the pass covers ${files.length} file(s), below the floor of ${F.FLOOR} — either the `
    + 'sensitivity pattern stopped matching (a derivation regression) or the suite really '
    + 'did lose that much platform-sensitive fixture code. Do not lower the floor to make '
    + 'this pass.');
  for (const f of files) assert.ok(f.endsWith('.test.cjs'), `${f} is not a test file`);
  // And it is a SUBSET, not everything: a pass that claims to cover every file would be
  // claiming Windows coverage it does not have.
  assert.ok(files.length < F.discover(path.join(REPO, 'test')).length);
});

// ------------------------------------------------------------------- control ----

// ON A REAL WINDOWS RUNNER THE FORCING IS A NO-OP, so neither half of this control can
// say anything there: `process.platform` is already 'win32', the preload changes nothing,
// and the fixture below is red with OR without it. That made the first half pass
// VACUOUSLY on windows-latest — a control that cannot fail, which is the exact defect
// this file exists to prevent — and the second half fail outright (CI run 35521083887,
// test 1141). Both are skipped there, with the reason stated, because the thing they
// prove is "the lie reaches the child on a box where it IS a lie". The ubuntu and darwin
// rows prove it on every push, and Windows does not need a simulation of Windows: the
// main suite already ran every one of these files on the real platform.
const NO_FORCING_ON_WIN32 = process.platform === 'win32'
  && 'windows: forcing process.platform to win32 on win32 is not a lie, so neither the '
  + 'red half nor the green half of this control can distinguish the preload from the '
  + 'platform. The ubuntu and darwin rows prove the forcing works; this row already ran '
  + 'the whole suite on the real thing.';

// The control fixture: one assertion that is true on POSIX and false on Windows, written
// the way the three earlier rounds were written — no win32 branch, no skip.
const POSIX_ASSUMING_FIXTURE = `
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
test('assumes a POSIX platform', () => {
  assert.notStrictEqual(process.platform, 'win32', 'this box is POSIX');
});
`;

function runFixture(withPreload) {
  const d = mkdtemp();
  const f = path.join(d, 'control.test.cjs');
  fs.writeFileSync(f, POSIX_ASSUMING_FIXTURE);
  // NODE_TEST_CONTEXT et al. are set by the `node --test` running THIS file, and an
  // inner `node --test` that inherits them thinks it is a reporter child: it exits 0
  // having run nothing, so the control would report "cannot fail" for a reason that has
  // nothing to do with the preload. Scrubbed, not worked around.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  if (withPreload) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${F.PRELOAD}`.trim();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter', 'tap', f],
    { env, encoding: 'utf8' });
  fs.rmSync(d, { recursive: true, force: true });
  return r;
}

test('CONTROL: the pass can actually FAIL — a POSIX assumption goes red under it',
  { skip: NO_FORCING_ON_WIN32 }, () => {
  const red = runFixture(true);
  assert.notStrictEqual(red.status, 0,
    'the forced-win32 preload did not turn a plain POSIX assumption red. The pass is '
    + 'structurally unable to fail, which is worse than not having it: it reports green '
    + 'over exactly the class of bug it was built for.');
  assert.match(red.stdout, /this box is POSIX/);
});

test('CONTROL: the same fixture is GREEN without the preload',
  { skip: NO_FORCING_ON_WIN32 }, () => {
  // Without this half, the control above would also be satisfied by a preload that
  // breaks node:test outright — "it went red" would prove nothing about the forcing.
  const green = runFixture(false);
  assert.strictEqual(green.status, 0, green.stdout + green.stderr);
});

// -------------------------------------------------------------------- limits ----

// What the pass covers is exactly as important as what it does not, and a limit that is
// only WRITTEN DOWN drifts. Each one below is asserted against the real preload.
function probe(expr) {
  const r = spawnSync(process.execPath, ['--require', F.PRELOAD, '-e',
    `process.stdout.write(String(${expr}))`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test('LIMIT it DOES reach: process.platform really is win32 in the child', () => {
  assert.strictEqual(probe('process.platform'), 'win32');
  assert.strictEqual(probe('process.env.CLODE_FORCED_WIN32'), '1',
    'the preload must leave a witness, or a --require that silently failed to load would '
    + 'read as a clean pass over the whole set');
});

test('LIMIT it does NOT reach: path separators stay POSIX', () => {
  // node binds node:path to the POSIX implementation during bootstrap, BEFORE any
  // --require runs, so `path.join`, `path.sep` and `path.isAbsolute` keep POSIX
  // semantics no matter what process.platform says. The backslash/drive-letter class of
  // bug — round 3's `C:\\Program Files\\...` split — is therefore OUT OF REACH of this
  // pass. Asserted so the claim cannot quietly stop being true.
  assert.strictEqual(probe('require("node:path").sep'), path.sep);
  assert.strictEqual(probe('require("node:path").win32.sep'), '\\',
    'sanity: path.win32 is still available for code that asks for it explicitly');
});

test('LIMIT it does reach, but only halfway: os.tmpdir() takes the win32 branch', () => {
  // os.tmpdir()'s win32 branch reads TEMP/TMP, which a POSIX box does not set — the
  // preload points them at the real tmpdir so the branch is EXERCISED and still returns
  // a directory that exists. A test that hardcodes '/tmp' instead of asking still goes
  // red; a test that asks keeps working.
  const t = probe('require("node:os").tmpdir()');
  assert.ok(fs.existsSync(t), `forced os.tmpdir() must still exist, got ${JSON.stringify(t)}`);
});

// Both of the remaining questions — "does the header still name what the pass cannot
// catch?" and "does test/run.mjs still invoke it?" — are read off artifacts this file did
// not write, which makes them a GUARD, not a pair of assertions (test/guard.cjs). The
// control feeds every rule a violating input, so a rule that has gone blind reports as a
// shortfall instead of a pass. Without this they would be the shape that has read clean
// for two years elsewhere in this repo.
const WIRING_GUARD = defineGuard({
  name: 'forced-win32-wiring',
  floor: 7,
  read: () => ({
    pass: fs.readFileSync(path.join(__dirname, 'forced-win32.cjs'), 'utf8'),
    run: fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8'),
  }),
  scan: (i) => {
    const findings = [];
    let examined = 0;
    const rule = (ok, finding) => { examined += 1; if (!ok) findings.push(finding); };
    const lower = i.pass.toLowerCase();
    // The limits, one rule each, because each is a separate thing a reader could be
    // misled about and a count that collapses them hides which one went missing.
    for (const claim of ['path separator', 'real windows', 'lib.exe', 'crlf']) {
      rule(lower.includes(claim),
        `the pass's own header no longer names what it cannot catch (${claim}) — a second `
        + 'pass whose limits live only in a commit message reads as Windows coverage');
    }
    rule(/forced-win32\.cjs/.test(i.run),
      'test/run.mjs no longer derives the forced set from test/forced-win32.cjs');
    rule(/PRELOAD/.test(i.run),
      'test/run.mjs no longer passes the preload to the second `node --test`, so the pass '
      + 'runs with the real platform and proves nothing');
    rule(/forcedWin32Files/.test(i.run),
      'test/run.mjs no longer calls forcedWin32Files — the pass is a script nobody invokes, '
      + 'which is the gate-that-never-runs shape this repo has already paid for');
    return { findings, examined };
  },
  // Every rule violated at once.
  control: () => ({ pass: '// a header with no limits stated at all\n', run: 'process.exit(0);\n' }),
});

guardTests(WIRING_GUARD);
