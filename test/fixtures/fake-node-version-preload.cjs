'use strict';
// --require preload for faking process.versions.node in a REAL spawned process,
// before the main module (CJS or ESM) is loaded. Used by clode-main.test.cjs's
// floor tests to exercise scripts/stage0.mjs's own floor-check logic under a
// fabricated version string, without depending on the SPAWNING/test-runner
// node's own capabilities (e.g. require(esm) support) — a `--require` preload
// runs before the main module executes regardless of the main module's type,
// so this works identically whether the entry being spawned is a .cjs or a
// .mjs file, and on any node old enough to support `--require` at all (which
// long predates the v20 floor these tests exist to check).
//
// Set CLODE_TEST_FAKE_NODE_VERSION in the child's env; a no-op if unset (so
// accidentally leaving this on --require for an unrelated spawn is harmless).
if (process.env.CLODE_TEST_FAKE_NODE_VERSION) {
  Object.defineProperty(process.versions, 'node', {
    value: process.env.CLODE_TEST_FAKE_NODE_VERSION,
    configurable: true,
  });
}
