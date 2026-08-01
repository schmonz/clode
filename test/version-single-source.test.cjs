'use strict';
// The version is ONE fact stored in FOUR places: VERSION, package.json, and
// package-lock.json twice (the lockfile repeats it for the root package entry).
// Every release bumps all four BY HAND. Nothing asserted they agree, so three of
// them could silently drift and the failure would surface as an npm-side version
// that disagrees with the binary a user is running.
//
// The lesson is borrowed from the ModernMavericks family conventions ("derive,
// never repeat, anything computable from a pin" — there VERSION is a build product
// and a tracked one FAILS the conventions check). We keep VERSION committed because
// clode's date-versioning is chosen by a human, not computed; so instead of deriving,
// we assert. Same destination, one fact, enforced.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('VERSION, package.json and package-lock.json all state the same version', () => {
  const version = read('VERSION').trim();
  assert.match(version, /^\d+\.\d{8}\.\d+$/,
    `VERSION must be date-versioned (0.YYYYMMDD.N), got "${version}"`);

  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.version, version, 'package.json version disagrees with VERSION');

  const lock = JSON.parse(read('package-lock.json'));
  assert.strictEqual(lock.version, version, 'package-lock.json top-level version disagrees with VERSION');
  assert.strictEqual(lock.packages[''].version, version,
    'package-lock.json packages[""].version disagrees with VERSION — npm writes the root package entry too, and it is the copy most often forgotten');
});

test('the changelog has an entry for the current version', () => {
  const version = read('VERSION').trim();
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes(`## ${version}`),
    `CHANGELOG.md has no "## ${version}" section — release notes are cut from it via --notes-file, so a missing entry ships an empty release`);
});
