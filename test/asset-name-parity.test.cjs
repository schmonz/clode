'use strict';
// The published builder asset name is minted in THREE places that must never drift:
//   1. build-leg/action.yml's bash (CI) — now `node scripts/canonical-name.cjs asset ...`
//   2. scripts/canonical-name.cjs assetName() — the source of truth
//   3. build-templates-manifest.mjs deriveTag() — the `--list-targets` tag
// The whole naming rationalization rests on: download name == `--list-targets` tag ==
// the engine a fetching clode looks for. This locks that across the FULL leg set + the
// CLI the CI bash consumes.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const C = require('../scripts/canonical-name.cjs');
const { legsFor } = require('../scripts/tjs-legs.mjs');
const { deriveTag } = require('../scripts/build-templates-manifest.mjs');

function cliAsset(leg, version, floor) {
  return execFileSync(process.execPath,
    [path.join(REPO, 'scripts', 'canonical-name.cjs'), 'asset', leg, version, floor || ''],
    { encoding: 'utf8' }).trim();
}

test('the canonical-name CLI (the CI bash mirror) matches assetName() exactly', () => {
  for (const [leg, floor] of [
    ['darwin-arm64', '11.0'], ['darwin-x64', '10.6'], ['netbsd-macppc', '10.1'],
    ['linux-x64-musl', ''], ['windows-arm64', ''], ['haiku-x64', 'r1beta5'],
  ]) {
    assert.strictEqual(cliAsset(leg, '9.9.9', floor), C.assetName(leg, '9.9.9', floor),
      `CLI vs assetName drift for ${leg} floor=${floor}`);
  }
});

test('the CLI fails LOUD (exit 2) on a bad command, so a `set -e` CI step halts', () => {
  assert.throws(() => execFileSync(process.execPath,
    [path.join(REPO, 'scripts', 'canonical-name.cjs'), 'bogus'], { stdio: 'pipe' }));
});

test('every release leg: asset name == clode-<v>-<deriveTag> (download == --list-targets tag)', () => {
  const mism = [];
  for (const leg of legsFor('release')) {
    const asset = C.assetName(leg.leg, '9.9.9', leg.floor);
    const tag = deriveTag(leg);            // the --list-targets tag (from the leg TOKEN)
    const ext = C.canonOs(C.splitLeg(leg.leg).os) === 'windows' ? '.exe' : ''; // windows PE suffix
    if (asset !== `clode-9.9.9-${tag}${ext}`) mism.push(`${leg.leg}: asset=${asset} tag=${tag}`);
  }
  assert.deepStrictEqual(mism, [], `asset-name vs --list-targets-tag drift:\n${mism.join('\n')}`);
});
