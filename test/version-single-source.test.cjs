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
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// PURE: every finding is derived from the four inputs, never re-read from disk.
function scanVersionSources({ version, pkg, lock, changelog }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/^\d+\.\d{8}\.\d+$/.test(version)) {
    findings.push(`VERSION must be date-versioned (0.YYYYMMDD.N), got "${version}"`);
  }

  examined++;
  if (pkg.version !== version) {
    findings.push(`package.json version (${pkg.version}) disagrees with VERSION (${version})`);
  }

  examined++;
  if (lock.version !== version) {
    findings.push(`package-lock.json top-level version (${lock.version}) disagrees with VERSION (${version})`);
  }

  examined++;
  if (lock.packages[''].version !== version) {
    findings.push(`package-lock.json packages[''].version (${lock.packages[''].version}) disagrees `
      + `with VERSION (${version}) — npm writes the root package entry too, and it is the copy `
      + 'most often forgotten');
  }

  examined++;
  if (!changelog.includes(`## ${version}`)) {
    findings.push(`CHANGELOG.md has no "## ${version}" section — release notes are cut from it via `
      + '--notes-file, so a missing entry ships an empty release');
  }

  return { findings, examined };
}

const guard = defineGuard({
  name: 'version-single-source',
  read: () => ({
    version: read('VERSION').trim(),
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    changelog: read('CHANGELOG.md'),
  }),
  scan: scanVersionSources,
  // Models the actual 2026-08-01-shaped drift: package.json bumped, everything
  // else left behind. Also exercises the changelog-missing and lock-mismatch
  // findings so a weakened scan of any one of the four cannot hide.
  control: () => ({
    version: '0.20260101.1',
    pkg: { version: '0.20260101.2' },
    lock: { version: '0.20260101.3', packages: { '': { version: '0.20260101.4' } } },
    changelog: '## 0.20259999.1\n',
  }),
});
guardTests(guard);
