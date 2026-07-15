const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, runClode, REPO } = require('./e2e.cjs');

// Repo-file single-source-of-truth checks + one launcher --clode-version case.
// The VERSION file, package.json, and LICENSE are read straight from REPO (no
// subprocess); only the --clode-version reporting is exercised through the launcher.

test('clode --clode-version reports the shipped VERSION', (t) => {
  const sbx = sandbox(t);
  const r = runClode(sbx, ['--clode-version']);
  assert.strictEqual(r.status, 0);
  const version = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  assert.strictEqual(r.output.trim(), `clode ${version}`);
});

test('package.json version matches the VERSION file', () => {
  // Single source of truth: npm needs a version in package.json; the launcher + dist
  // read the VERSION file. A mismatch means a release would disagree with itself.
  const pkgver = require(path.join(REPO, 'package.json')).version;
  const version = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  assert.strictEqual(pkgver, version);
});

test('VERSION is a valid semver and LICENSE is BSD-2-Clause', () => {
  // Don't hardcode the number (it broke silently on the 0.1.3 bump); the exact
  // value is covered by the --clode-version + package.json-matches tests above.
  const version = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, `VERSION '${version}' must be x.y.z`);
  const license = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
  assert.match(license, /BSD 2-Clause|Redistribution and use/i);
});
