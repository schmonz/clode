const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox, runClode } = require('./e2e.cjs');

// test_print.bats: the `-p` (print/non-interactive) path must reach a REAL model and
// come back with the model's reply. This is a live-network case — the bats test
// `skip "offline"` when CLODE_OFFLINE is set. The e2e harness constructs its sandbox
// env with CLODE_OFFLINE='1' (offline/hermetic by default), so this always skips here;
// the assertions below are preserved verbatim for when it is run against a live model.

test('clode -p reaches the model', (t) => {
  const sbx = sandbox(t);
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const r = runClode(sbx, ['-p', 'reply with exactly: PONG']);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.output, /not yet implemented|Cannot find module|is not a function/i);
  assert.match(r.output, /PONG/);
});
