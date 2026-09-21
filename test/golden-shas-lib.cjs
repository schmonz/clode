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
// REBASED at the 2.1.27 auto-update notify-only redesign (new PRELUDE
// __clodeCheckUpdate + patchUpdateNotice splice + left-bounded native VERSION
// lookahead): the injected patch text and the inspect --json shape changed, which
// invalidates every older entry. Rebased onto the recent provider binaries on hand
// (2.1.210/215/218 — the 2.1.203–205 binaries were not retained). Old shas live in
// git history; re-add a version here and run test/update-golden-shas.cjs with its
// binary present to re-cover it.
const VERSIONS = [
  '2.1.210',
  '2.1.215',
  '2.1.218',
];

function providersDir() {
  return process.env.CLODE_PROVIDERS ||
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
      'clode/providers');
}

// Any provider binary this box holds for version `v`. The store is keyed by
// version x platform x arch since spec 2026-09-14 §7.1 (providers/<ver>/<os>-<arch>/claude);
// a store that has not been read since the change may still hold the old version-only entry,
// so both shapes are looked for. These goldens are of the CARVED JS, which is per-platform,
// and the golden file records which carve each sha came from -- so returning the first entry
// found is right here, and a mismatch shows up as a sha mismatch rather than a wrong pass.
function providerBin(v) {
  const legacy = path.join(providersDir(), v, 'claude');
  if (fs.existsSync(legacy)) return legacy;
  let keys = [];
  try {
    keys = fs.readdirSync(path.join(providersDir(), v), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return null; }
  for (const k of keys) {
    const p = path.join(providersDir(), v, k, 'claude');
    if (fs.existsSync(p)) return p;
  }
  return null;
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
