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
function ccacheLauncher({ env = process.env, findToolFn = findTool } = {}) {
  if (env.CLODE_TJS_CCACHE === '0') return null;
  return findToolFn('ccache', { env });
}

// Pure, and deliberately the ONLY place `-DCMAKE_C_COMPILER_LAUNCHER=` gets spelled: handed
// a falsy ccachePath (the absent case, or the opted-out one), it returns cmakeArgs with
// nothing appended — same array, same length, same bytes. This is the function whose
// behavior on this box IS the "unchanged rebuild" half of the acceptance.
function applyCcacheArg(cmakeArgs, ccachePath) {
  if (ccachePath) cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${ccachePath}`);
  return cmakeArgs;
}

module.exports = { ccacheLauncher, applyCcacheArg };
