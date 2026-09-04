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
// offline run and a `CLODE_LIVE_ONLINE=1` run looked the same before this).
//
// Because deriving means enumerating the real environment, this formatter is also where
// a secret would leak into a CI log — this repo's own root `clode_gh_token` file makes
// that a live possibility, not a hypothetical. The FIRST version of this fix used a
// DENY-list of secret-shaped names (`/TOKEN|SECRET|KEY|PASSWORD/i`) and it leaked:
// measured in review, `CLODE_CREDENTIALS`, `CLODE_PASS`, `CLODE_AUTH` and
// `CLODE_SESSION` all sailed straight through it with their values printed in full. A
// deny-list of secret-shaped names has exactly the defect this whole phase exists to
// remove from gate lists — it is complete only until the next name — except here the
// cost of being one name short is a credential in a log, not a missed test.
//
// So this is inverted into an ALLOW-list, SAFE_GATE_NAMES: only a name on that list
// prints its value; every other `CLODE_*` name prints as `NAME=<set>` — visible that the
// gate was set, value withheld. A brand-new variable nobody has classified yet now
// defaults to WITHHELD, not exposed. Do not "fix" a future leak by adding another
// deny-pattern here — that is the same defect one layer over. Extend SAFE_GATE_NAMES
// only when the value is a genuinely non-sensitive operational toggle (a boolean flag,
// a tool path, a small numeric knob) — never on the strength of a name NOT looking
// dangerous, which is the same reasoning that let CLODE_SESSION through the first time.
const SAFE_GATE_NAMES = new Set([
  // Live/e2e opt-ins: booleans, not values that could carry a credential.
  'CLODE_OFFLINE', 'CLODE_LIVE_RENDER', 'CLODE_LIVE_ONLINE', 'CLODE_LIVE_ROUNDTRIP',
  'CLODE_NAUDE_SMOKE', 'CLODE_TJS_SMOKE',
  // Resolved binary/tool paths: filesystem locations, not secrets.
  'CLODE_TJS', 'CLODE_NODE', 'CLODE_PROVIDER_BIN', 'CLODE_DARWIN_PROVIDER_BIN',
  'CLODE_CLAUDE_BIN', 'CLODE_NAUDE_BIN', 'CLODE_QUAUDE', 'CLODE_QUAUDE_EXE',
  'CLODE_RG', 'CLODE_BFS', 'CLODE_UGREP', 'CLODE_ZSTD', 'CLODE_TAR', 'CLODE_GZIP',
  'CLODE_UNZIP', 'CLODE_NPM', 'CLODE_LIBEXEC',
  // Store/cache roots: filesystem locations, not secrets.
  'CLODE_STATE_ROOT', 'CLODE_DEPS', 'CLODE_CACHE',
  // Small operational flags: build/target selectors, not secrets.
  'CLODE_TARGET', 'CLODE_TARGET_KIND', 'CLODE_ENGINE', 'CLODE_VERBOSE',
  'CLODE_TIMEOUT_SCALE', 'CLODE_UPDATE_CHANNEL', 'CLODE_CROSS_BUILD', 'CLODE_TJS_BUILD',
]);
function environmentStamp(env) {
  const known = (v) => (v === null || v === undefined || v === '' ? 'unknown' : String(v));
  const gates = env.gates || {};
  const gateKeys = Object.keys(gates);
  const gatesStr = gateKeys.length
    ? gateKeys.map((k) => `${k}=${SAFE_GATE_NAMES.has(k) ? gates[k] : '<set>'}`).join(',')
    : 'none';
  return `env: node=${known(env.execPath)} ${known(env.nodeVersion)} `
    + `platform=${known(env.platform)}-${known(env.arch)} osRelease=${known(env.osRelease)} `
    + `pin=${known(env.pin)} providerCarve=${known(env.providerCarve)} `
    + `engine=${known(env.engine)} gates=${gatesStr}`;
}

module.exports = { environmentStamp };
