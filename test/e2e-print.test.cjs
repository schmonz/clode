const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox } = require('./e2e.cjs');
const { stageProviderCli, providerSkipReason, runNaudeModelAsync } = require('./oracle-models.cjs');

// test_print.bats: the `-p` (print/non-interactive) path must reach a REAL model and
// come back with the model's reply. This is a live-network case — the bats test
// `skip "offline"` when CLODE_OFFLINE is set. The e2e harness constructs its sandbox
// env with CLODE_OFFLINE='1' (offline/hermetic by default), so this always skips here;
// the assertions below are preserved verbatim for when it is run against a live model.
//
// Runs the naude-model directly (a real provider's cli.cjs under node) — no launcher,
// no bin/clode: the builder-only surface has no `-p` passthrough left to run it through.

test('clode -p reaches the model', async (t) => {
  const sbx = sandbox(t);
  if (process.env.CLODE_LIVE_ONLINE !== '1') {
    t.skip('live ONLINE opt-in only (set CLODE_LIVE_ONLINE=1; uses your real credentials '
      + 'and spends real tokens). This asserts the -p path reaches a REAL model, so a mock '
      + 'cannot stand in for it.');
    return;
  }
  // Stage from the HOST env, run in the SANDBOX env. Staging carves a provider into a
  // cli.cjs on this machine — a build step, not part of what is under test — and the
  // sandbox env is deliberately constructed-clean (test/e2e.cjs), so passing it here
  // meant stageProviderCli could NEVER find a provider. Together with the offline gate
  // above, that gave these tests two independent reasons to be dark; both are removed.
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no Bun-packaged CC provider');
  if (skip) { t.skip(skip); return; }
  const r = await runNaudeModelAsync(staged.cli, ['-p', 'reply with exactly: PONG'],
    { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  const output = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(output, /not yet implemented|Cannot find module|is not a function/i);
  assert.match(output, /PONG/);
});
