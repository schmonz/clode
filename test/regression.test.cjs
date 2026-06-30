// Drift-robust regression for the JS extract + inspect pipeline.
// No Python, and NO dependency on the gitignored build/ goldens: instead it
// asserts the JS tools reproduce a COMMITTED sha256 manifest (test/golden-shas.json)
// against the stable, checksum-verified provider binaries.
//
// Per version: extract-claude-js.cjs <provider> -> sha256(cli.cjs) == cli_sha256,
// then inspect-claude-bundle.cjs <cli.cjs> --json -> sha256(stdout) == inspect_json_sha256.
// Versions whose provider binary is absent are SKIPPED (logged, not silently dropped);
// at least one version must run.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NODE = process.env.CLODE_NODE || process.execPath;
const REPO = path.resolve(__dirname, '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const INSPECT = path.join(REPO, 'libexec', 'inspect-claude-bundle.cjs');
const MANIFEST = require('./golden-shas.json');
const PROVIDERS = process.env.CLODE_PROVIDERS ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'clode/providers');

function providerBin(v) {
  const p = path.join(PROVIDERS, v, 'claude');
  return fs.existsSync(p) ? p : null;
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const VERSIONS = Object.keys(MANIFEST);
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    try {
      const cli = path.join(tmp, 'cli.cjs');
      const ex = spawnSync(NODE, [EXTRACT, bin, cli], { encoding: 'utf8' });
      assert.strictEqual(ex.status, 0, `extract ${v}: ${ex.stderr}`);
      const cliSha = sha256(fs.readFileSync(cli));
      assert.strictEqual(cliSha, MANIFEST[v].cli_sha256, `cli_sha256 ${v}`);

      const ins = spawnSync(NODE, [INSPECT, cli, '--json'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      assert.strictEqual(ins.status, 0, `inspect ${v}: ${ins.stderr}`);
      // Normalize the only path-dependent field (input path) before hashing.
      const doc = JSON.parse(ins.stdout); doc.file = 'cli.cjs';
      const insSha = sha256(JSON.stringify(doc, null, 2));
      assert.strictEqual(insSha, MANIFEST[v].inspect_json_sha256, `inspect_json_sha256 ${v}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
