'use strict';
// environmentStamp(env) -> string. ONE line naming exactly which interpreter, platform,
// pin, provider carve, engine and env-gates produced a suite verdict.
//
// Why this exists (see the umbrella, phase 5 task 6): "the suite is green" is a property
// of the tree PLUS the interpreter, and nothing printed which interpreter ran. Two agents
// disagreed about a baseline on IDENTICAL commits for an afternoon because the same commit
// shows a different failure count under node 24 vs node 26 — nothing in the log said which
// one had run. A later phase then repeated a stale six-failure baseline for an entire
// phase because re-measuring it was nobody's job and nothing prompted it.
//
// The fix is not "log it once at startup" — a stamp at the top of a multi-minute run
// scrolls away long before the verdict does, so the two are never quoted together. This
// prints WITH the verdict, on both the pass and fail paths (test/run.mjs), so the number
// and the environment that produced it are always adjacent.
//
// A field whose value is unknown reads as the literal string `unknown`, never omitted.
// An omitted field looks like a field that did not matter; see the second test below.
function environmentStamp(env) {
  const known = (v) => (v === null || v === undefined || v === '' ? 'unknown' : String(v));
  const gates = env.gates || {};
  const gateKeys = Object.keys(gates);
  const gatesStr = gateKeys.length ? gateKeys.map((k) => `${k}=${gates[k]}`).join(',') : 'none';
  return `env: node=${known(env.execPath)} ${known(env.nodeVersion)} `
    + `platform=${known(env.platform)}-${known(env.arch)} osRelease=${known(env.osRelease)} `
    + `pin=${known(env.pin)} providerCarve=${known(env.providerCarve)} `
    + `engine=${known(env.engine)} gates=${gatesStr}`;
}

module.exports = { environmentStamp };
