'use strict';
// ccache detection for the tjs engine compile (spec 4c3, §11 acceptance 7 — "ccache
// is wired ... optionally"). Pulled into its own module, the same way depscan-verdict.cjs
// and platform-tag.cjs already are, rather than left inline in scripts/build-tjs.cjs, so a
// test can reach these two pure functions directly instead of pulling in that file's
// top-level side effects (a real checkout + configure) just to see whether one flag lands.
//
// THE PROPERTY THAT MATTERS MOST HERE IS THE NEGATIVE ONE: every leg that has never heard
// of ccache — most of them, though NOT all: this box has one, and so does GitHub's
// windows-latest image (see the correction below) — must keep building exactly
// as it does now. ccacheLauncher() returns null whenever the tool cannot be found (or the
// caller opted out), and applyCcacheArg() leaves its input completely alone when handed
// null: no new flag, no reordering, nothing a diff would show.
//
// A cache that returns the wrong object file for the compiler invocation it was keyed on is
// worse than no cache at all, and this project ships binaries built from 42 platform legs,
// several cross-compiled from one host. Task 2 installed a real ccache and proved the key
// space is safe FOR THE HOST LEG ONLY (gcc/clang, darwin/arm64). That scope limit is now
// enforced rather than merely documented: see UNTRUSTED_COMPILERS below.
const { findTool } = require('../libexec/clode-hosttools.cjs');

// WHY THIS OPTS IN ON MERE PRESENCE -- AND THE PREMISE THAT TURNED OUT TO BE FALSE.
// ccacheLauncher() enables the launcher whenever it finds the tool, with no cache directory
// configured and nothing in .github/ setting or persisting CCACHE_DIR. The comment that
// used to stand here justified that with "no runner image we use ships ccache, so the
// wiring is a FLEET-WIDE NO-OP". THAT WAS FALSE, and CI proved it: GitHub's windows-latest
// image ships ccache at C:\Strawberry\c\bin\ccache.EXE (Strawberry Perl bundles it), that
// directory is on the PATH of the `tjs / leg (windows-amd64, windows-latest, ...)`
// engine-build job, and that leg produces a RELEASE artifact (run 35468190935,
// `actual: 'C:\Strawberry\c\bin\ccache.EXE'`).
//
// So the wiring has been LIVE on a Windows release leg, driving MSVC's cl.exe, with no way
// to tell from the log -- which never echoed the cmake `-D` arguments at all. Two fixes, both
// here and both tested: ccacheDecision()/describeCcacheDecision() make the decision a LOGGED,
// greppable line on every build, whichever way it went, so the next time this premise is
// wrong the log says so; and UNTRUSTED_COMPILERS declines the launcher outright for cl, the
// compiler ccache has not been proven with here. Cost on the legs where it stays enabled is
// bounded -- an all-miss run is ~5-10% over a no-cache build -- and the real CI-level cache
// is the recipe-keyed actions/cache in .github/actions/build-leg/action.yml, which skips
// the compile ENTIRELY on a hit.
//
// CLODE_TJS_CCACHE=0 is the opt-out a leg can set without a code edit — added to
// test/env-verdicts.cjs's phase4-engine cluster in the same commit that adds this file, so
// the env-name inventory ratchet does not go red over a name shipped code reads but no
// verdict names.
//
// findToolFn is the injection seam: scripts/build-tjs.cjs always passes the real findTool
// (from libexec/clode-hosttools.cjs, the same PATH-walking lookup every other host-tool
// probe in this repo uses); a test passes a synthetic one so the PRESENT path can be
// exercised on a box that has never installed the real thing.
// The opt-out decision, split out from ccacheLauncher() because the CALL SITE needs it
// too: "no launcher" and "the user explicitly said no" produce DIFFERENT cmake argument
// lists (see applyCcacheArg), and ccacheLauncher() returns null for both.
function ccacheOptedOut(env = process.env) {
  return env.CLODE_TJS_CCACHE === '0';
}

function ccacheLauncher({ env = process.env, findToolFn = findTool } = {}) {
  if (ccacheOptedOut(env)) return null;
  return findToolFn('ccache', { env });
}

