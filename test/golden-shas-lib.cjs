// Single source of truth for the JS extract+inspect golden-sha pipeline.
// Shared by test/regression.test.cjs (asserts against the committed manifest)
// and test/update-golden-shas.cjs (regenerates the manifest). Keeping the
// compute here means the test and the regenerator cannot drift.
//
// Pure Node stdlib only.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NODE = process.env.CLODE_NODE || process.execPath;
const REPO = path.resolve(__dirname, '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const INSPECT = path.join(REPO, 'libexec', 'inspect-claude-bundle.cjs');

// The provider binary versions covered by the golden manifest.
const VERSIONS = [
  '2.1.177',
  '2.1.179',
  '2.1.183',
  '2.1.185',
  '2.1.186',
  '2.1.193',
  '2.1.195',
];

function providersDir() {
  return process.env.CLODE_PROVIDERS ||
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
      'clode/providers');
}

function providerBin(v) {
  const p = path.join(providersDir(), v, 'claude');
  return fs.existsSync(p) ? p : null;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// extract -> sha256(cli.cjs), then inspect --json -> normalize file -> sha256.
function shasForBinary(binPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  try {
    const cli = path.join(tmp, 'cli.cjs');
    const ex = spawnSync(NODE, [EXTRACT, binPath, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract failed: ${ex.stderr}`);
    const cli_sha256 = sha256(fs.readFileSync(cli));

    const ins = spawnSync(NODE, [INSPECT, cli, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ins.status !== 0) throw new Error(`inspect failed: ${ins.stderr}`);
    // Normalize the only path-dependent field (input path) before hashing.
    const doc = JSON.parse(ins.stdout); doc.file = 'cli.cjs';
    const inspect_json_sha256 = sha256(JSON.stringify(doc, null, 2));

    return { cli_sha256, inspect_json_sha256 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { VERSIONS, providersDir, providerBin, shasForBinary, sha256 };
