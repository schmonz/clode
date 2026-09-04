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
//
// `gates` is meant to be DERIVED by the caller (every `CLODE_*` variable actually set —
// see test/run.mjs), never a hand-maintained list: a fixed list of "the gates we know
// about today" is stale the moment a new one is added, and a stamp built from a stale
// list prints identically for two runs that actually exercised different code (an
// offline run and a `CLODE_LIVE_ONLINE=1` run looked the same before this). Because
// deriving means enumerating the real environment, this formatter is also where a
// secret would leak into a CI log — this repo's root `clode_gh_token` file makes that a
// live possibility, not a hypothetical — so any gate NAME matching SECRET_NAME_RE has
// its VALUE redacted here, unconditionally, regardless of how the caller built the
// object. The name still prints (that a gate was set is the informative part); only the
// value is hidden.
const SECRET_NAME_RE = /TOKEN|SECRET|KEY|PASSWORD/i;
function environmentStamp(env) {
  const known = (v) => (v === null || v === undefined || v === '' ? 'unknown' : String(v));
  const gates = env.gates || {};
  const gateKeys = Object.keys(gates);
  const gatesStr = gateKeys.length
    ? gateKeys.map((k) => `${k}=${SECRET_NAME_RE.test(k) ? '<redacted>' : gates[k]}`).join(',')
    : 'none';
  return `env: node=${known(env.execPath)} ${known(env.nodeVersion)} `
    + `platform=${known(env.platform)}-${known(env.arch)} osRelease=${known(env.osRelease)} `
    + `pin=${known(env.pin)} providerCarve=${known(env.providerCarve)} `
    + `engine=${known(env.engine)} gates=${gatesStr}`;
}

module.exports = { environmentStamp };
