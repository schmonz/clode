const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox } = require('./e2e.cjs');
const { stageProviderCli, providerSkipReason, runNaudeModelAsync } = require('./oracle-models.cjs');

// Faithful 1:1 port of test_tools.bats. Online-gated: the bash test skips when
// CLODE_OFFLINE is set. The e2e sandbox is constructed-clean with CLODE_OFFLINE=1,
// so this test always skips here — mirroring `skip "offline"`. When NOT offline it
// asserts the Bash tool round-trips a `-p` prompt end-to-end.
//
// Runs the naude-model directly (a real provider's cli.cjs under node) — no launcher,
// no bin/clode: the builder-only surface has no `-p` passthrough left to run it through.
test('Bash tool works end-to-end via -p', async (t) => {
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
  const r = await runNaudeModelAsync(staged.cli, [
    '-p', 'run the bash command: echo HELLO123 and report its output',
    '--allowedTools', 'Bash',
  ], { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  const output = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(output, /not yet implemented|is not a function|Cannot find module/i);
  assert.match(output, /HELLO123/);
});
