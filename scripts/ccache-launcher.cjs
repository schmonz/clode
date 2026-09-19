'use strict';
// ccache detection for the tjs engine compile (spec 4c3, §11 acceptance 7 — "ccache
// is wired ... optionally"). Pulled into its own module, the same way depscan-verdict.cjs
// and platform-tag.cjs already are, rather than left inline in scripts/build-tjs.cjs, so a
// test can reach these two pure functions directly instead of pulling in that file's
// top-level side effects (a real checkout + configure) just to see whether one flag lands.
//
// THE PROPERTY THAT MATTERS MOST HERE IS THE NEGATIVE ONE: every leg that has never heard
// of ccache — which today is all of them, this box included — must keep building exactly
// as it does now. ccacheLauncher() returns null whenever the tool cannot be found (or the
// caller opted out), and applyCcacheArg() leaves its input completely alone when handed
// null: no new flag, no reordering, nothing a diff would show.
//
// WHY THIS IS DEFERRED TO TASK 2, NOT DONE HERE: a cache that returns the wrong object file
// for the compiler invocation it was keyed on is worse than no cache at all, and this
// project ships binaries built from 42 different platform legs, several of them
// cross-compiled from one host. Task 1 only wires the launcher through when the tool is
// genuinely present; Task 2 installs it and proves the key space is safe.
const { findTool } = require('../libexec/clode-hosttools.cjs');

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
//   EXPLICIT opt-out     -> push `-DCMAKE_C_COMPILER_LAUNCHER=` (EMPTY, clearing)
//   tool simply absent   -> push NOTHING: same array, same length, same bytes
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
function applyCcacheArg(cmakeArgs, ccachePath, { optedOut = false } = {}) {
  if (ccachePath) cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${ccachePath}`);
  else if (optedOut) cmakeArgs.push('-DCMAKE_C_COMPILER_LAUNCHER=');
  return cmakeArgs;
}

module.exports = { ccacheLauncher, applyCcacheArg, ccacheOptedOut };
