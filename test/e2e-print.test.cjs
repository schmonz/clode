const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox } = require('./e2e.cjs');
const { stageProviderCli, runNaudeModelAsync } = require('./oracle-models.cjs');

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
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const staged = stageProviderCli({ env: sbx.env });
  if (!staged) { t.skip('no Bun-packaged CC provider'); return; }
  const r = await runNaudeModelAsync(staged.cli, ['-p', 'reply with exactly: PONG'],
    { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  const output = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(output, /not yet implemented|Cannot find module|is not a function/i);
  assert.match(output, /PONG/);
});
