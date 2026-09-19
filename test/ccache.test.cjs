'use strict';
// scripts/ccache-launcher.cjs — spec 4c3 task 1 ("wire it, optionally") and task 2
// ("prove it helps, and prove it does not lie"). The property that matters most for
// task 1's half is the NEGATIVE one: a leg that has never heard of the tool must build
// EXACTLY as it did before this file existed — proven below against a PATH built to
// exclude ccache (this box has a real one installed for task 2, so that proof can no
// longer lean on ambient state; see the comment at that test for the history).
//
// This file imports the module under test directly rather than reading
// scripts/build-tjs.cjs as text — that file runs a real engine build top to bottom the
// moment it is required, so nothing here can afford to require() it. The two exported
// functions are the entire seam scripts/build-tjs.cjs uses; testing them by direct call
// is testing the real behavior, not a reimplementation of it.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ccacheLauncher, applyCcacheArg, ccacheOptedOut,
  ccacheDecision, describeCcacheDecision, applyCcacheDecision, compilerFromCmakeArgs,
} = require('../scripts/ccache-launcher.cjs');
const { findTool } = require('../libexec/clode-hosttools.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
// Task 2's own requires -- a real build, a real cache, a real diff. Nothing above this
// line needed any of these; nothing below the PROOF tests should need anything else.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

const repo = path.join(__dirname, '..');

// A fixed base array, standing in for whatever scripts/build-tjs.cjs's own cmakeArgs
// looked like the moment before this feature's one call site was added. Every "byte-
// identical" assertion below compares against a fresh copy of this same array.
const BASE_ARGS = Object.freeze(['-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF']);

// ---- the absent path, proven against a PATH built to exclude ccache, not a mock ---
//
// This USED to call the real findTool with no env override at all, trusting that this
// box's ambient PATH genuinely had no ccache on it — true when task 1 shipped, and this
// file's own comment already named the day it would stop being true: "if this ever
// starts failing because someone installed it, the absent-path test below needs a PATH
// override instead of relying on ambient state." Task 2 is that day (pkgsrc: `pkg_add
// ccache`, so this box now has one at /opt/pkg/bin/ccache) — so the tests below build a
// PATH that excludes it explicitly, verified empty first, rather than hoping the ambient
// one stays clean.
//
// AN EMPTY DIRECTORY, NOT A LIST OF SYSTEM ONES (review finding, 2026-09-19). The first
// version of this was '/usr/bin:/bin:/usr/sbin:/sbin' -- less ambient than the real PATH,
// but still an assumption: it goes red the day any image ships /usr/bin/ccache, for a
// reason that has nothing to do with the product. (It was also vacuous on win32, where ';'
// is the delimiter and the whole string reads as one directory name.) One empty temp
// directory has no delimiter in it, contains nothing on any platform, and cannot start
// containing something.
const BARE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ccache-empty-path-'));

test('a PATH built to exclude ccache resolves none (so the next test is real, not a fluke)', () => {
  assert.deepStrictEqual(fs.readdirSync(BARE_PATH), [],
    'the stand-in PATH directory is not empty, so the absent-path proof below is not a proof');
  assert.strictEqual(findTool('ccache', { env: { PATH: BARE_PATH } }), null,
    `${BARE_PATH} unexpectedly resolved a ccache — the absent-path test below needs a `
    + 'PATH that genuinely excludes it, and this one no longer does');
});

test('absent: cmakeArgs comes out byte-identical to before this feature existed', () => {
  const launcherPath = ccacheLauncher({ env: { PATH: BARE_PATH }, findToolFn: findTool });
  assert.strictEqual(launcherPath, null,
    'findTool must report ccache absent on a PATH built to exclude it');
  const out = applyCcacheArg([...BASE_ARGS], launcherPath);
  assert.deepStrictEqual(out, BASE_ARGS,
    'a leg with no ccache must see the exact same cmakeArgs it saw before this feature '
    + 'shipped — no new entry, no reordering');
});

test('opt-out: CLODE_TJS_CCACHE=0 suppresses the probe even when a launcher would resolve', () => {
  const fakeFindToolFn = () => '/fake/bin/ccache';
  const path = ccacheLauncher({ env: { CLODE_TJS_CCACHE: '0' }, findToolFn: fakeFindToolFn });
  assert.strictEqual(path, null, 'the opt-out must win over a resolvable launcher');
});

// ---- the opt-out has to reach CMAKE, not just this function ------------------------
//
// THE BUG THIS PINS (found in review, 2026-09-19): `CLODE_TJS_CCACHE=0` was implemented as
// "push no flag", which is correct for a build dir cmake has never configured and a NO-OP
// for one it has. cmake PERSISTS `-D` values in CMakeCache.txt, and scripts/build-tjs.cjs
// deliberately REUSES build dirs across runs (dropStaleCmakeCache only wipes when the
// source dir moved). So the exact scenario the opt-out exists for -- "I suspect the cache,
// turn it off and rebuild" -- silently kept using ccache, forever, on every developer box
// that had ever built once with it. Nothing caught it because the e2e gate wipes buildRoot
// at the top of every phase, which is right for isolating the phases and is precisely what
// hides this.
//
// THE FIX IS ASYMMETRIC, AND THE ASYMMETRY IS THE POINT. Clearing unconditionally would
// break task 1's headline negative property (a leg with no ccache must produce cmake args
// byte-identical to the pre-feature ones). So the empty `-D` rides the EXPLICIT OPT-OUT
// branch only -- never the tool-absent branch. Both halves are asserted below.
test('opt-out: the launcher is explicitly CLEARED, not merely left unset', () => {
  const out = applyCcacheArg([...BASE_ARGS], null, { clear: true });
  assert.deepStrictEqual(out, [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER='],
    'CLODE_TJS_CCACHE=0 must push an EMPTY -DCMAKE_C_COMPILER_LAUNCHER: pushing nothing is a '
    + 'no-op against a build dir whose CMakeCache already carries the launcher');
});

test('absent: the tool-absent branch does NOT clear (task 1\'s negative property survives the fix)', () => {
  assert.deepStrictEqual(applyCcacheArg([...BASE_ARGS], null, { clear: false }), BASE_ARGS,
    'a leg that simply has no ccache must still see byte-identical cmake args -- only an '
    + 'EXPLICIT opt-out may add a clearing flag');
  assert.deepStrictEqual(applyCcacheArg([...BASE_ARGS], null), BASE_ARGS,
    'the default (no options object) is the absent case, not the opted-out one');
});

test('ccacheOptedOut reads exactly CLODE_TJS_CCACHE=0', () => {
  assert.strictEqual(ccacheOptedOut({ CLODE_TJS_CCACHE: '0' }), true);
  assert.strictEqual(ccacheOptedOut({ CLODE_TJS_CCACHE: '1' }), false);
  assert.strictEqual(ccacheOptedOut({}), false);
});

// ---- TASK 1: THE DECISION MUST BE VISIBLE (2026-09-19) ------------------------------
//
// WHY THIS EXISTS, and it is not hypothetical. The record above (and the comment block in
// scripts/ccache-launcher.cjs) used to say "no runner image we use ships ccache, so the
// wiring is a fleet-wide no-op". That was FALSE. GitHub's windows-latest image ships one
// at C:\Strawberry\c\bin\ccache.EXE -- Strawberry Perl bundles it -- and C:\Strawberry\c\bin
// is on the PATH of the `tjs / leg (windows-amd64, windows-latest, ...)` engine-build job,
// which produces a RELEASE artifact. CI run 35468190935 proved the presence half
// (`actual: 'C:\Strawberry\c\bin\ccache.EXE'`).
//
// What could NOT be proved from that log is whether the launcher flag actually landed,
// because the log never echoes the cmake `-D` arguments at all: `grep -c -- '-DCMAKE'`
// over its 2475 lines returns 0. THAT INVISIBILITY IS ITSELF THE DEFECT this half closes.
// A decision that silently changes which compiler driver runs on a release leg has to be
// readable in the log of every build, whichever way it went -- found, opted out, or absent.
//
// The line is produced by a PURE function so it can be asserted exactly here, rather than
// scanned for in the output of a build no test can afford to run (requiring
// scripts/build-tjs.cjs runs a whole engine build; see this file's header). That the call
// site logs it UNCONDITIONALLY is a separate, registered guard below.
const ENABLED = { env: {}, findToolFn: () => '/fake/bin/ccache' };
const OPTED_OUT = { env: { CLODE_TJS_CCACHE: '0' }, findToolFn: () => '/fake/bin/ccache' };
const ABSENT = { env: { PATH: BARE_PATH }, findToolFn: findTool };

test('decision: a resolvable launcher yields the enabled state, the path, and no clearing flag', () => {
  const d = ccacheDecision(ENABLED);
  assert.strictEqual(d.state, 'enabled');
  assert.strictEqual(d.launcher, '/fake/bin/ccache');
  assert.strictEqual(d.clear, false);
});

test('decision: the opt-out is a state of its own, distinct from absence, and it CLEARS', () => {
  const d = ccacheDecision(OPTED_OUT);
  assert.strictEqual(d.state, 'opted-out');
  assert.strictEqual(d.launcher, null);
  assert.strictEqual(d.clear, true,
    'the opt-out must still clear a launcher cmake persisted in CMakeCache.txt');
});

test('decision: absence is a state of its own, and it must NOT clear', () => {
  const d = ccacheDecision(ABSENT);
  assert.strictEqual(d.state, 'absent');
  assert.strictEqual(d.launcher, null);
  assert.strictEqual(d.clear, false,
    'a leg that simply has no ccache must produce byte-identical cmake args -- see the '
    + 'asymmetry note above');
});

test('log line: ENABLED names the resolved launcher path', () => {
  assert.strictEqual(describeCcacheDecision(ccacheDecision(ENABLED)),
    'build-tjs: ccache: ENABLED launcher=/fake/bin/ccache compiler=cmake-default (found on PATH)');
});

test('log line: the opt-out names the env var that caused it', () => {
  assert.strictEqual(describeCcacheDecision(ccacheDecision(OPTED_OUT)),
    'build-tjs: ccache: DISABLED (opted out: CLODE_TJS_CCACHE=0)');
});

test('log line: absence is STATED, not silent', () => {
  assert.strictEqual(describeCcacheDecision(ccacheDecision(ABSENT)),
    'build-tjs: ccache: DISABLED (not found: no ccache on PATH)');
});

test('log line: every state is one greppable ASCII line under a shared prefix', () => {
  for (const opts of [ENABLED, OPTED_OUT, ABSENT]) {
    const line = describeCcacheDecision(ccacheDecision(opts));
    assert.ok(line.startsWith('build-tjs: ccache: '),
      `every decision must be findable with one grep; got: ${line}`);
    assert.ok(!line.includes('\n'), `the decision must be ONE line; got: ${JSON.stringify(line)}`);
    // ASCII on purpose: this line's whole job is to be readable in a CI log, and the leg
    // that matters most is the Windows one, whose console can mangle UTF-8 punctuation.
    assert.match(line, /^[\x20-\x7e]+$/,
      `the decision line must be plain ASCII to survive a Windows console; got: ${line}`);
  }
});

test('log line: an unrecognised state THROWS rather than logging a blank decision', () => {
  assert.throws(() => describeCcacheDecision({ state: 'something-new', launcher: null }),
    /unknown ccache decision state/,
    'a future state that nobody taught this function about must be loud, not an empty '
    + 'string that reads like "no ccache decision was made"');
});

test('apply: the enabled decision pushes the launcher exactly once', () => {
  const out = applyCcacheDecision([...BASE_ARGS], ccacheDecision(ENABLED));
  assert.deepStrictEqual(out, [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache']);
});

test('apply: the absent decision leaves cmakeArgs byte-identical', () => {
  assert.deepStrictEqual(applyCcacheDecision([...BASE_ARGS], ccacheDecision(ABSENT)), BASE_ARGS);
});

test('apply: the opt-out decision pushes the EMPTY clearing value', () => {
  assert.deepStrictEqual(applyCcacheDecision([...BASE_ARGS], ccacheDecision(OPTED_OUT)),
    [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER=']);
});

// ---- TASK 2: ccache MUST NOT DRIVE A COMPILER NOBODY HAS PROVEN IT WITH -------------
//
// THE LIVE RISK, not a hypothetical: the windows-amd64 engine leg builds with MSVC's
// cl.exe (scripts/tjs-legs.mjs `msvc:true`; build-tjs.cjs pushes -DCMAKE_C_COMPILER=cl),
// C:\Strawberry\c\bin is on its PATH, and ccache.EXE is in that directory. ccache's MSVC
// support is partial -- it is a documented caveat of the tool, and this repo has never
// verified it -- and the Windows legs are precisely the ones where phase 4c3's object-grain
// reproducibility harness is SKIPPED (host leg only). Least verification, most risk, on a
// hard publisher. So the launcher declines that compiler until someone proves otherwise.
//
// HOW THE CODE KNOWS, and why it is not `process.platform === 'win32'`: it reads the
// compiler out of THE CMAKE ARGUMENTS THE BUILD ITSELF JUST ASSEMBLED. That is the same
// signal that selects the compiler -- build-tjs.cjs pushes -DCMAKE_C_COMPILER=cl for the
// MSVC path and -DCMAKE_C_COMPILER=gcc for the (retired, opt-in) mingw path -- so a Windows
// host building with gcc keeps its cache, and the rule reads as "this compiler is one ccache
// cannot be trusted with here", one implementation for all 42 legs, not "if Windows".
const CL_ARGS = Object.freeze([...BASE_ARGS, '-G', 'Ninja', '-DCMAKE_C_COMPILER=cl',
  '-DCMAKE_CXX_COMPILER=cl']);
const GCC_ARGS = Object.freeze([...BASE_ARGS, '-G', 'Ninja', '-DCMAKE_C_COMPILER=gcc',
  '-DCMAKE_CXX_COMPILER=g++']);
const FOUND = () => '/fake/bin/ccache';

test('the compiler is read out of the cmake args the build assembled, not out of the platform', () => {
  assert.strictEqual(compilerFromCmakeArgs(CL_ARGS), 'cl');
  assert.strictEqual(compilerFromCmakeArgs(GCC_ARGS), 'gcc');
  assert.strictEqual(compilerFromCmakeArgs([...BASE_ARGS]), '',
    'a build that names no compiler leaves the choice to cmake, and this function must say '
    + 'so rather than guessing');
});

test('the compiler name is normalised: a full path, a .exe, and case all resolve to one token', () => {
  assert.strictEqual(compilerFromCmakeArgs(['-DCMAKE_C_COMPILER=C:/Program Files/MSVC/bin/CL.EXE']), 'cl');
  assert.strictEqual(compilerFromCmakeArgs(['-DCMAKE_C_COMPILER=/usr/bin/gcc-14']), 'gcc-14');
  assert.strictEqual(compilerFromCmakeArgs(['-DCMAKE_C_COMPILER=clang-cl.exe']), 'clang-cl');
});

test('the LAST -DCMAKE_C_COMPILER wins, the way cmake itself resolves a repeated -D', () => {
  assert.strictEqual(compilerFromCmakeArgs(['-DCMAKE_C_COMPILER=gcc', '-DCMAKE_C_COMPILER=cl']), 'cl');
});

test('declined: a found launcher is NOT enabled when the compiler is cl', () => {
  const d = ccacheDecision({ env: {}, findToolFn: FOUND, compiler: 'cl' });
  assert.strictEqual(d.state, 'declined');
  assert.strictEqual(d.launcher, null,
    'the launcher must not reach cmake: a wrong cache hit on a hard publisher ships a wrong '
    + 'binary, and no harness on that leg would notice');
  assert.strictEqual(d.compiler, 'cl');
});

test('declined: the reason is a VALUE the log can print, not a comment', () => {
  const d = ccacheDecision({ env: {}, findToolFn: FOUND, compiler: 'cl' });
  assert.match(d.reason, /MSVC/, 'the decision must carry its own reason');
  assert.match(d.reason, /object-grain|reproducibility/,
    'and it must name the missing verification, not just the compiler');
});

test('declined: it still CLEARS, because the leg may already have configured WITH ccache', () => {
  // This is the live case, not a corner: the windows-amd64 build dir can come back warm
  // (cmake persists CMAKE_C_COMPILER_LAUNCHER, build-tjs.cjs reuses build dirs), and it was
  // configured while the launcher was silently enabled. Declining without clearing would
  // leave ccache driving cl on exactly the leg this fix exists for.
  assert.strictEqual(ccacheDecision({ env: {}, findToolFn: FOUND, compiler: 'cl' }).clear, true);
  assert.deepStrictEqual(
    applyCcacheDecision([...CL_ARGS], ccacheDecision({ env: {}, findToolFn: FOUND, compiler: 'cl' })),
    [...CL_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER='],
  );
});

test('an untrusted compiler does NOT resurrect a flag on a box with no ccache at all', () => {
  // TASK 1'S NEGATIVE PROPERTY OUTRANKS THE DECLINE. A leg with no ccache installed must
  // still produce cmake args byte-identical to the pre-feature ones -- including the MSVC
  // legs, whose argv would otherwise change for a tool they do not have.
  const d = ccacheDecision({ env: { PATH: BARE_PATH }, findToolFn: findTool, compiler: 'cl' });
  assert.strictEqual(d.state, 'absent', 'absence is decided BEFORE compiler trust');
  assert.strictEqual(d.clear, false);
  assert.deepStrictEqual(applyCcacheDecision([...CL_ARGS], d), CL_ARGS);
});

test('the decline is keyed on the COMPILER, not on Windows: a gcc leg keeps its cache', () => {
  // The mingw path (CLODE_TJS_WIN_MINGW=1) is a Windows build with gcc. ccache has driven
  // gcc for twenty years; nothing about the host OS is the problem here.
  const d = ccacheDecision({ env: {}, findToolFn: FOUND, compiler: compilerFromCmakeArgs(GCC_ARGS) });
  assert.strictEqual(d.state, 'enabled');
  assert.strictEqual(d.launcher, '/fake/bin/ccache');
});

test('a build that names no compiler is trusted: every native gcc/clang leg is unaffected', () => {
  const d = ccacheDecision({ env: {}, findToolFn: FOUND, compiler: compilerFromCmakeArgs([...BASE_ARGS]) });
  assert.strictEqual(d.state, 'enabled');
});

test('log line: ENABLED names the compiler ccache is driving, not just the launcher', () => {
  assert.strictEqual(
    describeCcacheDecision(ccacheDecision({ env: {}, findToolFn: FOUND, compiler: 'gcc' })),
    'build-tjs: ccache: ENABLED launcher=/fake/bin/ccache compiler=gcc (found on PATH)');
  assert.strictEqual(
    describeCcacheDecision(ccacheDecision({ env: {}, findToolFn: FOUND, compiler: '' })),
    'build-tjs: ccache: ENABLED launcher=/fake/bin/ccache compiler=cmake-default (found on PATH)');
});

test('log line: the decline names the compiler, the launcher it refused, and why', () => {
  const line = describeCcacheDecision(ccacheDecision({ env: {}, findToolFn: FOUND, compiler: 'cl' }));
  assert.ok(line.startsWith('build-tjs: ccache: DISABLED found=/fake/bin/ccache compiler=cl (declined:'),
    `the decline must name what it refused and for which compiler; got: ${line}`);
  assert.match(line, /MSVC/);
  assert.match(line, /^[\x20-\x7e]+$/, 'ASCII, so it survives the Windows console it will be read in');
  assert.ok(!line.includes('\n'), 'one line');
});

test('PROOF: a decision that ignores the compiler fails the decline check', () => {
  // The pre-fix implementation, verbatim in behavior: found on PATH means enabled.
  const ignoresCompiler = ({ findToolFn }) => ({ state: 'enabled', launcher: findToolFn('ccache'), clear: false });
  assert.throws(() => {
    assert.strictEqual(ignoresCompiler({ findToolFn: FOUND, compiler: 'cl' }).launcher, null);
  }, 'an implementation that enables ccache for cl must fail the decline check, or that check '
    + 'is not what stopped it');
});

test('PROOF: reading the compiler off process.platform would misjudge the mingw leg', () => {
  // Why the platform signal was rejected, made concrete rather than argued in a comment: on
  // the SAME win32 host, the two supported compilers want opposite answers, and only the
  // cmake-args signal can tell them apart.
  const byPlatform = (platform) => (platform === 'win32' ? 'cl' : 'cc');
  assert.strictEqual(ccacheDecision({ env: {}, findToolFn: FOUND, compiler: byPlatform('win32') }).state,
    'declined', 'the platform signal declines the mingw leg too');
  assert.strictEqual(ccacheDecision({ env: {}, findToolFn: FOUND, compiler: compilerFromCmakeArgs(GCC_ARGS) }).state,
    'enabled', 'the cmake-args signal does not — this is the difference the fix buys');
});

// The CALL SITE must hand applyCcacheArg BOTH halves, or the clearing flag never reaches a
// real cmake reconfigure and the opt-out is a no-op again. Scanned as text because
// requiring scripts/build-tjs.cjs runs a whole engine build (see this file's header), and
// registered through defineGuard so the scan is PROVEN able to fail rather than merely green.
//
// PURE: `src` is the already-read scripts/build-tjs.cjs text.
function scanOptOutWiring({ src }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/^applyCcacheDecision\(cmakeArgs, ccache\);$/m.test(src)) {
    findings.push('scripts/build-tjs.cjs must apply the DECISION object, or the opt-out\'s '
      + 'clearing flag never reaches cmake and CLODE_TJS_CCACHE=0 goes back to doing nothing '
      + 'on an already-configured build dir');
  }

  examined++;
  if (/applyCcacheArg\(cmakeArgs, ccacheLauncher\(\)[,)]/.test(src)) {
    findings.push('the pre-decision call site is back (applyCcacheArg + a bare ccacheLauncher()): '
      + 'the two-argument shape pushes nothing on the opt-out path, which cmake reads as "keep '
      + 'the cached launcher", and NEITHER shape logs which way the decision went');
  }

  return { findings, examined };
}

const optOutWiringGuard = defineGuard({
  name: 'ccache-opt-out-reaches-cmake',
  read: () => ({ src: fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8') }),
  scan: scanOptOutWiring,
  // Two facts in one named file — the exact measured count.
  floor: 2,
  // The literal pre-fix call site: the regression this pins, not an invented violation.
  control: () => ({ src: 'applyCcacheArg(cmakeArgs, ccacheLauncher());\n' }),
});
guardTests(optOutWiringGuard);

// ---- the decision has to be LOGGED, unconditionally, at the call site ----------------
//
// The unit tests above pin the TEXT of the line. This pins that a build actually prints it:
// the exact defect being closed is a decision nobody could see in a CI log, so a
// describeCcacheDecision() that exists but is never called, or is called inside a branch,
// would leave the original hole open. Text-scanned for the same reason as the guard above.
//
// COLUMN ZERO IS THE TEST FOR "UNCONDITIONAL". scripts/build-tjs.cjs is a top-level script;
// anything nested in an `if`/`try`/function body is indented. An anchored ^ therefore
// distinguishes "printed on every build" from "printed on some builds" without parsing JS —
// and the control below is exactly the indented-inside-an-if version, so this is proven, not
// asserted.
//
// PURE: `src` is the already-read scripts/build-tjs.cjs text.
function scanDecisionLogged({ src }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/^const ccache = ccacheDecision\(/m.test(src)) {
    findings.push('scripts/build-tjs.cjs must compute the ccache decision ONCE at top level, '
      + 'so the decision that gets logged is the same object that reaches cmake');
  }

  examined++;
  if (!/^console\.error\(describeCcacheDecision\(ccache\)\);$/m.test(src)) {
    findings.push('scripts/build-tjs.cjs must log the ccache decision UNCONDITIONALLY at top '
      + 'level (an indented call is inside a branch, i.e. some builds would stay silent) — '
      + 'that silence is the defect: CI run 35468190935 could not say whether ccache had been '
      + 'driving MSVC, because nothing in the log mentioned it');
  }

  return { findings, examined };
}

const decisionLoggedGuard = defineGuard({
  name: 'ccache-decision-is-logged',
  read: () => ({ src: fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8') }),
  scan: scanDecisionLogged,
  floor: 2,
  // The plausible wrong version, not an invented one: log it only when it is interesting.
  // That is precisely how "ENABLED on the Windows leg" would go unreported again.
  control: () => ({ src: 'if (ccache.launcher) {\n  console.error(describeCcacheDecision(ccache));\n}\n' }),
});
guardTests(decisionLoggedGuard);

// ---- and the cmake CONFIGURE argv has to be logged too ------------------------------
//
// THE OTHER HALF OF THE SAME BLINDNESS, and the reason the ccache question could not be
// answered from CI at all: `grep -c -- '-DCMAKE' ` over the 2475 lines of run 35468190935
// returns 0. scripts/build-tjs.cjs assembles ~15 `-D` flags — the compiler, the toolchain
// file, the macOS floor, the reproducibility knobs — and then ran cmake without ever saying
// what it passed. One echoed line per configure (there are at most four in a build) is cheap
// and turns every future "which flags did that leg actually get?" into a grep instead of a
// re-derivation from source.
//
// PURE: `src` is the already-read scripts/build-tjs.cjs text.
function scanConfigureArgvLogged({ src }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/console\.error\(`build-tjs: cmake configure argv: /.test(src)) {
    findings.push('scripts/build-tjs.cjs must echo the cmake configure argv, or the flags that '
      + 'decide what a release leg builds stay invisible in its CI log');
  }

  examined++;
  if (/run\('cmake', \['-S'/.test(src)) {
    findings.push('a cmake CONFIGURE is going through run() directly instead of cmakeConfigure() '
      + '— that one is silent, and a silent configure is what hid the ccache launcher');
  }

  return { findings, examined };
}

const configureArgvGuard = defineGuard({
  name: 'cmake-configure-argv-is-logged',
  read: () => ({ src: fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8') }),
  scan: scanConfigureArgvLogged,
  floor: 2,
  // The literal pre-fix call: the exact line whose silence hid the launcher.
  control: () => ({ src: "run('cmake', ['-S', tjsDir, '-B', buildDir, ...cmakeArgs]);\n" }),
});
guardTests(configureArgvGuard);

// ---- the decline is only real if the CALL SITE tells the decision which compiler -------
//
// ccacheDecision() defaults `compiler` to '' (trusted), which is the right default for a
// caller that genuinely does not know -- and exactly the wrong thing to leave at the one
// call site that DOES know. A build-tjs.cjs that called ccacheDecision() with no argument
// would pass every unit test above and still enable ccache for cl on the windows-amd64
// publisher. Hence a guard, text-scanned (requiring that file runs an engine build).
//
// THE SECOND FACT IS ORDER, and it is the subtle one: `compilerFromCmakeArgs(cmakeArgs)`
// reads an array that build-tjs.cjs is still assembling, so it only sees
// `-DCMAKE_C_COMPILER=cl` if the compiler-selection block has already run. Move the ccache
// block one page up and the decline silently stops firing -- no error, no red test anywhere
// else, just a Windows publisher quietly back on a cache nobody has verified.
//
// PURE: `src` is the already-read scripts/build-tjs.cjs text.
function scanCompilerSignalWiring({ src }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/^const ccache = ccacheDecision\(\{ compiler: compilerFromCmakeArgs\(cmakeArgs\) \}\);$/m.test(src)) {
    findings.push('scripts/build-tjs.cjs must tell ccacheDecision() which compiler this build '
      + 'selected, or the untrusted-compiler decline never fires and ccache goes on launching '
      + 'cl.exe on the windows-amd64 hard publisher');
  }

  examined++;
  const compilerPush = src.indexOf("'-DCMAKE_C_COMPILER=cl'");
  const decision = src.indexOf('const ccache = ccacheDecision(');
  if (compilerPush === -1 || decision === -1 || compilerPush > decision) {
    findings.push('the ccache decision must come AFTER the compiler-selection push: '
      + 'compilerFromCmakeArgs() reads the cmakeArgs array as it stands at that moment, so a '
      + 'decision taken earlier sees no compiler and silently trusts it');
  }

  return { findings, examined };
}

const compilerSignalGuard = defineGuard({
  name: 'ccache-declines-untrusted-compiler',
  read: () => ({ src: fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8') }),
  scan: scanCompilerSignalWiring,
  floor: 2,
  // The exact pre-fix shape: the decision taken with no compiler at all, before the compiler
  // was even chosen. Violates both facts, which is why it models the real bug and not one of
  // them.
  control: () => ({ src: 'const ccache = ccacheDecision();\n'
    + "cmakeArgs.push('-G', 'Ninja', '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl');\n" }),
});
guardTests(compilerSignalGuard);

// The property at the grain it actually bites: a REAL cmake build dir, already configured
// WITH the launcher, reconfigured through the opt-out's own argument list. This is the test
// that was missing; a unit test over applyCcacheArg alone cannot see a CMakeCache.
test('opt-out: a build dir already configured WITH ccache stops using it after a reconfigure', (t) => {
  const cmake = findTool('cmake');
  if (!cmake) { t.skip('no cmake on PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccache-optout-cmake-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const src = path.join(dir, 'src');
  const bld = path.join(dir, 'b');
  fs.mkdirSync(src);
  // NONE: no compiler probe, so this stays fast and platform-independent. The variable is
  // a plain cache entry either way -- persistence is a cmake-cache property, not a
  // language-enablement one.
  fs.writeFileSync(path.join(src, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.10)\nproject(ccache_optout NONE)\n');
  const configure = (args) => {
    const r = spawnSync(cmake, ['-S', src, '-B', bld, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `cmake failed: ${r.stdout}\n${r.stderr}`);
  };
  const cached = () => {
    const line = fs.readFileSync(path.join(bld, 'CMakeCache.txt'), 'utf8').split('\n')
      .find((l) => l.startsWith('CMAKE_C_COMPILER_LAUNCHER:'));
    return line === undefined ? null : line.slice(line.indexOf('=') + 1);
  };

  // 1. the normal state of every build dir on a box with ccache: configured WITH it.
  configure(applyCcacheArg([], '/fake/bin/ccache', { clear: false }));
  assert.strictEqual(cached(), '/fake/bin/ccache', 'setup: the launcher should be cached here');

  // 2. now the user sets CLODE_TJS_CCACHE=0 and rebuilds. build-tjs.cjs reuses this build
  //    dir, so THIS is the argument list cmake gets.
  const optedOutArgs = applyCcacheArg([], ccacheLauncher({
    env: { CLODE_TJS_CCACHE: '0', PATH: process.env.PATH }, findToolFn: findTool,
  }), { clear: ccacheOptedOut({ CLODE_TJS_CCACHE: '0' }) });
  configure(optedOutArgs);
  assert.strictEqual(cached(), '',
    'CLODE_TJS_CCACHE=0 left the launcher in CMakeCache.txt -- the documented opt-out does '
    + 'nothing on a build dir that was already configured with ccache, which is every build '
    + 'dir on a box that has built once');
});

// ---- the present path, exercised through the injection seam, not a real install ----
//
// WHAT THIS PROVES: given a launcher path, the flag lands, with the right value, exactly
// once. WHAT THIS DOES NOT PROVE: that a REAL ccache binary at that path behaves as a
// correct cmake compiler launcher, or that its cache is keyed safely across a cross leg
// or the tjsc regen path — that is task 2's job, against a real install. This only
// proves scripts/build-tjs.cjs's OWN detect-and-push wiring is correct once something is
// found; the finding itself is faked here on purpose, since this box has nothing to find.

test('present: an injected launcher lands as -DCMAKE_C_COMPILER_LAUNCHER exactly once', () => {
  const fakeFindToolFn = (name) => (name === 'ccache' ? '/fake/bin/ccache' : null);
  const path = ccacheLauncher({ env: {}, findToolFn: fakeFindToolFn });
  assert.strictEqual(path, '/fake/bin/ccache');
  const out = applyCcacheArg([...BASE_ARGS], path);
  const hits = out.filter((a) => a === '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache');
  assert.strictEqual(hits.length, 1, `expected exactly one launcher flag, got: ${out.join(' ')}`);
  assert.deepStrictEqual(out, [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache']);
});

test('the injection seam is really being used: a name other than ccache resolves to nothing', () => {
  const fakeFindToolFn = (name) => (name === 'some-other-tool' ? '/fake/bin/other' : null);
  assert.strictEqual(ccacheLauncher({ env: {}, findToolFn: fakeFindToolFn }), null,
    'ccacheLauncher must ask findToolFn for "ccache" specifically, not accept anything found');
});

// ---- red proofs: each assertion above actually catches the broken version it exists ----
// ---- to catch, exercised against a deliberately wrong stand-in for the real function ----

test('PROOF: the absent-path assertion fails against a launcher that always pushes', () => {
  const alwaysPush = (cmakeArgs) => { cmakeArgs.push('-DCMAKE_C_COMPILER_LAUNCHER=/oops'); return cmakeArgs; };
  assert.throws(() => {
    assert.deepStrictEqual(alwaysPush([...BASE_ARGS]), BASE_ARGS);
  }, 'a broken always-push implementation must fail the byte-identical check, or that check is worthless');
});

test('PROOF: the opt-out assertion fails against a launcher that ignores CLODE_TJS_CCACHE=0', () => {
  const ignoresOptOut = ({ findToolFn }) => findToolFn('ccache');
  const fakeFindToolFn = () => '/fake/bin/ccache';
  assert.throws(() => {
    assert.strictEqual(ignoresOptOut({ env: { CLODE_TJS_CCACHE: '0' }, findToolFn: fakeFindToolFn }), null);
  }, 'an implementation that never reads CLODE_TJS_CCACHE must fail the opt-out check');
});

test('PROOF: the coverage assertion rejects a ccache that only saw SOME of the compile', () => {
  // The regression it models: a future change (a CXX TU, a per-target launcher, a toolchain
  // that drops the flag) routes 3 of 371 translation units through ccache. Every other
  // assertion in the e2e gate still passes; only this one notices.
  const compiledCObjects = new Array(371).fill('some/object.c.o');
  const partial = { hits: 0, calls: 3, misses: 3 };
  assert.throws(() => {
    assert.strictEqual(partial.calls, compiledCObjects.length);
  }, 'partial ccache coverage must fail the coverage check, or "371 identical objects" is '
    + 'a claim about a cache that barely ran');
});

test('PROOF: the warm-miss assertion rejects a rebuild that missed on anything at all', () => {
  const knownVolatile = [];            // what OBJECTS_EXPECTED_VOLATILE is now
  const warm = { hits: 370, calls: 371, misses: 1 };
  assert.throws(() => {
    assert.strictEqual(warm.misses, knownVolatile.length);
  }, 'a single unexplained miss on an unchanged rebuild must go red: `<=` would have let it '
    + 'through, and that is exactly how a different TU could have become the miss unnoticed');
});

test('PROOF: the present-path exactly-once assertion fails against a launcher pushed twice', () => {
  const pushesTwice = (cmakeArgs, path) => {
    if (path) { cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${path}`); cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${path}`); }
    return cmakeArgs;
  };
  const out = pushesTwice([...BASE_ARGS], '/fake/bin/ccache');
  const hits = out.filter((a) => a === '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache');
  assert.throws(() => {
    assert.strictEqual(hits.length, 1);
  }, 'a double-push must fail the exactly-once check');
});

// ============================================================================================
// Task 2 -- a REAL ccache, proving it does not lie (spec 4c3 acceptance 7's second half).
// Every test above this line exercises the launcher wiring through a synthetic findToolFn,
// because no real ccache existed on this box when task 1 shipped. It does now (installed via
// pkgsrc: `pkg_add ccache`, landing at /opt/pkg/bin/ccache, package ccache-4.13.6 -- see
// BACKLOG.md for the how/why this test does not repeat).
//
// THE STAKE: ccache keys its cache on the compiler invocation it can observe (compiler path,
// flags, preprocessed source). This project cross-builds 17 of its 42 legs from one host and
// regenerates bytecode through a SEPARATE host-native tjsc on that same box (phases 4c-2 /
// 4c-2b) -- a mis-keyed hit in either shape hands a build the WRONG object, silently, exit 0,
// shipped. A timing win that cannot also prove this did not happen is not worth having.
//
// THE DIFFERENTIAL IS THE AUDIT, not a one-time measurement: ccache's cache key is opaque from
// the outside -- unlike scripts/engine-recipe.mjs's hash, there is no second list to compare it
// against -- so the only way to know it stayed sound as sources and targets change is to keep
// re-deriving the answer by actually building. That is exactly what both of engine-recipe.mjs's
// own scars were missing: the cosmo patches absent from that recipe's key "cost 13 commits of
// red ... the recipe hash did not move, so nothing said the engine sources had changed", and the
// netbsd-sparc bake recipe where "an edit to it moved nothing, so the tjs cache happily restored
// an engine built by a DIFFERENT recipe." Both scars are a cache whose key silently stopped
// covering an input. This test is the standing gate against ccache doing the same thing --
// gated behind an opt-in (below) because it drives three real engine builds, not because the
// property it proves is optional.
//
// SCOPE, stated plainly so a green run here is never read as more than it is: this exercises
// the HOST leg alone, whatever platform `node --test` happens to run on. The 17 cross legs and
// the two Windows hard publishers are NOT proven by this file -- that is CI's job, on CI's own
// hosts, with CI's own compilers and CI's own object layout. A pass here says "ccache did not
// corrupt THIS host's native compile"; it says nothing about a cross toolchain's flags landing
// in a differently-shaped ccache key, which is precisely the mis-keying this whole task exists
// to rule out fleet-wide, not just on one box.
//
// THE FIRST THING THIS TEST HAD TO PROVE WAS ITS OWN INSTRUMENT -- found empirically, not
// assumed (the "instruments lie, check them first" discipline). The obvious design is: build
// the engine with the cache off, hash the linked binary; build again with the cache warm, hash
// it; compare. When this test first shipped that design was UNSATISFIABLE on this host,
// independently of ccache: two builds run back to back with CLODE_TJS_CCACHE=0 BOTH times --
// same vendor checkout, same outDir, same buildDir -- produced two DIFFERENT sha256 sums for
// the linked engine. So the correctness question this task owes an answer to (did ccache ever
// serve the WRONG bytes for a compilation it claims matched) was asked at the grain ccache
// actually operates on instead: one compiled object per translation unit.
//
// THAT WAS RIGHT, AND ITS STATED CAUSE WAS HALF WRONG. The original diagnosis named two
// causes: mimalloc's `__DATE__`/`__TIME__` build banner, and "a fresh LC_UUID Apple's linker
// assigns on every link". The second is FALSE -- ld64's LC_UUID is a content hash, not a
// per-link nonce (three links of one identical object produce one identical UUID; a relink to
// the same path after a wait is byte-identical). The differing UUIDs were a CONSEQUENCE of the
// differing mimalloc object, not an independent cause. There was exactly ONE cause, three bytes
// wide, and scripts/build-tjs.cjs's `fixupMimallocBuildBanner` now removes it
// (test/tjs-reproducible-engine.test.cjs owns that half of the story).
//
// SO BOTH CHECKS RUN NOW, AND THE OBJECT-GRAIN ONE STAYS. The whole-binary hash is the
// end-to-end acceptance the spec asked for; the per-object comparison is strictly stronger for
// the property ccache threatens, because it localises a divergence to a translation unit
// instead of saying "differs, somewhere". Neither replaces the other, and the object-grain
// check is the one that would still work if a future platform reintroduced link-time noise.
//
// OBJECTS_EXPECTED_VOLATILE IS NOW EMPTY, ON PURPOSE. The machinery around it is kept, not
// deleted: it is what makes a NEW volatile object fail loudly (it would land in `mismatches`
// with nothing excusing it) and what makes a STALE entry fail loudly too. An entry appearing
// here again would mean a second source file whose compiled bytes vary for reasons unrelated
// to caching -- which deserves its own investigation and its own fix, the way mimalloc's did,
// not a quiet allowlist reached for under time pressure.
const OBJECTS_EXPECTED_VOLATILE = [];

function why() {
  if (process.env.CLODE_CCACHE_ENGINE_E2E !== '1') {
    return 'opt-in: set CLODE_CCACHE_ENGINE_E2E=1 (three real engine builds, several minutes)';
  }
  if (process.platform === 'win32') {
    return 'host-only for now: the object-identity harness below has not been proven against '
      + "the MSVC leg's .obj layout or its generator -- see the file header's SCOPE note";
  }
  if (findTool('ccache') === null) {
    return 'no ccache on PATH -- install it (pkgsrc: `pkg_add ccache`) to exercise this gate';
  }
  const checkout = path.join(tjsVendorParentDir(process.env), 'txiki.js');
  if (!fs.existsSync(path.join(checkout, 'CMakeLists.txt'))) {
    return `no vendor checkout at ${checkout} -- run \`node scripts/build-tjs.cjs `
      + '--source-only` once first; this gate copies an existing checkout and will not clone '
      + '785MB inside a test run';
  }
  return null;
}

// A throwaway copy-on-write copy of an EXISTING vendor checkout, never the shared one --
// the same recipe test/tjs-bytecode-e2e.test.cjs and test/build-tjs-no-node.test.cjs already
// use, not a fresh design. build-tjs.cjs resets ITS OWN patched tree to pristine on every
// run, so mutating the shared ~/.cache/clode/tjs-vendor checkout with three back-to-back
// full builds would leave every OTHER build on this box patching from a tree this test
// disturbed mid-flight.
function copyCheckout(src, dest) {
  const attempts = process.platform === 'darwin'
    ? [['-Rc'], ['-R']]
    : [['-R', '--reflink=auto'], ['-R']];
  for (const flags of attempts) {
    if (spawnSync('cp', [...flags, src, dest]).status === 0) return dest;
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

// The one place this file names the SHIPPED build dir's shape: buildRoot is what this test
// hands build-tjs.cjs as its build-dir override, but the script nests the REAL cmake build
// dir one level down (a per-target hash it derives from outDir, so a shared tree never lets
// two targets collide -- see build-tjs.cjs's targetToken()). Rather than reimplement that
// hash here (a second copy of a naming scheme is exactly how the netbsd-sparc bake drifted),
// find the one CMakeCache.txt whose PARENT is literally named `build` -- the main engine
// target, never build-tjs.cjs's separate build-depscan tool dir alongside it.
function findBuildDir(buildRoot) {
  const found = spawnSync('find', [buildRoot, '-name', 'CMakeCache.txt'], { encoding: 'utf8' });
  assert.strictEqual(found.status, 0, `find over ${buildRoot} failed: ${found.stderr}`);
  const hits = found.stdout.split('\n').filter(Boolean)
    .filter((p) => path.basename(path.dirname(p)) === 'build');
  assert.strictEqual(hits.length, 1,
    `expected exactly one main-engine CMakeCache.txt under ${buildRoot}, found: `
    + `${JSON.stringify(hits)}`);
  return path.dirname(hits[0]);
}

// Every compiled translation unit under a build dir, repo-relative to IT (not to the repo),
// so the same relative name lines up across three independently rooted build dirs. Shells
// out to `find` rather than walking the tree in-process -- this project's C build produces a
// few hundred of these per phase, and a plain recursive listing is the same handful of bytes
// either way.
//
// `*.o`, NOT `*.c.o` (review finding, 2026-09-19). The engine build emits exactly one object
// that is not a C TU -- WAMR's invokeNative_aarch64_simd.s.o -- and the old glob left it
// uncompared. It is not routed through ccache today (CMAKE_C_COMPILER_LAUNCHER is C-only;
// ASM would need CMAKE_ASM_COMPILER_LAUNCHER, which is deliberately NOT wired: one hand-
// written assembly TU compiles in milliseconds, and a second cache-key surface for that is
// all risk and no win). But "ccache cannot touch it" is a reason to keep it OUT of the
// cacheable-call accounting, not a reason to stop checking that it comes out the same --
// it is an input to the very link whose whole-binary hash is now asserted below.
function listObjects(buildDir) {
  const found = spawnSync('find', [buildDir, '-name', '*.o'], { encoding: 'utf8' });
  assert.strictEqual(found.status, 0, `find over ${buildDir} failed: ${found.stderr}`);
  return found.stdout.split('\n').filter(Boolean)
    .map((abs) => path.relative(buildDir, abs).split(path.sep).join('/'))
    .sort();
}

// Streamed, not loaded whole -- these objects are small, but the habit is the point: this
// file never pulls a build artifact into memory in one shot.
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Copies everything THIS phase's identity check and diagnostics need out of the shared
// buildRoot/outDir before the next phase wipes and overwrites both -- the reason this exists
// at all is that outDir and buildRoot are deliberately the SAME path across all three phases
// (see the test body for why), so nothing about them survives past the next runPhase() call
// unless it is copied out first.
function snapshotPhase(label, buildDir, outBin, snapshotsRoot) {
  const objDir = path.join(snapshotsRoot, label, 'objs');
  fs.mkdirSync(objDir, { recursive: true });
  const objects = listObjects(buildDir);
  for (const rel of objects) {
    const dest = path.join(objDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(buildDir, rel), dest);
  }
  const enginePath = path.join(snapshotsRoot, label, 'tjs');
  fs.copyFileSync(outBin, enginePath);
  return { label, objects, objDir, enginePath };
}

function parseCcacheStats(text) {
  const hits = text.match(/^\s*Hits:\s*(\d+)\s*\/\s*(\d+)/m);
  const misses = text.match(/^\s*Misses:\s*(\d+)\s*\/\s*(\d+)/m);
  assert.ok(hits && misses, `could not parse ccache --show-stats output:\n${text}`);
  return { hits: Number(hits[1]), calls: Number(hits[2]), misses: Number(misses[1]) };
}

test('a real, warm ccache serves byte-identical objects for a full engine build (host leg only)', async (t) => {
  const skip = why();
  if (skip) { t.skip(skip); return; }
  const ccachePath = findTool('ccache');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccache-engine-e2e-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const vendorParent = path.join(dir, 'vendor');
  fs.mkdirSync(vendorParent, { recursive: true });
  copyCheckout(path.join(tjsVendorParentDir(process.env), 'txiki.js'), path.join(vendorParent, 'txiki.js'));

  // outDir and buildRoot are FIXED across all three phases -- deliberately, not an oversight.
  // Two builds into two DIFFERENT outDir paths embed that path's own string into their
  // objects (this project's C sources use __FILE__-style absolute paths in a few places),
  // which would show up as a "difference" that is really just two builds disagreeing about
  // where they were told to live. Holding both paths constant and wiping buildRoot between
  // phases (below) isolates the one variable this test is actually about: whether the cache
  // was on, and whether it was warm.
  const outDir = path.join(dir, 'out');
  const buildRoot = path.join(dir, 'build-root');
  const ccacheDir = path.join(dir, 'ccache-dir');
  const snapshotsRoot = path.join(dir, 'snapshots');
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: vendorParent,
    CLODE_TJS_OUT: outDir,
    CLODE_TJS_BUILD: buildRoot,
  };
  const BUILD_TIMEOUT_MS = 6 * 60 * 1000;

  const runPhase = (label, extraEnv) => {
    fs.rmSync(buildRoot, { recursive: true, force: true });
    const startedAt = Date.now();
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts/build-tjs.cjs')],
      { cwd: repo, env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS });
    const wallMs = Date.now() - startedAt;
    assert.strictEqual(r.status, 0, `${label} engine build failed:\n${r.stdout}\n${r.stderr}`);
    // Status alone is not enough (build-tjs.cjs's own header explains why: under tjs an
    // unhandled rejection can be swallowed outright). This runs under real Node, not the
    // shim, but the marker check is free and it is the same discipline
    // test/build-tjs-no-node.test.cjs already applies for the same reason.
    assert.match(r.stdout, /\(tjs-shim-ok\)/,
      `${label} build exited 0 without its success marker:\n${r.stdout}`);
    const buildDir = findBuildDir(buildRoot);
    const snap = snapshotPhase(label, buildDir, path.join(outDir, 'tjs'), snapshotsRoot);
    return { label, wallMs, ...snap };
  };

  // PHASE 1: no launcher at all -- today's behavior on every leg that has never heard of
  // ccache, and the reference every other phase below is judged against.
  const off = runPhase('off', { CLODE_TJS_CCACHE: '0' });

  // PHASE 2: the launcher wired, cache EMPTY -- every cacheable call must miss.
  fs.rmSync(ccacheDir, { recursive: true, force: true });
  fs.mkdirSync(ccacheDir, { recursive: true });
  spawnSync(ccachePath, ['--zero-stats'], { env: { ...baseEnv, CCACHE_DIR: ccacheDir } });
  const onCold = runPhase('on-cold', { CCACHE_DIR: ccacheDir });
  const statsCold = spawnSync(ccachePath, ['--show-stats', '-v'],
    { env: { ...baseEnv, CCACHE_DIR: ccacheDir }, encoding: 'utf8' }).stdout;

  // PHASE 3: the SAME cache, now warm -- an unchanged rebuild, the literal acceptance.
  // Zeroed again: ccache's stats are CUMULATIVE across invocations sharing a CCACHE_DIR, so
  // without this the warm phase's own numbers would be buried under phase 2's 371 misses
  // (caught exactly this way, not hypothesized -- the first run of this test reported "742
  // cacheable calls" and 372 misses before this line existed).
  spawnSync(ccachePath, ['--zero-stats'], { env: { ...baseEnv, CCACHE_DIR: ccacheDir } });
  const onWarm = runPhase('on-warm', { CCACHE_DIR: ccacheDir });
  const statsWarm = spawnSync(ccachePath, ['--show-stats', '-v'],
    { env: { ...baseEnv, CCACHE_DIR: ccacheDir }, encoding: 'utf8' }).stdout;

  // THE HEADLINE ASSERTION. Same set of objects compiled every time, or something about the
  // build graph itself changed between phases and nothing below this line means anything.
  assert.deepStrictEqual(onCold.objects, off.objects,
    'ccache ON compiled a DIFFERENT set of objects than ccache OFF');
  assert.deepStrictEqual(onWarm.objects, off.objects,
    'the warm rebuild compiled a DIFFERENT set of objects than the cold one');

  const expectedVolatile = new Map(OBJECTS_EXPECTED_VOLATILE.map((e) => [e.rel, e.because]));
  const volatileSeen = new Set();
  const mismatches = [];
  for (const rel of off.objects) {
    const [hOff, hCold, hWarm] = await Promise.all([
      sha256Of(path.join(off.objDir, rel)),
      sha256Of(path.join(onCold.objDir, rel)),
      sha256Of(path.join(onWarm.objDir, rel)),
    ]);
    if (hOff === hCold && hOff === hWarm) continue;
    if (expectedVolatile.has(rel)) { volatileSeen.add(rel); continue; }
    mismatches.push(`${rel}: off=${hOff.slice(0, 12)} on-cold=${hCold.slice(0, 12)} `
      + `on-warm=${hWarm.slice(0, 12)}`);
  }

  // THE ACCEPTANCE: every object ccache could have mis-served came out byte-identical to a
  // cache-off compile, whether ccache had never seen it before (on-cold) or was serving it
  // straight from cache (on-warm). This is a stronger, more precise claim than a whole-binary
  // hash comparison would have been -- see the file header for why that instrument was wrong
  // on this host, proven and not assumed.
  assert.deepStrictEqual(mismatches, [],
    `ccache served DIFFERENT bytes than a cache-off compile for ${mismatches.length} object(s) `
    + '-- this is the exact failure this task exists to catch, and it outranks any speedup:\n'
    + mismatches.join('\n'));

  // The exclusion's other half: a documented exception that stops matching reality is itself
  // a bug (the same discipline test/guards-population.cjs's own GUARD_EXCLUSIONS enforces for
  // its own list) -- if mimalloc's banner ever became reproducible, or a different object
  // started exhibiting the same symptom, this loop is what would say so instead of the
  // exclusion quietly covering for the wrong file.
  for (const rel of expectedVolatile.keys()) {
    assert.ok(volatileSeen.has(rel),
      `${rel} is listed in OBJECTS_EXPECTED_VOLATILE (${expectedVolatile.get(rel)}) but all `
      + 'three phases produced IDENTICAL bytes for it this run -- the exclusion is stale: '
      + 'remove it, or find the new source of nondeterminism if a DIFFERENT object needs it '
      + 'instead');
  }

  // THE OTHER HALF OF THE ACCEPTANCE: the hit rate, with absolute numbers, not just a
  // percentage (BACKLOG.md is where these get recorded for the record; this assertion is
  // what keeps that record honest on every future run).
  const cold = parseCcacheStats(statsCold);
  const warm = parseCcacheStats(statsWarm);
  assert.strictEqual(cold.hits, 0,
    `an EMPTY cache reported a hit -- something primed it before this run:\n${statsCold}`);

  // COVERAGE, not just correctness (review finding, 2026-09-19). Without this, PARTIAL
  // coverage is indistinguishable from full: if a future change routed only 3 of the 371
  // TUs through ccache, `cold.hits === 0` and the miss cap below would both still pass, and
  // the byte-identity result above would be true of a cache that had barely been consulted.
  // The identity that actually holds today is `cacheable calls == compiled C objects`, so
  // that is what is asserted. (Total zero coverage already fails, by luck, in
  // parseCcacheStats -- with no calls at all ccache emits no `Hits: n / m` line to parse.)
  const cObjects = off.objects.filter((rel) => rel.endsWith('.c.o'));
  assert.strictEqual(cold.calls, cObjects.length,
    `ccache saw ${cold.calls} cacheable call(s) but the build compiled ${cObjects.length} C `
    + `object(s) (of ${off.objects.length} objects total) -- the launcher is only covering `
    + `PART of the compile, so the byte-identity result above is a weaker claim than it looks`
    + `:\n${statsCold}`);

  // THE WARM MISS, ASSERTED DIRECTLY rather than inferred. This used to be `<=` the length
  // of an exclusion list with one entry in it, and the claim that the one miss WAS
  // options.c.o was an inference from `Writes: 1` plus a byte diff -- some other TU could
  // have become the miss while options.c.o started hitting, and nothing would have said so.
  // With the banner fixed the list is EMPTY, so the honest form is exact equality with zero:
  // an unchanged rebuild of this engine must hit the cache for every single call.
  assert.strictEqual(warm.misses, OBJECTS_EXPECTED_VOLATILE.length,
    `a fully warm, unchanged rebuild missed ${warm.misses} time(s); expected exactly `
    + `${OBJECTS_EXPECTED_VOLATILE.length} (the number of objects listed as known-volatile, `
    + 'which is now none -- see OBJECTS_EXPECTED_VOLATILE). A miss means some translation '
    + 'unit is still not reproducible, or ccache is keying on something that moved between '
    + `two identical builds:\n${statsWarm}`);
  assert.strictEqual(warm.hits, warm.calls,
    `a fully warm rebuild should hit on every cacheable call:\n${statsWarm}`);

  const [hOffBin, hColdBin, hWarmBin] = await Promise.all(
    [off, onCold, onWarm].map((p) => sha256Of(p.enginePath)));
  console.log(`ccache-engine-e2e: wall clock off=${off.wallMs}ms on-cold=${onCold.wallMs}ms `
    + `on-warm=${onWarm.wallMs}ms`);
  console.log(`ccache-engine-e2e: cold cache stats -- ${cold.hits}/${cold.calls} hits`);
  console.log(`ccache-engine-e2e: warm cache stats -- ${warm.hits}/${warm.calls} hits, `
    + `${warm.misses} miss(es)`);
  console.log(`ccache-engine-e2e: linked engine sha256 off=${hOffBin.slice(0, 12)} `
    + `on-cold=${hColdBin.slice(0, 12)} on-warm=${hWarmBin.slice(0, 12)}`);

  // THE WHOLE-BINARY ACCEPTANCE, as the spec originally worded it: "hash the engine with the
  // cache off, hash it with the cache warm, they must match". It was unsatisfiable until the
  // mimalloc banner was neutralised; it is satisfiable now, so it is asserted rather than
  // logged -- BESIDE the object-grain check above, never instead of it.
  //
  // NOT GATED ON PLATFORM. Both causes that had to be removed to make this assertable are
  // platform-NEUTRAL -- mimalloc's banner is compiled on every leg, and archive timestamps
  // are an `ar` property, not a darwin one -- so the fixes are unconditional and the check
  // is too. It has been OBSERVED to hold on darwin/arm64 only, because that is the only host
  // this gate has ever been run on (it is opt-in, and runs on whatever box a developer runs
  // it on). On any other platform this assertion is a QUESTION being asked for the first
  // time: a red here is a finding about that leg, not a flake, and the message says so
  // rather than pretending a pass was observed.
  assert.ok(hOffBin === hColdBin && hOffBin === hWarmBin,
    `three builds of identical sources produced DIFFERENT linked engines on ${process.platform}`
    + ` (off=${hOffBin} on-cold=${hColdBin} on-warm=${hWarmBin}). Every compiled object`
    + ' matched, so the divergence entered at or after the LINK. Two causes are already known'
    + ' and neutralised (mimalloc\'s __DATE__/__TIME__ banner via fixupMimallocBuildBanner,'
    + ' and static-archive member mtimes via ZERO_AR_DATE); this is a THIRD. Likely suspects'
    + ' on a leg other than darwin/arm64, where this has been proven: absolute build paths'
    + ' baked into the binary (-ffile-prefix-map), a PE TimeDateStamp on the Windows legs'
    + ' (/Brepro), or an archiver that ignores ZERO_AR_DATE (GNU ar wants -D). Find it and'
    + ' fix it the same way -- do not demote this back to a diagnostic');
});
