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
// stale in this repo, which is why scripts/engine-recipe.mjs's FILES is derived):
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

function forcedWin32Files(testFiles, io = realIo) {
  const out = [];
  for (const f of testFiles) {
    let text = '';
    for (const c of requireClosure(f, io)) {
      try { text += `${io.read(c)}\n`; } catch { /* unreadable member: it contributes nothing */ }
    }
    if (!SENSITIVE.test(text)) continue;
    if (REAL_OS.test(text)) continue;
    out.push(f);
  }
  return out;
}

module.exports = { SENSITIVE, REAL_OS, PRELOAD, FLOOR, discover, requireClosure, forcedWin32Files };

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
    const env = { ...process.env };
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${PRELOAD}`.trim();
    process.exit(spawnSync(process.execPath, ['--test', ...files],
      { env, stdio: 'inherit' }).status ?? 1);
  }
  for (const f of forcedWin32Files(discover(path.join(__dirname)))) {
    console.log(path.relative(path.join(__dirname, '..'), f));
  }
}
