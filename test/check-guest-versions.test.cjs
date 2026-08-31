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

// The general watcher must cover every VM leg — this is what makes a bespoke
// per-platform watcher unnecessary, and it is why scripts/haiku-image-watch.mjs was
// retired on 2026-08-31 rather than re-pointed. That script hardcoded an image literal
// (`/r1beta5/i`), so when the haiku-x64 leg was pinned to r1beta6 on 2026-08-27 the
// watcher kept reporting "a newer image appeared" — about the very image we had already
// adopted — and failed upstream-drift daily for four days. This checker asks the same
// question of the same catalog, but against the PIN, so it cannot go stale that way.
test('every VM leg in the ci tier is covered by the checker (no leg needs a bespoke watcher)', async () => {
  const { isVmLeg } = mod;
  const { legsFor } = require('../scripts/tjs-legs.mjs');
  const ci = legsFor('ci');
  // A guest-platform that is not the host and not the static-output alpine builder is a
  // real guest image with a catalog behind it.
  const guests = ci.filter((l) => l['guest-platform'] && !['native', 'alpine'].includes(l['guest-platform']));
  assert.ok(guests.length > 3, `expected several VM legs in ci, found ${guests.length}`);
  for (const l of guests) {
    assert.ok(isVmLeg(l), `${l.leg} has guest-platform '${l['guest-platform']}' but the checker skips it`);
  }
  // haiku by name: the leg that used to carry its own watcher.
  const haiku = ci.find((l) => l.leg === 'haiku-x64');
  assert.ok(haiku, 'haiku-x64 must be in the ci tier for the general checker to see it');
  assert.ok(isVmLeg(haiku), 'haiku-x64 must be covered by the general checker');
});