// Pure, and deliberately the ONLY place `-DCMAKE_C_COMPILER_LAUNCHER=` gets spelled. THREE
// outcomes, not two — the middle one was a review finding (2026-09-19), not a refinement:
//
//   launcher found       -> push `-DCMAKE_C_COMPILER_LAUNCHER=<path>`
//   found but REFUSED    -> push `-DCMAKE_C_COMPILER_LAUNCHER=` (EMPTY, clearing)
//   tool simply absent   -> push NOTHING: same array, same length, same bytes
//
// `clear` was called `optedOut` until the untrusted-compiler decline landed: there are now
// TWO states that found something and refuse to use it (CLODE_TJS_CCACHE=0, and a compiler
// ccache cannot be trusted with), and both have the same cmake consequence -- undo whatever
// a previous configure of this build dir left in CMakeCache.txt. The name describes the
// consequence, so a third such state needs no third name.
//
// Why the opt-out cannot just "push nothing": cmake PERSISTS every `-D` in CMakeCache.txt,
// and scripts/build-tjs.cjs REUSES build dirs across runs (dropStaleCmakeCache only wipes
// when the source dir moved). Reconfiguring without the flag therefore leaves the old value
// in place, so `CLODE_TJS_CCACHE=0` did exactly nothing on any build dir that had been
// configured once with ccache — which is every build dir on a developer box with it
// installed, i.e. precisely the population the opt-out exists for. Pushing an EMPTY value
// clears the cache entry; verified against a real cmake reconfigure in test/ccache.test.cjs.
//
// Why the clearing flag must NOT ride the absent branch: that would change the cmake command
// line on all 42 legs, none of which have ccache — destroying task 1's headline negative
// property ("a leg that has never heard of the tool builds byte-identically to before"). The
// asymmetry is load-bearing, and both halves are asserted.
function applyCcacheArg(cmakeArgs, ccachePath, { clear = false } = {}) {
  if (ccachePath) cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${ccachePath}`);
  else if (clear) cmakeArgs.push('-DCMAKE_C_COMPILER_LAUNCHER=');
  return cmakeArgs;
}

// ---- which compiler ccache may drive, and how this code knows which one it IS ---------
//
// THE COMPILER IS READ OUT OF THE CMAKE ARGUMENTS THE BUILD ITSELF ASSEMBLED. That is the
// same signal that SELECTS the compiler: scripts/build-tjs.cjs pushes
// `-DCMAKE_C_COMPILER=cl` on the native MSVC path (the windows-amd64/arm64 hard publishers,
// scripts/tjs-legs.mjs `msvc:true`) and `-DCMAKE_C_COMPILER=gcc` on the opt-in mingw path,
// both alongside a forced `-G Ninja`. Reading it back is therefore not a second, parallel
// notion of "what are we building with" that could drift from the first -- it is the first.
//
// WHY NOT process.platform: a win32 HOST is not an MSVC BUILD. The same host builds with
// gcc under CLODE_TJS_WIN_MINGW=1, and the platform signal cannot tell those apart, so it
// would take the cache away from a compiler ccache has driven correctly for twenty years.
// Expressed as "this compiler is one ccache cannot be trusted with here" it is also ONE
// implementation for all 42 legs rather than an `if (windows)` branch -- the repo's
// solve-it-portably rule. Proven by a test that runs both signals against the mingw leg.
//
// THE LIMIT OF THE SIGNAL, stated rather than papered over: when nothing pushes
// -DCMAKE_C_COMPILER, cmake picks the compiler itself and this code cannot name it (it
// reports '' / 'cmake-default' and trusts it). Every leg that reaches that branch is a
// gcc/clang leg today -- native POSIX, or a cross toolchain file that sets the compiler
// inside the file -- so the untrusted population is fully covered. A future toolchain file
// that selected an MSVC-mode compiler from inside the file would NOT be caught here; the
// log line says `compiler=cmake-default`, which is the string to grep for if that ever
// happens. Parsing toolchain .cmake files to close that gap was rejected as a second,
// drifting notion of compiler identity.
const UNTRUSTED_COMPILERS = new Map([
  ['cl', "ccache's MSVC support is partial and this repo has never verified it, and the legs "
    + 'built with this compiler are exactly the ones where the phase 4c3 object-grain '
    + 'reproducibility harness is skipped, so a wrong cache hit would ship unnoticed'],
  // clang-cl is the same cl.exe command-line interface (the caveat is about the interface and
  // its dependency reporting, not about the vendor), and it is equally unverified here.
  ['clang-cl', "ccache's MSVC-mode (cl-compatible) support is partial and this repo has never "
    + 'verified it, and the legs built with this compiler skip the object-grain '
    + 'reproducibility harness that would catch a wrong cache hit'],
]);

// Pure. Returns the compiler's normalised name, or '' when the build names none.
// Normalised to a bare lower-case basename without .exe, so an absolute
// `C:/Program Files/.../CL.EXE` and a bare `cl` are the same fact. LAST occurrence wins,
// which is how cmake itself resolves a repeated `-D`.
function compilerFromCmakeArgs(cmakeArgs) {
  const prefix = '-DCMAKE_C_COMPILER=';
  const values = (cmakeArgs || []).filter((a) => typeof a === 'string' && a.startsWith(prefix));
  if (values.length === 0) return '';
  const raw = values[values.length - 1].slice(prefix.length);
  const base = raw.split(/[\\/]/).pop() || '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

// Pure. The reason this compiler may not be launched through ccache here, or '' if it may.
function untrustedCompilerReason(compiler) {
  return UNTRUSTED_COMPILERS.get(String(compiler || '').toLowerCase()) || '';
}

// ---- the DECISION, as one value: what happened, and enough to say why -----------------
//
// Three states, not a boolean, because "we did not enable it" has genuinely different
// causes with genuinely different consequences, and the build log has to be able to tell
// them apart. `clear` is the cmake-argument consequence (see applyCcacheArg's asymmetry
// note): only a state that had something to UNDO may push the clearing flag, or the
// tool-absent legs stop being byte-identical to their pre-feature selves.
//
//   enabled    launcher found, and the compiler is one it may drive -> push the launcher
//   opted-out  CLODE_TJS_CCACHE=0                                   -> push the EMPTY clear
//   declined   found, but the compiler is one it may NOT drive       -> push the EMPTY clear
//   absent     nothing named ccache on PATH                         -> push NOTHING
//
// ORDER IS LOAD-BEARING: absence is decided BEFORE compiler trust. A leg with no ccache
// installed must produce cmake args byte-identical to its pre-feature self, and that
// includes the MSVC legs -- deciding trust first would push a clearing flag for a tool the
// box does not even have, changing the command line on legs this feature never touched.
function ccacheDecision({ env = process.env, findToolFn = findTool, compiler = '' } = {}) {
  if (ccacheOptedOut(env)) return { state: 'opted-out', launcher: null, compiler, clear: true };
  const launcher = ccacheLauncher({ env, findToolFn });
  if (!launcher) return { state: 'absent', launcher: null, compiler, clear: false };
  const reason = untrustedCompilerReason(compiler);
  // Declined, and the launcher is deliberately dropped to null rather than carried along:
  // applyCcacheArg's ONE rule is "a launcher value means push it", and a decision that keeps
  // a path it refuses to use is one careless edit away from using it.
  if (reason) return { state: 'declined', launcher: null, found: launcher, compiler, clear: true, reason };
  return { state: 'enabled', launcher, compiler, clear: false };
}

// The ONE line scripts/build-tjs.cjs prints on every build, before cmake is configured.
//
// WHY A PURE FUNCTION RATHER THAN console.error() SPRINKLED THROUGH THE BRANCHES: this text
// is a contract (CI logs get grepped for it), so it is asserted EXACTLY in
// test/ccache.test.cjs — which cannot require() scripts/build-tjs.cjs, because that file
// runs a whole engine build on load.
//
// PLAIN ASCII, DELIBERATELY. The leg this line matters most on is the Windows one, whose
// console can mangle UTF-8 punctuation; an em dash here would be the one character that
// makes the line unreadable exactly where it is needed. Asserted.
//
// A STATE THIS FUNCTION DOES NOT KNOW IS AN ERROR, not an empty string: a blank line reads
// like "no ccache decision was made", which is the failure mode this whole mechanism exists
// to prevent, and it would be introduced by the most likely future edit (adding a state).
function describeCcacheDecision(decision) {
  const { state, launcher, compiler, reason } = decision;
  // The compiler is ON the line because it is the fact nobody could establish from CI run
  // 35468190935: which compiler ccache was launching. 'cmake-default' is honest about the
  // one case this code genuinely does not know (see compilerFromCmakeArgs).
  const named = compiler || 'cmake-default';
  if (state === 'enabled') {
    return `build-tjs: ccache: ENABLED launcher=${launcher} compiler=${named} (found on PATH)`;
  }
  if (state === 'declined') {
    // `found=`, not `launcher=`: naming the path it REFUSED to launch is the point, and the
    // two must not read alike in a log that gets grepped for one of them.
    return `build-tjs: ccache: DISABLED found=${decision.found} compiler=${named} `
      + `(declined: ${reason})`;
  }
  if (state === 'opted-out') {
    return 'build-tjs: ccache: DISABLED (opted out: CLODE_TJS_CCACHE=0)';
  }
  if (state === 'absent') {
    return 'build-tjs: ccache: DISABLED (not found: no ccache on PATH)';
  }
  throw new Error(`unknown ccache decision state '${state}' — describeCcacheDecision must be `
    + 'taught every state ccacheDecision can return, or a build silently logs nothing about a '
    + 'decision that changes which compiler driver runs');
}

// The call site's single move: the decision that was LOGGED is the decision that is APPLIED,
// because it is the same object. (Recomputing it here would let the log and the cmake
// command line disagree — which is the class of defect this whole change is about.)
function applyCcacheDecision(cmakeArgs, decision) {
  return applyCcacheArg(cmakeArgs, decision.launcher, { clear: decision.clear });
}

module.exports = {
  ccacheLauncher, applyCcacheArg, ccacheOptedOut,
  ccacheDecision, describeCcacheDecision, applyCcacheDecision,
  compilerFromCmakeArgs, untrustedCompilerReason,
};
