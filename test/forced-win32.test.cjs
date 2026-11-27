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
//      here (which is why scripts/engine-recipe.cjs's FILES is derived); a fourth would
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

// THE SPAWN-INJECTED DECLARATION (fix round 1 of CI 44443821699, #2087). naude-entry.test.cjs injects spawn into every
// runNaude it calls, yet was OUT because the PRODUCTION module it tests requires child_process; its win32 branch went
// unseen until a Windows runner. A test file may declare `// forced-win32: spawn-injected: <why>`: its REAL_OS check
// then reads its own test-side closure only. A declaration whose test-side code still spawns stays OUT, and is named.
const TT = path.join(T, 'test');
const DA = path.join(TT, 'd.test.cjs');
const DHELP = path.join(TT, 'd-helper.cjs');
const PROD = path.join(T, 'libexec', 'prod.cjs');
const DECL = '// forced-win32: spawn-injected: every call injects spawn\n';
test('a declared spawn-injected file is IN though its production module spawns; undeclared, it is OUT', () => {
  const files = {
    [DA]: `${DECL}const p = require('../libexec/prod.cjs'); process.platform;\n`,
    [PROD]: "const cp = require('node:child_process');\n",
  };
  assert.deepStrictEqual(F.forcedWin32Files([DA], fakeIo(files)), [DA]);
  assert.deepStrictEqual(F.spawnInjectedContradictions([DA], fakeIo(files)), []);
  const undeclared = { ...files, [DA]: files[DA].replace(DECL, '') };
  assert.deepStrictEqual(F.forcedWin32Files([DA], fakeIo(undeclared)), []);
  // a declaration with no reason is no declaration
  const bare = { ...files, [DA]: files[DA].replace(DECL, '// forced-win32: spawn-injected:\n') };
  assert.deepStrictEqual(F.forcedWin32Files([DA], fakeIo(bare)), []);
});
test('a declared file whose OWN test-side code spawns (itself or a test/ helper) stays OUT and is named a contradiction', () => {
  const self = { [DA]: `${DECL}process.platform; spawnSync('sh', []);\n` };
  assert.deepStrictEqual(F.forcedWin32Files([DA], fakeIo(self)), []);
  assert.deepStrictEqual(F.spawnInjectedContradictions([DA], fakeIo(self)), [DA]);
  const helper = { [DA]: `${DECL}require('./d-helper.cjs'); process.platform;\n`, [DHELP]: "require('node:child_process');\n" };
  assert.deepStrictEqual(F.forcedWin32Files([DA], fakeIo(helper)), []);
  assert.deepStrictEqual(F.spawnInjectedContradictions([DA], fakeIo(helper)), [DA]);
});
test('no test file in the tree declares spawn-injected falsely, and naude-entry.test.cjs is in the pass', () => {
  const all = F.discover(path.join(REPO, 'test'));
  assert.deepStrictEqual(F.spawnInjectedContradictions(all).map((f) => path.relative(REPO, f)), []);
  assert.ok(F.forcedWin32Files(all).some((f) => path.basename(f) === 'naude-entry.test.cjs'),
    'naude-entry.test.cjs (#2087\'s win32 policy branch) must run under forcing');
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

// ----------------------------------------------------- no file leaves silently ----

// Rule 1 (forced-win32.cjs, NO FILE LEAVES THE PASS SILENTLY): every file that is OUT only because a production module
// spawns is named in PRODUCTION_SPAWN_EXCLUDED, and every name there still is.
test('no file leaves the pass unnamed: each one OUT only by a production spawn is listed, with a reason', () => {
  assert.deepStrictEqual(F.exclusionFindings(F.discover(path.join(REPO, 'test')), REPO), []);
  for (const [k, why] of Object.entries(F.PRODUCTION_SPAWN_EXCLUDED)) assert.ok(why && why.length > 20, `${k}: no reason`);
});

test('CONTROL: a file pushed OUT by a production spawn, unlisted, is named; a listed one no longer OUT is stale', () => {
  const repo = T;
  const files = {
    [DA]: "const p = require('../libexec/prod.cjs'); process.platform;\n",   // undeclared, prod spawns: OUT
    [PROD]: "const cp = require('node:child_process');\n",
  };
  const io = fakeIo(files);
  assert.deepStrictEqual(F.forcedWin32Files([DA], io), [], 'sanity: it is OUT');
  const findings = F.exclusionFindings([DA], repo, io, { 'test/gone.test.cjs': 'a reason long enough to count' });
  assert.strictEqual(findings.length, 2, findings.join('\n'));
  assert.match(findings[0], /^test\/d\.test\.cjs: LEFT the forced-win32 pass/);
  assert.match(findings[1], /^test\/gone\.test\.cjs: listed .* no longer excluded/);
  assert.deepStrictEqual(F.exclusionFindings([DA], repo, io, { 'test/d.test.cjs': 'a reason long enough to count' }), []);
});

// AUDIT_PENDING is shrink-only debt (ruling 2026-11-19): the frozen baseline, under its ceiling, and nothing else.
test('AUDIT_PENDING is the frozen 2026-11-19 baseline only, at or under its ceiling', () => {
  assert.ok(Object.isFrozen(F.AUDIT_PENDING_BASELINE));
  assert.ok(F.AUDIT_PENDING_BASELINE.length <= F.AUDIT_PENDING_CEILING && F.AUDIT_PENDING_CEILING <= 38,
    'the baseline only shrinks, and the ceiling only falls from 38');
  for (const [k, why] of Object.entries(F.PRODUCTION_SPAWN_EXCLUDED)) {
    if (why === F.AUDIT_PENDING) assert.ok(F.AUDIT_PENDING_BASELINE.includes(k), k);
  }
});

test('CONTROL: a 39th AUDIT_PENDING exclusion is RED by name; so is a baseline over its ceiling', () => {
  const io = fakeIo({ [DA]: "const p = require('../libexec/prod.cjs'); process.platform;\n", [PROD]: "require('node:child_process');\n" });
  const listed = { ...F.PRODUCTION_SPAWN_EXCLUDED, 'test/d.test.cjs': F.AUDIT_PENDING };
  const findings = F.exclusionFindings([DA], T, io, listed);
  assert.ok(findings.some((x) => /^test\/d\.test\.cjs: excluded as AUDIT_PENDING but not in the frozen 2026-11-19 baseline/.test(x)),
    findings.join('\n'));
  const over = F.exclusionFindings([DA], T, io, { 'test/d.test.cjs': 'its own reason, specific enough' },
    [...F.AUDIT_PENDING_BASELINE, 'test/d.test.cjs']);
  assert.ok(over.some((x) => x.includes(`over its ceiling of ${F.AUDIT_PENDING_CEILING}`)), over.join('\n'));
});

// Rule 2: node --test's stand-in for a file that reported nothing of its own, as it really spells it (measured on
// node 26: "ok N - empty.test.cjs" for a file with no test() and for one that exits 0 at require time; "not ok N -
// throws.test.cjs" for one that throws). A real test's name is never mistaken for a file.
test('silentFiles reads the stand-ins, relative or absolute, and TAP-escaped', () => {
  const cwd = path.resolve(path.sep === '\\' ? 'C:\\r' : '/r');
  const abs = path.join(cwd, 'test', 'empty.test.cjs');
  const tap = ['TAP version 13', `ok 1 - ${path.join('test', 'empty.test.cjs').replace(/\\/g, '\\\\')}`,
    'not ok 2 - test/throws.test.cjs', 'ok 3 - a real test about test/fine.test.cjs', '    ok 1 - test/fine.test.cjs', '1..3'].join('\n');
  assert.deepStrictEqual(F.silentFiles([abs, 'test/throws.test.cjs', 'test/fine.test.cjs'], tap, cwd).sort(),
    [abs, 'test/throws.test.cjs'].sort());
});

// The MAIN pass reads the same stand-ins (test/run.mjs calls silentFiles(files, tapText); the wiring guard holds it):
// real node --test over planted files, its real TAP, the same function.
test('CONTROL: the main pass\'s TAP names a file that throws at require time and one with no tests', () => {
  const d = mkdtemp();
  try {
    const w = (n, src) => { const p = path.join(d, n); fs.writeFileSync(p, src); return p; };
    const files = [w('throws.test.cjs', "throw new Error('boom');\n"), w('empty.test.cjs', '// no tests\n'),
      w('fine.test.cjs', "require('node:test').test('fine', () => {});\n")];
    const tap = path.join(d, 'out.tap');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
    spawnSync(process.execPath, ['--test', '--test-reporter', 'tap', '--test-reporter-destination', tap, ...files], { env });
    assert.deepStrictEqual(F.silentFiles(files, fs.readFileSync(tap, 'utf8')).sort(), files.slice(0, 2).sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CONTROL: a file that throws at require time, and one with no tests, are RED BY NAME under the pass', () => {
  const d = mkdtemp();
  try {
    const w = (n, src) => { const p = path.join(d, n); fs.writeFileSync(p, src); return p; };
    const throws = w('throws.test.cjs', "throw new Error('boom at require time');\n");
    const empty = w('empty.test.cjs', '// registers no test, exits 0\n');
    const fine = w('fine.test.cjs', "require('node:test').test('fine', () => {});\n");
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
    const run = (...files) => spawnSync(process.execPath, [path.join(__dirname, 'forced-win32.cjs'), '--run', ...files],
      { env, encoding: 'utf8' });
    const red = run(throws, empty, fine);
    assert.notStrictEqual(red.status, 0, red.stdout + red.stderr);
    assert.ok(red.stderr.includes(`forced-win32: ${throws} reported NO tests`), red.stderr);
    assert.ok(red.stderr.includes(`forced-win32: ${empty} reported NO tests`), red.stderr);
    assert.ok(!red.stderr.includes(`${fine} reported`), 'the healthy file is not blamed');
    // The zero-test file alone exits 0 under plain node --test: only the by-name rule makes it red.
    const emptyOnly = run(empty);
    assert.notStrictEqual(emptyOnly.status, 0, 'a file with no tests is red, not a green "ok - <file>"');
    assert.strictEqual(run(fine).status, 0, run(fine).stderr);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
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
  try { return runTestFile(f, withPreload); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

function runTestFile(f, withPreload) {
  // NODE_TEST_CONTEXT et al. are set by the `node --test` running THIS file, and an
  // inner `node --test` that inherits them thinks it is a reporter child: it exits 0
  // having run nothing, so the control would report "cannot fail" for a reason that has
  // nothing to do with the preload. Scrubbed, not worked around.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  if (withPreload) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${F.PRELOAD}`.trim();
  return spawnSync(process.execPath, ['--test', '--test-reporter', 'tap', f],
    { env, encoding: 'utf8' });
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

// A spawn-injected declaration is checked against the file's TEXT (above), and the text
// check reads only the test side: a spawn that hides in a production module the test
// requires is invisible to it. The preload's spawn trap is what makes the declaration
// binding — this fixture is IN the set by text, and still goes red at the spawn.
test('CONTROL: a false spawn-injected declaration goes RED under the preload',
  { skip: NO_FORCING_ON_WIN32 }, () => {
  const d = mkdtemp();
  try {
    const tdir = path.join(d, 'test');
    const ldir = path.join(d, 'libexec');
    fs.mkdirSync(tdir); fs.mkdirSync(ldir);
    fs.writeFileSync(path.join(ldir, 'spawner.cjs'),
      "module.exports = () => require('node:child_process').spawnSync(process.execPath, ['-e', '']).status;\n");
    const f = path.join(tdir, 'liar.test.cjs');
    fs.writeFileSync(f, `${DECL}const { test } = require('node:test');
const run = require('../libexec/spawner.cjs');
test('declared injected, really spawns', () => { if (process.platform === 'win32') run(); });
`);
    assert.deepStrictEqual(F.forcedWin32Files([f]), [f],
      'sanity: the fixture must be IN the forced set by its text, or this control proves nothing');
    const red = runTestFile(f, true);
    assert.notStrictEqual(red.status, 0, red.stdout + red.stderr);
    assert.match(red.stdout, /forced-win32: a real spawn in a forced run/);
    assert.strictEqual(runTestFile(f, false).status, 0, 'and it is green unforced');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CONTROL: the honest declarer, test/naude-entry.test.cjs, stays GREEN under the trap',
  { skip: NO_FORCING_ON_WIN32 }, () => {
  const r = runTestFile(path.join(__dirname, 'naude-entry.test.cjs'), true);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /a real spawn in a forced run/);
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
    rule(/silentFiles\(files, tapText\)/.test(i.run),
      'test/run.mjs no longer names a MAIN-pass file that reported no tests of its own');
    rule(/silentFiles\(forcedFiles/.test(i.run),
      'test/run.mjs no longer names a forced file that reported no tests of its own: a file that dies or registers '
      + 'nothing would read as a green "ok - <file>" again');
    rule(/forcedWin32Files/.test(i.run),
      'test/run.mjs no longer calls forcedWin32Files — the pass is a script nobody invokes, '
      + 'which is the gate-that-never-runs shape this repo has already paid for');
    return { findings, examined };
  },
  // Every rule violated at once.
  control: () => ({ pass: '// a header with no limits stated at all\n', run: 'process.exit(0);\n' }),
});

guardTests(WIRING_GUARD);
