const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox, runClode } = require('./e2e.cjs');

// Faithful 1:1 port of test_tools.bats. Online-gated: the bash test skips when
// CLODE_OFFLINE is set. The e2e sandbox is constructed-clean with CLODE_OFFLINE=1,
// so this test always skips here — mirroring `skip "offline"`. When NOT offline it
// asserts the Bash tool round-trips a `-p` prompt end-to-end.
test('Bash tool works end-to-end via -p', (t) => {
  const sbx = sandbox(t);
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const r = runClode(sbx, [
    '-p', 'run the bash command: echo HELLO123 and report its output',
    '--allowedTools', 'Bash',
  ]);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.output, /not yet implemented|is not a function|Cannot find module/i);
  assert.match(r.output, /HELLO123/);
});
