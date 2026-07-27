// test/no-clode-self.test.cjs — the update path no longer depends on CLODE_SELF.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
// NOTE: pattern is CLODE_SELF + clode-internal-update only. `targetUpdate` as a
// bare token would collide with the SURVIVING notify-only check (targetUpdateCheck
// / target-update-check.cjs); those two literals fully identify the retired
// rebuild machinery without that false match.
test('CLODE_SELF / --clode-internal-update are gone from libexec/scripts/bin', () => {
  const hits = execSync(
    "grep -rl 'CLODE_SELF\\|clode-internal-update' libexec scripts bin || true",
    { encoding: 'utf8' }).trim();
  assert.strictEqual(hits, '', `still references CLODE_SELF/internal-update:\n${hits}`);
});
