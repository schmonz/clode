const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox } = require('./e2e.cjs');
const { stageProviderCli, providerSkipReason, runNaudeModelAsync } = require('./oracle-models.cjs');

// Faithful 1:1 port of test_assets.bats. Both cases are online-gated: the bash tests
// `skip "offline"` when CLODE_OFFLINE is set. The e2e sandbox is constructed-clean with
// CLODE_OFFLINE=1 (offline/hermetic by default), so these always skip here — mirroring
// `skip "offline"`. When run against a live model they assert clode's embedded-asset
// shim (bun-shim.cjs / the real Claude bundle's embeddedFiles) surfaces no consumer
// errors on stderr. The bats bodies discard stdout (`>/dev/null`) and inspect ONLY
// stderr (`2>err; cat err`), so the assertions run against r.stderr, not the merged output.
//
// Runs the naude-model directly (a real provider's cli.cjs under node) — no launcher,
// no bin/clode: the builder-only surface has no passthrough left to run either arg through.

test('embedded-asset shim raises no consumer errors on --help', async (t) => {
  const sbx = sandbox(t);
  // NO network gate: this runs `--help` and asserts the embedded-asset shim raises no
  // consumer errors. It never reaches a model. It was offline-gated only because the
  // whole BATS file it was ported from was, so it never ran anywhere at all — the
  // sandbox hardcodes CLODE_OFFLINE=1 (test/e2e.cjs:73) and nothing unsets it.
  // Stage from the HOST env, run in the SANDBOX env. Staging carves a provider into a
  // cli.cjs on this machine — a build step, not part of what is under test — and the
  // sandbox env is deliberately constructed-clean (test/e2e.cjs), so passing it here
  // meant stageProviderCli could NEVER find a provider. Together with the offline gate
  // above, that gave these tests two independent reasons to be dark; both are removed.
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no Bun-packaged CC provider');
  if (skip) { t.skip(skip); return; }
  const r = await runNaudeModelAsync(staged.cli, ['--help'], { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  assert.doesNotMatch(r.stderr, /embeddedFiles|yoga|ENOENT.*\.(wasm|node)/i);
});

test('embedded-asset shim raises no consumer errors on -p', async (t) => {
  const sbx = sandbox(t);
  if (process.env.CLODE_LIVE_ONLINE !== '1') {
    t.skip('live ONLINE opt-in only (set CLODE_LIVE_ONLINE=1; uses your real credentials '
      + 'and spends real tokens). This asserts the -p path reaches a REAL model, so a mock '
      + 'cannot stand in for it.');
    return;
  }
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no Bun-packaged CC provider');
  if (skip) { t.skip(skip); return; }
  const r = await runNaudeModelAsync(staged.cli, ['-p', 'reply with exactly: PONG'],
    { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  assert.doesNotMatch(r.stderr, /embeddedFiles|ENOENT.*\.(wasm|node)/i);
});
