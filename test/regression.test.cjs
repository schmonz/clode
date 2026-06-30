// Drift-robust regression for the JS extract + inspect pipeline.
// No Python, and NO dependency on the gitignored build/ goldens: instead it
// asserts the JS tools reproduce a COMMITTED sha256 manifest (test/golden-shas.json)
// against the stable, checksum-verified provider binaries.
//
// Per version: extract-claude-js.cjs <provider> -> sha256(cli.cjs) == cli_sha256,
// then inspect-claude-bundle.cjs <cli.cjs> --json -> sha256(stdout) == inspect_json_sha256.
// Versions whose provider binary is absent are SKIPPED (logged, not silently dropped);
// at least one version must run.
//
// To re-bless after an INTENTIONAL change to the JS extractor/inspector output:
// node test/update-golden-shas.cjs (then review the git diff of test/golden-shas.json).
const { test } = require('node:test');
const assert = require('node:assert');
const { VERSIONS, providerBin, shasForBinary } = require('./golden-shas-lib.cjs');
const MANIFEST = require('./golden-shas.json');

const present = VERSIONS.filter(providerBin);
const absent = VERSIONS.filter((v) => !providerBin(v));
if (absent.length) console.error(`[regression] SKIP (no provider binary): ${absent.join(', ')}`);
console.error(`[regression] provider binaries present: ${present.join(', ') || '(none)'}`);

test('at least one provider binary present for the regression', () => {
  assert.ok(present.length >= 1, 'need >=1 provider binary (run `clode update`)');
});

for (const v of VERSIONS) {
  test(`extract+inspect sha parity for ${v}`, (t) => {
    const bin = providerBin(v);
    if (!bin) { t.skip(`no provider binary for ${v} (fetch with: clode update ${v})`); return; }
    const { cli_sha256, inspect_json_sha256 } = shasForBinary(bin);
    assert.strictEqual(cli_sha256, MANIFEST[v].cli_sha256, `cli_sha256 ${v}`);
    assert.strictEqual(inspect_json_sha256, MANIFEST[v].inspect_json_sha256, `inspect_json_sha256 ${v}`);
  });
}
