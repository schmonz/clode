// test/no-clode-self.test.cjs — the update path no longer depends on CLODE_SELF.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
// Pattern covers the whole retired surface: CLODE_SELF, the --clode-internal-update
// callback verb, the deleted clode-target-update module, AND the targetUpdate
// rebuild function. `targetUpdate[^C]` matches a reintroduced targetUpdate(...) call
// but NOT the SURVIVING notify-only check `targetUpdateCheck` / `target-update-check.cjs`
// (the [^C] excludes the "Check" suffix; `clode-target-update` has the clode- prefix
// that `target-update-check.cjs` lacks). So a rebuild callback can't sneak back
// without also naming CLODE_SELF.
test('retired CLODE_SELF/targetUpdate rebuild surface is gone from libexec/scripts/bin', () => {
  const hits = execSync(
    "grep -rlE 'CLODE_SELF|clode-internal-update|clode-target-update|targetUpdate[^C]' libexec scripts bin || true",
    { encoding: 'utf8' }).trim();
  assert.strictEqual(hits, '', `still references retired rebuild machinery:\n${hits}`);
});
