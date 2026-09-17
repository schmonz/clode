'use strict';
// Source-text + logic tests for build hermeticity (scripts/build-tjs.mjs):
// cmake must not resolve vendored deps through a third-party package-manager
// prefix (pkgsrc/Homebrew/MacPorts/Fink), and the built engine's dynamic
// deps must not land in one either. These run UNCONDITIONALLY, no build tree
// required — see .github/workflows/ci.yml:341 ("a skipped oracle is not a
// pass"). The house pattern (test/win-shim-guards.test.cjs, test/win-sync-
// guards.test.cjs) is grepping the real source so the test tracks the actual
// shipped behavior, not a reimplementation of it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stripLineComments } = require('./source-scan.cjs');

const repo = path.join(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.mjs'), 'utf8');
// PKG_MANAGER_ROOTS and the verdict functions moved to scripts/depscan-verdict.cjs
// (phase 4b) so the build and this suite run the SAME logic. The array literal
// tests below read it THERE now, and assert build-tjs.mjs no longer keeps a
// second copy — the drift that broke native NetBSD is what made it one list.
const verdictSrc = fs.readFileSync(path.join(repo, 'scripts/depscan-verdict.cjs'), 'utf8');

// ---- HALF 1: CMAKE_IGNORE_PREFIX_PATH, native builds only -----------------

test('build-tjs: pushes CMAKE_IGNORE_PREFIX_PATH with every package-manager prefix', () => {
  assert.match(buildTjsSrc, /CMAKE_IGNORE_PREFIX_PATH/);
  // Anchored to the actual PKG_MANAGER_ROOTS array literal (same pattern as
  // the denylist test below), NOT "appears anywhere in the file" — a naive
  // whole-file search passes even if the array itself is emptied, because
  // the explanatory comments list all the prefixes in prose. See PROOF below.
  // The literal lives in scripts/depscan-verdict.cjs as of phase 4b.
  const constStart = verdictSrc.indexOf('const PKG_MANAGER_ROOTS = [');
  assert.ok(constStart > -1, 'const PKG_MANAGER_ROOTS = [...] not found in scripts/depscan-verdict.cjs');
  const constEnd = verdictSrc.indexOf('\n', constStart);
  const constLine = verdictSrc.slice(constStart, constEnd);
  for (const prefix of ['/opt/pkg', '/opt/homebrew', '/usr/local', '/opt/local', '/sw', '/usr/pkg']) {
    assert.ok(constLine.includes(`'${prefix}'`),
      `expected ${prefix} in the PKG_MANAGER_ROOTS array literal, got: ${constLine}`);
  }
  // Also confirm the cmake push uses THIS constant (single source of truth
  // for both the cmake ignore-list and the post-build denylist below) —
  // not a second, independently-hand-copied list that could silently drift
  // (this is exactly how /usr/pkg went missing from the cmake half while
  // staying present in the dependency-check half, breaking native NetBSD).
  assert.match(buildTjsSrc, /cmakeArgs\.push\(`-DCMAKE_IGNORE_PREFIX_PATH=\$\{PKG_MANAGER_ROOTS\.join/,
    'the CMAKE_IGNORE_PREFIX_PATH push must read PKG_MANAGER_ROOTS, not a separate hardcoded list');
  // ...and that it gets that constant by IMPORT, with no second copy of its own.
  assert.match(buildTjsSrc, /\{[^}]*PKG_MANAGER_ROOTS[^}]*\}\s*=\s*require\(['"]\.\/depscan-verdict\.cjs['"]\)/,
    'build-tjs.mjs must import PKG_MANAGER_ROOTS from scripts/depscan-verdict.cjs');
  assert.doesNotMatch(buildTjsSrc, /const PKG_MANAGER_ROOTS = \[/,
    'build-tjs.mjs must import the roots, not redefine them — one definition, or the cmake '
    + 'ignore-list and the denylist drift apart again');
});

// PROOF that the test above is not a tautology: run it against a
// depscan-verdict.cjs text with PKG_MANAGER_ROOTS emptied to `[]`. If this
// fails to fail, the test above is worthless (it would also pass with the real
// protection deleted). See task-14-report.md for the actual node output of this
// block.
test('build-tjs: PROOF — the prefix-list test above actually fails against an emptied constant', () => {
  const emptied = verdictSrc.replace(
    /const PKG_MANAGER_ROOTS = \[[^\]]*\];/,
    'const PKG_MANAGER_ROOTS = [];',
  );
  assert.notStrictEqual(emptied, verdictSrc, 'the emptying replace must actually match something');
  const constStart = emptied.indexOf('const PKG_MANAGER_ROOTS = [');
  const constEnd = emptied.indexOf('\n', constStart);
  const constLine = emptied.slice(constStart, constEnd);
  let caught = null;
  try {
    for (const prefix of ['/opt/pkg', '/opt/homebrew', '/usr/local', '/opt/local', '/sw', '/usr/pkg']) {
      assert.ok(constLine.includes(`'${prefix}'`),
        `expected ${prefix} in the PKG_MANAGER_ROOTS array literal, got: ${constLine}`);
    }
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'the tightened assertion must throw when PKG_MANAGER_ROOTS is emptied — if it did not, it is a tautology again');
});

test('build-tjs: CMAKE_IGNORE_PREFIX_PATH is gated on !crossFile (native only)', () => {
  // The push must be inside an `if (!crossFile)` (or equivalent) so a cross
  // toolchain file — which already owns CMAKE_FIND_ROOT_PATH_MODE_* — is not
  // fought by a host-side ignore-list stacked on top of it.
  // Find the actual cmakeArgs.push(...) call (not just the first mention of
  // the flag's name, which also appears earlier in the explanatory comment).
  const idx = buildTjsSrc.indexOf('cmakeArgs.push(`-DCMAKE_IGNORE_PREFIX_PATH');
  assert.ok(idx > -1, 'cmakeArgs.push(...CMAKE_IGNORE_PREFIX_PATH...) not found');
  const before = buildTjsSrc.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /if\s*\(\s*!crossFile\s*\)/,
    'CMAKE_IGNORE_PREFIX_PATH push must be guarded by !crossFile');
});

test('build-tjs: an old cmake (<3.23) does not silently skip the protection — it warns loudly', () => {
  // CMAKE_IGNORE_PREFIX_PATH requires cmake >= 3.23. The spec is explicit:
  // do not silently omit the protection on an old cmake — say so.
  assert.match(buildTjsSrc, /3\.23/);
  assert.match(buildTjsSrc, /predates|too old|unavailable/i);
});

// Behavioral: extract the ACTUAL cmakeVersionSupportsIgnorePrefixPath(major,
// minor) function out of build-tjs.mjs (brace-balanced, via extractFunction
// below — the same machinery already used for checkHermeticDeps)
// and run it directly, rather than hand-copying the comparison into the
// test. A hand copy tracks nothing: flipping `>= 23` to `< 23` (or `>` to
// `>=` on the major-version branch) in build-tjs.mjs would leave a
// hand-copied `gate` here green forever. This is defined as its own
// function declaration (not inline in the `if`) in build-tjs.mjs
// specifically so it can be extracted and exercised here.
test('build-tjs: version-gate arithmetic accepts 3.23+, rejects older', () => {
  const src = extractFunction(buildTjsSrc, 'cmakeVersionSupportsIgnorePrefixPath');
  // eslint-disable-next-line no-new-func
  const gate = new Function(`${src}\nreturn cmakeVersionSupportsIgnorePrefixPath;`)();
  assert.strictEqual(gate(3, 23), true);
  assert.strictEqual(gate(4, 0), true);
  assert.strictEqual(gate(3, 22), false);
  assert.strictEqual(gate(2, 8), false);
});

// ---- HALF 2: post-build dependency check -----------------------------------

// The shipped checkHermeticDeps, as text. It is the LAST function in
// build-tjs.mjs, so the terminator is the comment block that follows it.
function hermeticFnSrc() {
  const fnStart = buildTjsSrc.indexOf('function checkHermeticDeps');
  assert.ok(fnStart > -1, 'function checkHermeticDeps not found in build-tjs.mjs');
  const fnEnd = buildTjsSrc.indexOf('\n// CLODE_TJS_SMOKE=off', fnStart);
  assert.ok(fnEnd > -1, 'the CLODE_TJS_SMOKE comment that terminates checkHermeticDeps moved');
  return buildTjsSrc.slice(fnStart, fnEnd);
}

test('build-tjs: hermeticity dependency check exists and is invoked after the build', () => {
  assert.match(buildTjsSrc, /function checkHermeticDeps/);
  assert.match(buildTjsSrc, /checkHermeticDeps\(path\.join\(outDir, outName\)\)/);
});

test('build-tjs: the dependency check reads the binary via depscan, not via otool/ldd', () => {
  // Phase 4b. otool/ldd could only inspect a binary built FOR this machine,
  // which is why 19 of 42 release legs skipped this check entirely. depscan
  // parses the ELF/Mach-O/PE dependency table out of the file, so the build
  // host stops mattering. Assert the WIRING (build it, run it, parse it,
  // judge it) rather than the words, so a half-wired version cannot pass.
  assert.match(buildTjsSrc, /import \{ buildDepscan \} from '\.\/build-depscan\.mjs';/);
  const fnSrc = hermeticFnSrc();
  assert.match(fnSrc, /buildDepscan\(/, 'the check must build the host-native verifier');
  assert.match(fnSrc, /runOut\(depscan, \[enginePath\]\)/, 'the check must run depscan on the engine');
  assert.match(fnSrc, /parseDepscan\(/, 'the check must parse depscan output through the shared parser');
  assert.match(fnSrc, /hermeticityFindings\(parsed, PKG_MANAGER_ROOTS\)/,
    'the verdict must come from the SAME function the suite exercises, on the SAME roots');
  // The tools they replaced are gone from the check, root and branch. Comments
  // stripped first: the function's own explanation of WHY otool/ldd had to go
  // names them, and a whole-text match cannot tell that from a live call.
  assert.doesNotMatch(stripLineComments(fnSrc), /otool|\bldd\b/,
    'the check must not invoke otool or ldd any more');
  assert.doesNotMatch(buildTjsSrc, /function parseOtoolDeps|function parseLddDeps/,
    'the text-scraping parsers are deleted; depscan reads the file instead');
});

test('build-tjs: the ONLY remaining hermeticity skip is static-by-construction', () => {
  // Phase 4b. This test used to assert `skipCount >= 3` — cross-built,
  // Windows, and missing-tool. Those three were not verdicts; they were the
  // absence of one, on 19 of 42 release legs (15 published). depscan reads the
  // dependency table out of the file, so the host that built it no longer
  // matters and none of the three has a reason to exist.
  const fnSrc = hermeticFnSrc();
  assert.doesNotMatch(fnSrc, /crossFile/,
    'a cross-built engine must get a real verdict now, not a skip');
  assert.doesNotMatch(fnSrc, /win32/,
    'Windows must get a real verdict now, not a skip');
  assert.match(fnSrc, /wantStatic/,
    'the static-link skip is correct by construction and must stay');
  // Exactly one early return, and it is the static one.
  const returns = (fnSrc.match(/^\s*return;/gm) || []).length;
  assert.strictEqual(returns, 1, `expected exactly one early return (static), found ${returns}`);
  const staticIdx = fnSrc.indexOf('wantStatic');
  const returnIdx = fnSrc.search(/^\s*return;/m);
  assert.ok(staticIdx > -1 && staticIdx < returnIdx,
    'the one early return must be the one guarded by wantStatic');
  // And an unreadable engine must THROW, not skip.
  assert.match(fnSrc, /depscan could not read/);
  assert.doesNotMatch(fnSrc, /SKIPPED/,
    'no SKIPPED notice should remain — the one surviving skip reports OK with a reason');
});

test('build-tjs: dependency check FAILS loudly (throws) naming the library and prefix on a hit', () => {
  const fnSrc = hermeticFnSrc();
  assert.match(fnSrc, /throw new Error/);
  assert.match(fnSrc, /CMAKE_IGNORE_PREFIX_PATH/); // points back at the fix
});

// ---- DENYLIST regression guard ---------------------------------------------
//
// This is the load-bearing test in this file. A previous attempt at this
// check used an ALLOWLIST of system prefixes (['/lib/', '/usr/lib/']) and was
// broken two ways:
//   - glibc's ldd emits `/lib64/ld-linux-x86-64.so.2`; that path does NOT
//     start with '/lib/' (it's /lib64, a sibling, not a child), so a good
//     dependency was flagged — would have failed native linux-x64-glibc.
//   - BSD ldd (FreeBSD/NetBSD/DragonFly) print the INSPECTED BINARY'S OWN
//     PATH as a header line first; a naive line-matcher captured that too —
//     would have failed freebsd-amd64/netbsd-amd64/dragonflybsd-amd64,
//     all publish:true legs. That SECOND failure mode is now structurally
//     impossible rather than merely tested: depscan reads the file, so there
//     is no tool output with a header line in it to mistake for a dependency.
//     The first one is live logic and is still exercised, in
//     test/depscan-guard.test.cjs ("does NOT flag /usr/lib or a bare SONAME",
//     which includes /lib64/ld-linux-x86-64.so.2 explicitly).
// DO NOT "simplify" this back into an allowlist — that regresses the first.
test('build-tjs: dependency check uses a DENYLIST of package-manager roots, not an allowlist', () => {
  assert.match(buildTjsSrc, /PKG_MANAGER_ROOTS/);
  // Regression guard for the actual broken shape (not just the word
  // "allowlist", which legitimately appears in the explanatory prose
  // describing the bug it avoids): the matcher must walk the package-manager
  // denylist (`p === root || p.startsWith(root + '/')`), never a bare
  // hardcoded system-prefix test.
  assert.match(verdictSrc, /function underRoot[\s\S]{0,200}p\.startsWith/);
  assert.match(verdictSrc, /roots\.find\(\(r\) => underRoot\(dep, r\)\)/);
  for (const root of ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local']) {
    assert.match(verdictSrc, new RegExp(`PKG_MANAGER_ROOTS[\\s\\S]{0,200}${root.replace(/\//g, '\\/')}`),
      `expected ${root} in PKG_MANAGER_ROOTS`);
  }
});

// ---- the shipped checkHermeticDeps, run for real ---------------------------
// (extracted verbatim from the source, with its free variables injected, so
// the regression guard tracks the actual shipped function rather than a hand
// copy of its logic)

// Brace-balanced extraction (a plain non-greedy regex breaks the moment the
// function body contains its own `}`, e.g. inside `.reduce(...)`).
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.mjs`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Load the REAL checkHermeticDeps (brace-balanced extraction) with its free
// variables supplied as injectable stubs, so a wrong verdict (the MINOR-4 /
// MINOR-5 shape: SKIPPED-vs-OK, or a skip where a throw belongs) is caught by
// actually running the shipped function, not by re-describing its logic.
//
// The verdict functions are NOT stubbed: parseDepscan and hermeticityFindings
// are required from scripts/depscan-verdict.cjs — the same module the build
// imports — so this harness exercises the real decision on real-shaped output.
// `fs` IS INJECTED, and must stay injected. checkHermeticDeps appends its
// per-leg verdict to $GITHUB_STEP_SUMMARY with fs.appendFileSync, and that
// variable is set in EVERY GitHub Actions step -- so without fs here the
// harness raised "ReferenceError: fs is not defined" from inside the shipped
// function on CI while passing on a developer's machine, where the variable is
// unset. A harness that can only exercise the code path nobody runs it on is
// the same "gate that cannot fail" this phase exists to abolish. Found while
// wiring the failure-path summary line (reviewer Minor 13, 2026-09-17).
function loadCheckHermeticDeps({ wantStatic, depscanOut, logs, onBuildDepscan }) {
  const verdict = require(path.join(repo, 'scripts/depscan-verdict.cjs'));
  const consoleStub = {
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };
  const buildDepscanStub = () => {
    if (onBuildDepscan) onBuildDepscan();
    return '/stub/depscan';
  };
  const runOutStub = () => {
    if (typeof depscanOut === 'function') return depscanOut();
    return depscanOut;
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'wantStatic', 'console', 'buildDepscan', 'repo', 'path', 'fs', 'buildRoot',
    'targetToken', 'outDir', 'run', 'jobs', 'runOut',
    'parseDepscan', 'hermeticityFindings', 'PKG_MANAGER_ROOTS',
    `${extractFunction(buildTjsSrc, 'checkHermeticDeps')}\nreturn checkHermeticDeps;`,
  );
  const check = factory(
    wantStatic, consoleStub, buildDepscanStub, '/repo', path, fs, '/buildroot',
    () => 'target-token', '/out', () => {}, '1', runOutStub,
    verdict.parseDepscan, verdict.hermeticityFindings, verdict.PKG_MANAGER_ROOTS,
  );
  // EVERY invocation writes its job-summary line into a temp file belonging to
  // this harness, never the ambient $GITHUB_STEP_SUMMARY -- which, in a GitHub
  // Actions job, is set. Without the redirect these tests appended four
  // fabricated verdicts to the REAL job summary of every CI run ("- `bin` —
  // FAILED — depscan output has an unrecognized line...", from a fixture): a
  // phase whose entire subject is honest per-leg verdicts, publishing invented
  // ones. Read the file back with check.summary().
  const summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clode-summary-')), 'summary.md');
  const wrapped = (enginePath) => {
    const prev = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    try {
      return check(enginePath);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = prev;
    }
  };
  wrapped.summary = () => (fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '');
  return wrapped;
}

// ---- MINOR 4, phase-4b form: unverifiable must not read as OK — and now ----
// ---- must not read as SKIPPED either. It THROWS. --------------------------
test('checkHermeticDeps: depscan output the parser does not recognize THROWS, never OK or SKIPPED', () => {
  // The pre-depscan defect this inherits: OpenBSD's ldd prints a "Start End
  // Type Open Ref GrpRef Name" table that parseLddDeps recognized no line of,
  // so it returned [] — "could not read it" arriving as "found none" on two
  // publish:true legs. depscan's protocol closes that by construction (a
  // group is complete only when a deps= line terminates it), and the build
  // now treats an incomplete scan as a build failure rather than a notice.
  const logs = [];
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: '        Start    End      Type  Open Ref GrpRef Name\n'
      + '00000000c1e0f000 00000000c1e2f000 exe   1    0   0    /usr/local/bin/tjs\n',
    logs,
  });
  assert.throws(() => check('/usr/local/bin/tjs'), /unrecognized line/);
  const joined = logs.join('\n');
  assert.doesNotMatch(joined, /OK —/);
  assert.doesNotMatch(joined, /SKIPPED/);
});

test('checkHermeticDeps: a depscan that cannot read the engine THROWS, naming the engine', () => {
  // Not knowing what a binary links is the unverified-looks-verified state
  // this check exists to prevent; a skip here would rebuild it.
  const logs = [];
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: () => { throw new Error('depscan: unrecognized container'); },
    logs,
  });
  assert.throws(() => check('/build/tjs/netbsd-m68k/tjs'),
    /hermeticity check FAILED: depscan could not read \/build\/tjs\/netbsd-m68k\/tjs/);
  assert.doesNotMatch(logs.join('\n'), /SKIPPED/);
});

// ---- MINOR 5: static builds must short-circuit BEFORE the verifier, with --
// ---- an accurate message, not fall into a "tool unavailable" catch -------
test('checkHermeticDeps: a static build reports "static link" and never builds depscan', () => {
  const logs = [];
  let builtDepscan = false;
  const check = loadCheckHermeticDeps({
    wantStatic: true,
    depscanOut: () => { throw new Error('runOut must not be reached for a static build'); },
    logs,
    onBuildDepscan: () => { builtDepscan = true; },
  });
  assert.doesNotThrow(() => check('/build/tjs-musl/tjs'));
  assert.strictEqual(builtDepscan, false, 'a static build must not build or run the verifier at all');
  const joined = logs.join('\n');
  console.log('static-build harness log:', joined);
  assert.match(joined, /static link/);
  assert.doesNotMatch(joined, /unavailable or failed to run/,
    'static builds must not print a misleading "tool unavailable" catch message');
});

// ---- the skips that are GONE, proven by running the function --------------

test('checkHermeticDeps: a foreign-arch (cross-built) engine gets a real VERDICT, not a skip', () => {
  // depscan output for a big-endian 32-bit ELF — an m68k/sparc/ppc leg, the
  // exact shape that used to be waved through with "the host's own otool/ldd
  // cannot meaningfully inspect a foreign-arch binary".
  const logs = [];
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: 'format=elf32be machine=4\nrun=/opt/pkg/lib\ndep=libc.so.12\ndeps=1\n',
    logs,
  });
  assert.throws(() => check('/build/tjs/netbsd-m68k/tjs'), /\/opt\/pkg\/lib/);
});

test('checkHermeticDeps: a clean PE (Windows) engine reports OK with counts, not a skip', () => {
  const logs = [];
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: 'format=pe64 machine=0x8664\ndep=KERNEL32.dll\ndep=ADVAPI32.dll\ndeps=2\n',
    logs,
  });
  assert.doesNotThrow(() => check('C:\\build\\tjs.exe'));
  const joined = logs.join('\n');
  console.log('windows harness log:', joined);
  assert.match(joined, /OK —/);
  assert.match(joined, /2 dynamic dependencies/);
  assert.doesNotMatch(joined, /SKIPPED/);
});

// ---- MINOR 13: the CI job summary must report FAILURES, not only successes --
//
// Reviewer finding, 2026-09-17. The $GITHUB_STEP_SUMMARY append used to sit
// AFTER every throw in checkHermeticDeps, so the summary collected a bullet
// for each leg that PASSED and nothing at all for a leg that FAILED -- which
// in that list is indistinguishable from a leg that never ran. "No verdict"
// and "no verdict was needed" reading the same is precisely the confusion this
// whole phase exists to abolish, and the phase's own reporting must not
// reintroduce it.
//
// Run for real against a temp file rather than grepped out of the source: the
// fix is a try/catch around the body (so a check added here later inherits the
// reporting instead of having to remember it), and what matters is that a line
// LANDS, not that the source has a particular shape.
test('checkHermeticDeps: a FAILING leg writes a red line to the CI job summary', () => {
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: 'format=elf32be machine=4\nrun=/opt/pkg/lib\ndep=libc.so.12\ndeps=1\n',
    logs: [],
  });
  assert.throws(() => check('/build/tjs/netbsd-m68k/tjs'), /\/opt\/pkg\/lib/,
    'reporting must not swallow the failure — the build still has to stop');
  const summary = check.summary();
  assert.match(summary, /netbsd-m68k/, 'the summary line must name the LEG that failed');
  assert.match(summary, /FAILED/, 'and it must read as red, not as an absent verdict');
  assert.strictEqual(summary.split('\n').filter(Boolean).length, 1,
    `exactly one summary line per leg, got: ${JSON.stringify(summary)}`);
});

test('checkHermeticDeps: a leg whose depscan output cannot be PARSED is reported too', () => {
  // The throw that has no throw site of its own inside checkHermeticDeps:
  // parseDepscan raises it. A per-throw-site append would have missed this
  // one, which is why the reporting wraps the whole body.
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: '        Start    End      Type  Open Ref GrpRef Name\n',
    logs: [],
  });
  assert.throws(() => check('/build/tjs/openbsd-amd64/tjs'), /unrecognized line/);
  assert.match(check.summary(), /openbsd-amd64/);
  assert.match(check.summary(), /FAILED/);
});

test('checkHermeticDeps: a PASSING leg still writes its OK line', () => {
  // The other half of the distinction: three states (OK, FAILED, absent) must
  // stay distinguishable, so fixing the failure path must not cost the success
  // path. This also exercises fs.appendFileSync through the harness, the call
  // that was silently unreachable before `fs` was injected above.
  const check = loadCheckHermeticDeps({
    wantStatic: false,
    depscanOut: 'format=pe64 machine=0x8664\ndep=KERNEL32.dll\ndeps=1\n',
    logs: [],
  });
  assert.doesNotThrow(() => check('/build/tjs/windows-amd64/tjs.exe'));
  const summary = check.summary();
  assert.match(summary, /windows-amd64/);
  assert.match(summary, /OK —/);
  assert.doesNotMatch(summary, /FAILED/);
});

// ---- optional: a locally built engine, if one exists ----------------------

test('local engine (if built): dynamic deps contain no package-manager paths', () => {
  const { tjsBin } = require(path.join(repo, 'scripts/platform-tag.cjs'));
  let enginePath;
  try {
    enginePath = tjsBin(repo);
  } catch {
    console.log('local engine check: SKIPPED (platform-tag could not resolve a local engine path on this host)');
    return;
  }
  if (!enginePath || !fs.existsSync(enginePath)) {
    console.log(`local engine check: SKIPPED (no local engine built at ${enginePath || '<unresolved>'})`);
    return;
  }
  // Same verifier the build runs, same verdict function — not otool/ldd, and
  // not a hand copy of the denylist.
  //
  // DELIBERATE BEHAVIOUR CHANGE (phase 4b), called out because it is one: this
  // test used to skip when the INSPECTOR was unavailable ("otool/ldd
  // unavailable or failed"). It no longer can — depscanExe() cmake-builds the
  // verifier, and a failure there throws. That is correct twice over. First,
  // an engine we cannot inspect is unverified, and a skip would say
  // "verified" by omission — the whole defect this phase deletes. Second, it
  // adds NO new requirement to the suite: test/depscan.test.cjs and
  // test/depscan-agreement.test.cjs already build depscan unconditionally, so
  // a host without cc/cmake cannot run this suite at all, with or without a
  // local engine. The remaining skips here are about the ENGINE being absent,
  // which is a real precondition, and they still say so.
  const { depscanExe } = require('./depscan-build.cjs');
  const { parseDepscan, hermeticityFindings, PKG_MANAGER_ROOTS } = require(path.join(repo, 'scripts/depscan-verdict.cjs'));
  const out = execFileSync(depscanExe(), [enginePath], { encoding: 'utf8' });
  const findings = hermeticityFindings(parseDepscan(out), PKG_MANAGER_ROOTS);
  assert.deepStrictEqual(findings, [],
    `local engine at ${enginePath} is not hermetic:\n  ${findings.join('\n  ')}`);
});
