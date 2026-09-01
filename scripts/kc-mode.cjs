'use strict';
// Pure decision: what should CLODE_KC_MODE be for a given env?
//
// libexec/node-shim/modules/child_process.cjs's `_kcMaybe` skips the real
// keychain probe (`_kcDetect`, which writes/reads/updates/deletes a throwaway
// item against the operator's REAL login Keychain via the `security` binary)
// only when `CLODE_KC_MODE` is already set. test/run.mjs uses this to default
// the test suite's env so `node test/run.mjs` never touches the real
// Keychain, while still letting an operator override by exporting the var
// before invoking the runner — same opt-out shape as CLODE_LIVE_RENDER for
// the live-render TUI tests (test/quaude-build.test.cjs and friends).
//
// Separated into its own pure function purely for testability, same pattern
// as `wantsTrampoline` in test/node-shim-helper.cjs: test/run.mjs's top-level
// code has real side effects (it spawns the whole suite and calls
// process.exit), so it cannot itself be `require`d/`import`ed from a test.
function defaultKcMode(env) {
  return env.CLODE_KC_MODE !== undefined ? env.CLODE_KC_MODE : 'emulate';
}

module.exports = { defaultKcMode };
