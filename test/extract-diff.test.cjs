const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PY = process.env.CLODE_PYTHON || 'python3';
const NODE = process.env.CLODE_NODE || process.execPath;
const PY_TOOL = path.join(REPO, 'libexec', 'extract-claude-js');
const JS_TOOL = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const GOLDEN_VERSIONS = ['2.1.177', '2.1.179', '2.1.183', '2.1.185', '2.1.186', '2.1.193', '2.1.195'];
const PROVIDERS = process.env.CLODE_PROVIDERS ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'clode/providers');

function providerBin(v) {
  const p = path.join(PROVIDERS, v, 'claude');
  return fs.existsSync(p) ? p : null;
}

function extract(tool, bin, isJs) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ex-')), 'cli.cjs');
  const r = spawnSync(isJs ? NODE : PY, [tool, bin, out], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, out };
}

// Always-on: report which input binaries are available (no silent caps).
test('inputs available for the differential harness', () => {
  const have = GOLDEN_VERSIONS.filter(providerBin);
  console.error(`[extract-diff] local input binaries: ${have.join(', ') || '(none)'}`);
  const missing = GOLDEN_VERSIONS.filter((v) => !providerBin(v));
  if (missing.length) console.error(`[extract-diff] NOT fetched (no input binary): ${missing.join(', ')}`);
  assert.ok(have.length >= 1, 'need at least one provider binary (run `clode update`)');
});

for (const v of GOLDEN_VERSIONS) {
  test(`extract parity for ${v}`, (t) => {
    const bin = providerBin(v);
    if (!bin) { t.skip(`no input binary for ${v} (fetch with: clode update ${v})`); return; }
    const py = extract(PY_TOOL, bin, false);
    assert.strictEqual(py.status, 0, `python extract ${v}: ${py.stderr}`);
    // Oracle self-check: python output == committed golden.
    const golden = path.join(REPO, 'build', v, 'cli.cjs');
    if (fs.existsSync(golden)) {
      assert.ok(fs.readFileSync(py.out).equals(fs.readFileSync(golden)), `python==golden ${v}`);
    }
    // The real gate (active once the JS tool exists): JS output == python output.
    if (fs.existsSync(JS_TOOL)) {
      const js = extract(JS_TOOL, bin, true);
      assert.strictEqual(js.status, py.status, `JS exit ${v}: ${js.stderr}`);
      assert.ok(fs.readFileSync(js.out).equals(fs.readFileSync(py.out)), `JS==python ${v}`);
    }
  });
}
