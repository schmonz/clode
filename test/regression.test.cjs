// Drift-robust regression for the JS extract + inspect pipeline. Two layers:
//
//   1. SELF-CONTAINED (always runs): the pipeline over a deterministic synthetic
//      bundle (test/mock-bundle.cjs) whose output shas are committed in
//      test/golden-mock-shas.json. Needs NO provider binary, so it's the reliable
//      CI signal — any unintended change to the extractor/inspector output trips it.
//      Re-bless: node test/update-mock-golden.cjs
//
//   2. PROVIDER PARITY (opt-in): the pipeline over REAL checksum-verified provider
//      binaries vs a committed manifest (test/golden-shas.json) — the deeper "did
//      upstream's format drift" check. Providers are present only after `clode fetch`;
//      absent versions SKIP (logged), so a bare environment stays green.
//      Re-bless: node test/update-golden-shas.cjs
//
// Per version: extract-claude-js.cjs <provider> -> sha256(cli.cjs) == cli_sha256,
// then inspect-claude-bundle.cjs <cli.cjs> --json -> sha256(stdout) == inspect_json_sha256.
const { test } = require('node:test');
const assert = require('node:assert');
const { VERSIONS, providerBin, shasForBinary } = require('./golden-shas-lib.cjs');
const { mockShas } = require('./mock-bundle.cjs');
const MANIFEST = require('./golden-shas.json');
const MOCK_GOLDEN = require('./golden-mock-shas.json');

// Layer 1: the reliable, always-on signal.
test('extract+inspect sha parity for the self-contained mock bundle', () => {
  const { cli_sha256, inspect_json_sha256 } = mockShas();
  assert.strictEqual(cli_sha256, MOCK_GOLDEN.cli_sha256, 'mock cli_sha256');
  assert.strictEqual(inspect_json_sha256, MOCK_GOLDEN.inspect_json_sha256, 'mock inspect_json_sha256');
});

// Layer 2: real-provider parity, opt-in (skips cleanly when providers are absent).
const present = VERSIONS.filter(providerBin);
const absent = VERSIONS.filter((v) => !providerBin(v));
if (absent.length) console.error(`[regression] SKIP (no provider binary): ${absent.join(', ')}`);
console.error(`[regression] provider binaries present: ${present.join(', ') || '(none)'}`);

for (const v of VERSIONS) {
  test(`extract+inspect sha parity for ${v}`, (t) => {
    const bin = providerBin(v);
    if (!bin) { t.skip(`no provider binary for ${v} (fetch with: clode fetch ${v})`); return; }
    const { cli_sha256, inspect_json_sha256 } = shasForBinary(bin);
    assert.strictEqual(cli_sha256, MANIFEST[v].cli_sha256, `cli_sha256 ${v}`);
    assert.strictEqual(inspect_json_sha256, MANIFEST[v].inspect_json_sha256, `inspect_json_sha256 ${v}`);
  });
}
