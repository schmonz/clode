'use strict';
// THE FORCED-WIN32 SECOND PASS — what it is, what it catches, what it does NOT.
//
// WHY IT EXISTS. Four consecutive rounds of Windows-only CI failures in this repo were
// POSIX assumptions in TEST code, each discovered by a ~2-hour CI cycle and none
// reachable from a local run: a ccache test asserting the box had no ccache on PATH; a
// CRLF-naive CMakeCache.txt reader; `C:\Program Files\LLVM\bin\llvm-ar.exe` split on
// spaces into argv[0] `C:\Program`, beside a fixture writing a POSIX-named `esbuild`
// stub; and a resolver test spawning `/bin/sh`. A static lint was MEASURED and rejected:
// `.split(' ')` occurs at exactly one site under test/, `split('\n')` at 67 sites
// against 5 CRLF-aware ones, and "a fixture wrote a POSIX binary name" has no lexical
// signature at all. What DID produce the round-3 red was running the file with
// `process.platform` set to 'win32' before requiring it. This is that, promoted from a
// one-off into a standing pass.
//
// HOW IT WORKS. test/run.mjs runs the main suite, then runs `node --test` a second time
// over the derived subset below with `--require test/forced-win32-preload.cjs`. Real
// execution: nothing is stubbed, no test file is edited, and the modules under test take
// their win32 branch for real because `process.platform` is read at call time.
//
// ---------------------------------------------------------------------------------
// WHAT IT CATCHES
//   - a platform BRANCH whose win32 side is wrong, unreachable, or throws;
//   - a test that asserts something only true on POSIX (round 1's shape);
//   - `os.tmpdir()` assumptions — the win32 branch reads TEMP/TMP, so a test that
//     hardcodes '/tmp' rather than asking goes red;
//   - a win32 code path that nothing else ever executes off Windows.
//
// WHAT IT DOES NOT CATCH — and this list is the point, because a second pass that reads
// as "Windows coverage" is worse than none:
//   - PATH SEPARATORS. node binds node:path to its POSIX implementation during
//     bootstrap, before any --require runs. `path.sep` stays '/' whatever
//     process.platform says, so backslashes, drive letters and round 3's
//     `C:\Program Files` split are OUT OF REACH. (test/forced-win32.test.cjs asserts
//     this rather than trusting it.)
//   - REAL TOOL BEHAVIOUR. lib.exe, cl.exe, cmd.exe, certutil, MSVC's archiver rules,
//     Strawberry Perl's ccache — none of them are here. Round 1 and round 2 are out of
//     reach for that reason.
//   - CRLF from a real filesystem, case-insensitive paths, locked files, 260-char path
//     limits, ACLs, `.exe` suffixing by the loader, or anything else that is the
//     operating system rather than a branch in our code.
//   - ANYTHING IN A CHILD PROCESS. The lie is told to one process; everything it spawns
//     runs on the real box. Hence the exclusion rule below.
// Only a real Windows runner covers those. This pass is a cheap pre-filter in front of
// it, never a substitute.
//
// ---------------------------------------------------------------------------------
// HOW THE FILE SET IS DERIVED (never listed — three hand-maintained lists have gone
// stale in this repo, which is why scripts/engine-recipe.cjs's FILES is derived):
//
//   a file is IN when its require-closure under test/ mentions a platform-sensitive
//   construct, and NOTHING in that closure reaches the real operating system.
//
// The second half is what keeps the pass honest and green. MEASURED on 2026-09-20, with
// the exclusion switched off: 177 of 284 test files matched the sensitivity pattern, and
// 100 of those went red under forcing — 341 of the 424 failing assertions from ONE
// cause, scripts/build-scratch.cjs's exec probe spawning `cmd.exe` to prove a scratch
// directory is exec-able. A Mac has no cmd.exe, so those files cannot even reach their
// own assertions; the rest of that noise was host-tool resolution looking for certutil /
// tar.exe / unzip.exe. None of it says anything about Windows, and build-scratch's own
// win32 branch is already covered, by injection, in test/build-scratch.test.cjs.
//
// THE COST OF THAT HONESTY, stated plainly: the files that spawn are excluded, and all
// four rounds so far happened in files that spawn. This pass would not have caught any
// of them by itself. What it is for is the SAME forcing applied by hand to a suspect
// file — `node test/forced-win32.cjs --run <file>` — which is how round 4 was found,
// plus a standing floor under the fixture-only code so that class stops regressing
// silently. Widening it requires a Windows runner, not a cleverer predicate.
const fs = require('node:fs');
const path = require('node:path');

