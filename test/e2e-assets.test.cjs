const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox } = require('./e2e.cjs');
const { stageProviderCli, runNaudeModelAsync } = require('./oracle-models.cjs');

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
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const staged = stageProviderCli({ env: sbx.env });
  if (!staged) { t.skip('no Bun-packaged CC provider'); return; }
  const r = await runNaudeModelAsync(staged.cli, ['--help'], { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  assert.doesNotMatch(r.stderr, /embeddedFiles|yoga|ENOENT.*\.(wasm|node)/i);
});

test('embedded-asset shim raises no consumer errors on -p', async (t) => {
  const sbx = sandbox(t);
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const staged = stageProviderCli({ env: sbx.env });
  if (!staged) { t.skip('no Bun-packaged CC provider'); return; }
  const r = await runNaudeModelAsync(staged.cli, ['-p', 'reply with exactly: PONG'],
    { cwd: staged.dir, env: sbx.env, timeout: 60000 });
  assert.doesNotMatch(r.stderr, /embeddedFiles|ENOENT.*\.(wasm|node)/i);
});
