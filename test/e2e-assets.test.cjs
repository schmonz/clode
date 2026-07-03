const { test } = require('node:test');
const assert = require('node:assert');
const { sandbox, runClode } = require('./e2e.cjs');

// Faithful 1:1 port of test_assets.bats. Both cases are online-gated: the bash tests
// `skip "offline"` when CLODE_OFFLINE is set. The e2e sandbox is constructed-clean with
// CLODE_OFFLINE=1 (offline/hermetic by default), so these always skip here — mirroring
// `skip "offline"`. When run against a live model they assert clode's embedded-asset
// shim (bun-shim.cjs / the real Claude bundle's embeddedFiles) surfaces no consumer
// errors on stderr. The bats bodies discard stdout (`>/dev/null`) and inspect ONLY
// stderr (`2>err; cat err`), so the assertions run against r.stderr, not r.output.

test('embedded-asset shim raises no consumer errors on --help', (t) => {
  const sbx = sandbox(t);
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const r = runClode(sbx, ['--help']);
  assert.doesNotMatch(r.stderr, /embeddedFiles|yoga|ENOENT.*\.(wasm|node)/i);
});

test('embedded-asset shim raises no consumer errors on -p', (t) => {
  const sbx = sandbox(t);
  if (sbx.env.CLODE_OFFLINE) { t.skip('offline'); return; }
  const r = runClode(sbx, ['-p', 'reply with exactly: PONG']);
  assert.doesNotMatch(r.stderr, /embeddedFiles|ENOENT.*\.(wasm|node)/i);
});