// Platform-sensitive: the file reads the platform, asks for a temp dir through the API
// that branches on it, or spells a Windows-shaped name.
const SENSITIVE = /process\.platform|os\.tmpdir\(|PATHEXT|['"]win32['"]|\.exe['"]|\.cmd['"]/;

// Reaches the real operating system: anything that starts a child process. Host-tool
// resolution (scripts/clode-hosttools.cjs, host-provision) and the scratch allocator are
// caught by this too — they all spawn.
const REAL_OS = /child_process|spawnSync|execFileSync|execSync|execFile\(|\bspawn\(|\bfork\(/;

const PRELOAD = path.join(__dirname, 'forced-win32-preload.cjs');

// THE ONE WAY BACK IN: a test file whose PRODUCTION closure spawns, but whose tests never let it (every spawn they
// reach is injected), declares so in its own text, with a reason:
//
//     // forced-win32: spawn-injected: <why: which seams the tests inject>
//
// Its REAL_OS check then reads the TEST FILE and its test/ helpers only, not the production modules it requires. A
// declaring file whose own test-side code still matches REAL_OS stays OUT, and spawnInjectedContradictions() names it
// (test/forced-win32.test.cjs holds that list empty). WHY (fix round 1 of CI 44443821699, #2087): naude-entry.test.cjs
// injects spawn into runNaude for every first pass, yet was OUT because libexec/naude-entry.cjs requires
// child_process at top level; its win32 policy branch went untested until a real Windows runner turned it red.
const SPAWN_INJECTED = /^\s*\/\/\s*forced-win32: spawn-injected: \S.*$/m;
// Test-side: under the test file's own `test` directory (its nearest ancestor of that name; its own directory when it
// has none). Production modules (libexec/, scripts/) lie outside it.
function testRoot(f) {
  for (let d = path.dirname(f); ; d = path.dirname(d)) {
    if (path.basename(d) === 'test') return d;
    if (path.dirname(d) === d) return path.dirname(f);
  }
}
const isTestSide = (c, f) => { const r = path.relative(testRoot(f), c); return !r.startsWith('..') && !path.isAbsolute(r); };

// A floor, not a list: if the derivation regresses to near-nothing the gate goes red
// instead of quietly covering three files. Chosen below today's set with room for
// ordinary churn; raising it as the suite grows is fine, lowering it to pass is not.
const FLOOR = 10;

const realIo = {
  read: (f) => fs.readFileSync(f, 'utf8'),
  exists: (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } },
};

// Every *.test.cjs under `dir`, recursively — the same rule test/run.mjs discovers by
// (dotfiles and node_modules excluded), so the pass can never look at a different
// universe of files than the suite it follows.
function discover(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') discover(p, out); }
    else if (e.name.endsWith('.test.cjs')) out.push(p);
  }
  return out.sort();
}

// The transitive closure of a file's RELATIVE requires. Bare specifiers ('node:fs',
// packages) are deliberately not followed: the question is what OUR code in this
// checkout does, and a package's source is not something a test's author controls.
function requireClosure(file, io = realIo, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  let src;
  try { src = io.read(file); } catch { return seen; }
  for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    const base = path.resolve(path.dirname(file), m[1]);
    for (const cand of [base, `${base}.cjs`, `${base}.js`, `${base}.mjs`]) {
      if (io.exists(cand)) { requireClosure(cand, io, seen); break; }
    }
  }
  return seen;
}

function declaresSpawnInjected(f, io = realIo) {
  try { return SPAWN_INJECTED.test(io.read(f)); } catch { return false; }
}
// The test file and its test/ helpers (not the production modules): what a spawn-injected file's own code reaches.
function testSideText(f, io = realIo) {
  let text = '';
  for (const c of requireClosure(f, io)) if (isTestSide(c, f)) { try { text += `${io.read(c)}\n`; } catch { /* nothing */ } }
  return text;
}
// Declared spawn-injected, yet its own test-side code reaches the real OS: the declaration is false.
function spawnInjectedContradictions(testFiles, io = realIo) {
  return testFiles.filter((f) => declaresSpawnInjected(f, io) && REAL_OS.test(testSideText(f, io)));
}

// ---------------------------------------------------------------------------------
// NO FILE LEAVES THE PASS SILENTLY (2026-11-19). A row added to test/update-guard-dir.test.cjs required
// libexec/naude-entry.cjs. That module requires child_process, so the file's closure reached REAL_OS, and the whole
// file dropped out of the derived set. The pass stayed green with 13 fewer tests. The derivation was right, but
// nothing reported the drop. Two rules close that gap, and test/forced-win32.test.cjs gates both:
//
//   1. Some files are platform-sensitive, and their own test-side code never spawns, yet they are OUT because a
//      production module in their closure spawns. Such a file counts as excluded ON PURPOSE only when it is named here
//      with a reason. A new one goes red by name: declare it spawn-injected or list it. An entry that no longer fits
//      goes red as stale.
//   2. Every file the pass runs must report tests of its own. When a file registers none, exits early or dies before
//      reporting, node --test reports a stand-in under the file's own name instead of its tests. Before this rule, a
//      zero-test file showed up as a GREEN "ok - <file>". silentFiles() finds those stand-ins in the TAP, and the pass
//      goes red, naming the file.
const AUDIT_PENDING = 'its production closure spawns, and its tests have not been audited for injecting every spawn '
  + '(the 2026-11-19 baseline). Declare "forced-win32: spawn-injected:" once they are, and remove it from here.';
// SHRINK-ONLY DEBT (ruling 2026-11-19): the files excluded with AUDIT_PENDING on 2026-11-19, frozen. AUDIT_PENDING may
// be the reason only for a name in this list, and the list may only lose names: clear one by auditing its tests (then
// declare "forced-win32: spawn-injected:", or give it a specific reason below) and delete it here. A NEW exclusion
// states its own reason. BACKLOG.md names each and the audit that clears it.
const AUDIT_PENDING_BASELINE = Object.freeze([
  'test/bench-measure.test.cjs',
  'test/build-gates/build-runner-gates.test.cjs',
  'test/build-gates/carve-probe-gates.test.cjs',
  'test/build-gates/render-build-graph-gates.test.cjs',
  'test/build-graph-ci.test.cjs',
  'test/build-graph-render.test.cjs',
  'test/bunffi.test.cjs',
  'test/cell-profile-diff.test.cjs',
  'test/clode-build-args.test.cjs',
  'test/clode-build-smoke-home.test.cjs',
  'test/clode-build-spinner.test.cjs',
  'test/clode-current.test.cjs',
  'test/clode-hosttools.test.cjs',
  'test/clode-manifest-fetch.test.cjs',
  'test/clode-net.test.cjs',
  'test/clode-paths.test.cjs',
  'test/clode-rcodesign.test.cjs',
  'test/clode-target-build.test.cjs',
  'test/clode-templates.test.cjs',
  'test/clode-watch.test.cjs',
  'test/env-verdicts.test.cjs',
  'test/extract-autoupdater.test.cjs',
  'test/extract-cache-key.test.cjs',
  'test/fidelity/applet-config.test.cjs',
  'test/graph-require-rewrite.test.cjs',
  'test/host-provision.test.cjs',
  'test/native-oracle.test.cjs',
  'test/node-shim-buffer-lite.test.cjs',
  'test/paint-probe.test.cjs',
  'test/platform-tag.test.cjs',
  'test/provider-platform.test.cjs',
  'test/rg-stream.test.cjs',
  'test/sea-sign.test.cjs',
  'test/templates-blob-pack.test.cjs',
  'test/text-probe.test.cjs',
  'test/tls-cacert-pem.test.cjs',
  'test/ucd.test.cjs',
  'test/undici.test.cjs',
]);
const AUDIT_PENDING_CEILING = 38;   // lower it as names go; never raise it
const PRODUCTION_SPAWN_EXCLUDED = {
  ...Object.fromEntries(AUDIT_PENDING_BASELINE.map((k) => [k, AUDIT_PENDING])),
  // A file excluded since 2026-11-19 goes here with ITS OWN reason: what its tests reach that is real, and why.
};
// Sensitive, OUT, undeclared, and its test-side code spawns nothing: out only through a production module.
function productionSpawnOnly(testFiles, io = realIo) {
  const out = [];
  for (const f of testFiles) {
    let text = '';
    for (const c of requireClosure(f, io)) { try { text += `${io.read(c)}\n`; } catch { /* nothing */ } }
    if (!SENSITIVE.test(text) || !REAL_OS.test(text) || declaresSpawnInjected(f, io)) continue;
    if (!REAL_OS.test(testSideText(f, io))) out.push(f);
  }
  return out;
}
// Repo-relative, '/'-separated: the key PRODUCTION_SPAWN_EXCLUDED is spelled in.
const repoKey = (f, repo) => path.relative(repo, f).split(path.sep).join('/');
function exclusionFindings(testFiles, repo, io = realIo, listed = PRODUCTION_SPAWN_EXCLUDED,
  baseline = AUDIT_PENDING_BASELINE, ceiling = AUDIT_PENDING_CEILING) {
  const found = productionSpawnOnly(testFiles, io).map((f) => repoKey(f, repo));
  const debt = [];
  if (baseline.length > ceiling) {
    debt.push(`AUDIT_PENDING_BASELINE holds ${baseline.length} names, over its ceiling of ${ceiling}: it only shrinks`);
  }
  for (const [k, why] of Object.entries(listed)) {
    if (why === AUDIT_PENDING && !baseline.includes(k)) {
      debt.push(`${k}: excluded as AUDIT_PENDING but not in the frozen 2026-11-19 baseline: give it its own reason, or `
        + 'declare "forced-win32: spawn-injected:"');
    }
  }
  const unlisted = found.filter((k) => !(k in listed));
  const stale = Object.keys(listed).filter((k) => !found.includes(k));
  return [
    ...debt,
    ...unlisted.map((k) => `${k}: LEFT the forced-win32 pass only because a production module it requires spawns. `
      + 'Declare "// forced-win32: spawn-injected: <why>" if its tests inject every spawn, or list it in '
      + 'PRODUCTION_SPAWN_EXCLUDED with a reason'),
    ...stale.map((k) => `${k}: listed in PRODUCTION_SPAWN_EXCLUDED but no longer excluded that way: remove the entry`),
  ];
}
// The files of `files` that reported no test of their own (rule 2): node --test's stand-in, a top-level TAP line
// named for the file as it was passed (absolute, or relative to cwd).
function silentFiles(files, tapText, cwd = process.cwd()) {
  const byName = new Map();
  for (const f of files) { byName.set(f, f); byName.set(path.relative(cwd, path.resolve(cwd, f)), f); }
  const out = new Set();
  for (const m of String(tapText || '').matchAll(/^(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/gm)) {
    const name = m[1].replace(/\\([\\#])/g, '$1');
    if (byName.has(name)) out.add(byName.get(name));
  }
  return [...out];
}

function forcedWin32Files(testFiles, io = realIo) {
  const out = [];
  for (const f of testFiles) {
    let text = '';
    for (const c of requireClosure(f, io)) {
      try { text += `${io.read(c)}\n`; } catch { /* unreadable member: it contributes nothing */ }
    }
    if (!SENSITIVE.test(text)) continue;
    if (REAL_OS.test(declaresSpawnInjected(f, io) ? testSideText(f, io) : text)) continue;
    out.push(f);
  }
  return out;
}

module.exports = { SENSITIVE, REAL_OS, SPAWN_INJECTED, PRELOAD, FLOOR, discover, requireClosure, forcedWin32Files,
  declaresSpawnInjected, spawnInjectedContradictions, PRODUCTION_SPAWN_EXCLUDED, AUDIT_PENDING, AUDIT_PENDING_BASELINE, AUDIT_PENDING_CEILING, productionSpawnOnly, exclusionFindings,
  silentFiles };

// Triage mode, for the thing this machinery is actually best at: force ANY file, spawn
// or not, and see what a Windows runner would be arguing with. This is how the fourth
// round's failure was found before its CI logs were readable.
//
//   node test/forced-win32.cjs --list          the derived set the standing pass runs
//   node test/forced-win32.cjs --run <file>…   force those files, whatever they reach
if (require.main === module) {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => !a.startsWith('--'));
  if (argv.includes('--run') && files.length) {
    const { spawnSync } = require('node:child_process');
    const os = require('node:os');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${PRELOAD}`.trim();
    const tap = path.join(os.tmpdir(), `clode-forced-win32-${process.pid}.tap`);
    const status = spawnSync(process.execPath, ['--test', '--test-reporter', 'spec', '--test-reporter-destination', 'stdout',
      '--test-reporter', 'tap', '--test-reporter-destination', tap, ...files], { env, stdio: 'inherit' }).status ?? 1;
    let tapText = '';
    try { tapText = fs.readFileSync(tap, 'utf8'); } catch { /* none: every file is silent */ }
    finally { try { fs.unlinkSync(tap); } catch { /* best-effort */ } }
    const silent = tapText ? silentFiles(files, tapText) : files;
    for (const f of silent) {
      console.error(`forced-win32: ${f} reported NO tests of its own (it registered none, exited early, or died before reporting)`);
    }
    process.exit(silent.length ? 1 : status);
  }
  for (const f of forcedWin32Files(discover(path.join(__dirname)))) {
    console.log(path.relative(path.join(__dirname, '..'), f));
  }
}
