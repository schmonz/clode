'use strict';
// Pure-logic rows for scripts/check-guest-versions.mjs — the weekly catalog
// watcher (Renovate cannot do this job: cpa publishes OS images as release
// ASSETS of the *-builder repos, and vmactions versions are conf filenames —
// no datasource reads either). The checker compares the manifest's
// newest-end pins against the live catalogs and fails loudly on drift.
const test = require('node:test');
const assert = require('node:assert');

let mod;
test.before(async () => { mod = await import('../scripts/check-guest-versions.mjs'); });

test('cmpVersions orders the catalog formats we actually see', () => {
  const { cmpVersions } = mod;
  assert.ok(cmpVersions('7.9', '7.10') < 0, 'numeric segments, not lexicographic');
  assert.ok(cmpVersions('10.1', '9.4') > 0);
  assert.ok(cmpVersions('r151056', 'r151058') < 0);
  assert.ok(cmpVersions('202510-build', '202604-build') < 0);
  assert.ok(cmpVersions('6.4.2', '6.4.2') === 0);
  assert.ok(cmpVersions('r1beta5', 'r1beta5') === 0);
  assert.ok(cmpVersions('14.4', '15.1') < 0);
});

test('drift: newer catalog version than the pin is reported; equal/older is not', () => {
  const { drift } = mod;
  assert.deepStrictEqual(
    drift('freebsd-amd64', '15.1', ['13.5', '14.4', '15.1']),
    null, 'pin at catalog max: no drift');
  assert.match(
    drift('freebsd-amd64', '14.4', ['13.5', '14.4', '15.1']) ?? '',
    /15\.1/, 'newer available: report it');
  assert.match(
    drift('netbsd-amd64', '10.2', ['9.2', '10.0', '10.1']) ?? '',
    /not in catalog/, 'pin missing from catalog (image pulled or typo): loud');
});
