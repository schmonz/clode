'use strict';
// Ties release.yml's REQUIRED asset globs to the names scripts/canonical-name.cjs
// ACTUALLY produces.
//
// WHY THIS EXISTS. On 2026-08-01 the v0.20260801.1 release run went 48/48 green
// and then refused to publish: the gate looked for `clode-*-windows*-arm64`
// while windows-arm64 had uploaded `clode-0.20260801.1-windows-arm64.exe`. The
// `.exe` arrived with the canonical-vocabulary refactor (b63233b), which moved
// the per-OS runnable extension into canonical-name.cjs — correctly — but the
// gate's hand-written glob list was never updated to match, and nothing tied
// them together. CI could not catch it: the gate runs ONLY in the release tier,
// so its first execution is the release itself.
//
// That is the expensive shape this repo keeps naming: two hand-maintained lists
// that must agree, with no assertion that they do. The fix is not "remember to
// update the globs" — it is this test. Per
// [[ratchet-noticed-and-fixed-earlier]]: the mechanism that would have made it
// so easy to notice it would have been noticed before.
//
// WHAT IT DOES NOT DO: it does not re-implement globbing or read dist/. It
// asserts the narrower, load-bearing property — that each REQUIRED glob matches
// the real asset name for at least one currently-published leg. A glob that
// matches nothing we ship is exactly the failure that blocked the release.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { execFileSync } = require('node:child_process');

const canon = require('../scripts/canonical-name.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const RELEASE_YML = path.join(REPO, '.github/workflows/release.yml');

// tjs-legs.mjs is ESM with a JSON-emitting CLI; drive it the same way
// test/tjs-legs.test.cjs does rather than inventing a second access path.
// 'release' is the correct tier here — it is the tier the gate runs in.
const legsFor = (tier, only) => JSON.parse(execFileSync(process.execPath,
  [path.join(REPO, 'scripts', 'tjs-legs.mjs'), tier, ...(only ? [only] : [])],
  { encoding: 'utf8' }));

// Parse the REQUIRED="..." line out of the workflow rather than duplicating it
// here — duplicating is the very thing that caused the outage.
function requiredGlobs() {
  const text = fs.readFileSync(RELEASE_YML, 'utf8');
  const m = text.match(/^\s*REQUIRED="([^"]+)"/m);
  assert.ok(m, 'could not find the REQUIRED="..." asset-glob line in release.yml');
  return m[1].trim().split(/\s+/).filter(Boolean);
}

// Minimal shell-glob -> RegExp. Only `*` is used in these globs; anything else
// is treated literally. Deliberately strict: if a future glob starts using `?`
// or brackets, this throws rather than silently mismatching.
function globToRegExp(glob) {
  assert.ok(!/[?[\]{}]/.test(glob),
    `glob "${glob}" uses a metacharacter this test does not model; extend globToRegExp`);
  const body = glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

// The darwin slices are a SEPARATE job (`only:darwin`) so the universal lipo can
// depend on just them, so they do not appear in the default release listing.
// Missing that is how a first draft of this test "proved" the macos glob broken.
function publishedLegs() {
  const main = legsFor('release');
  const darwin = legsFor('release', 'darwin');
  assert.ok(main.length && darwin.length,
    'could not read the leg lists from scripts/tjs-legs.mjs');
  const seen = new Set();
  return [...main, ...darwin].filter((l) => {
    if (!l.publish || seen.has(l.leg)) return false;
    seen.add(l.leg);
    return true;
  });
}

// The four-arch macOS Universal binary is NOT any single leg's asset — it is
// lipo'd from the four darwin slices and named by a hardcoded string in
// release.yml ("asset=clode-$V-macos"). Parse that line rather than restating
// it, for the same reason the globs are parsed: a copy is what rots.
function extraAssetNames(version) {
  const text = fs.readFileSync(RELEASE_YML, 'utf8');
  const out = [];
  for (const m of text.matchAll(/asset=(clode-[^"'\s]+)/g)) {
    out.push(m[1].replace(/\$\{?V\}?/g, version));
  }
  assert.ok(out.length, 'no `asset=clode-...` line found in release.yml');
  return out;
}

// Every asset name the release could plausibly produce, at a representative
// version. Floors matter (netbsd-sparc ships as netbsd<floor>-sparc), so ask
// canonical-name for both the floored and unfloored spelling when a leg
// declares a floor.
function assetNamesFor(leg, version) {
  const out = new Set([canon.assetName(leg.leg, version)]);
  if (leg.floor) out.add(canon.assetName(leg.leg, version, leg.floor));
  return [...out];
}

// PURE: everything scan() needs (the legs, the required globs, the extra
// hardcoded asset names) is gathered by read() below; scan() only compares.
//
// `examined` counts GLOB checks only (see the floor comment on the guard below) — the
// leg-count sanity check is a separate finding, not folded into that count, so it does
// not change what "just under the real glob count" means.
function scanReleaseGlobs({ version, legs, globs, extraNames }) {
  const findings = [];
  let examined = 0;

  // Coordinator fix round 1: this used to be `assert.ok(...)` INSIDE read() — a fact
  // about the I/O half throwing instead of reporting, indistinguishable from a real
  // node crash. A leg-discovery break (scripts/tjs-legs.mjs) is exactly the kind of
  // thing this guard exists to notice; it must be a named finding, not an uncaught
  // exception with a stack trace nobody reads as "the gate said something."
  if (legs.length <= 10) {
    findings.push(`expected many published legs, got ${legs.length} — `
      + 'scripts/tjs-legs.mjs\'s leg discovery may be broken');
  }

  const allNames = [
    ...legs.flatMap((l) => assetNamesFor(l, version)),
    ...extraNames,
  ];
  for (const glob of globs) {
    examined++;
    const re = globToRegExp(glob);
    const hits = allNames.filter((n) => re.test(n));
    if (hits.length === 0) {
      findings.push(`release.yml REQUIRED glob "${glob}" matches NO asset this release produces `
        + `(candidates: ${allNames.filter((n) => n.includes(glob.replace(/\*/g, '').slice(0, 12))).slice(0, 8).join(', ')})`);
    }
  }
  return { findings, examined };
}

const releaseGlobsGuard = defineGuard({
  name: 'release-gate-globs',
  // `examined` is the count of REQUIRED globs parsed out of release.yml (currently 3);
  // floor 2 (one under) fires the moment the parser silently finds fewer than it should
  // — the coordinator's example verbatim: "a parser that finds 1 of 3 still passes" is
  // no longer true once this floor can fire.
  floor: 2,
  read: () => {
    const legs = publishedLegs();
    const version = '0.20260801.1';
    return { version, legs, globs: requiredGlobs(), extraNames: extraAssetNames(version) };
  },
  scan: scanReleaseGlobs,
  // This is the EXACT failure that blocked v0.20260801.1: all jobs green,
  // release refused because a required glob matched nothing real.
  control: () => ({
    version: '0.20260801.1',
    legs: [{ leg: 'linux-x64', publish: true }],
    globs: ['clode-*-totally-bogus-platform-*'],
    extraNames: [],
  }),
});
guardTests(releaseGlobsGuard);

// The specific regression, pinned by name so the reason is unmissable in a diff.
test('the windows-arm64 asset carries .exe and the gate still matches it', () => {
  const name = canon.assetName('windows-arm64', '0.20260801.1');
  assert.match(name, /\.exe$/,
    'canonical-name no longer appends .exe to windows assets — if that is deliberate,'
    + ' the release.yml globs and this test both need updating together');

  const globs = requiredGlobs();
  const winGlob = globs.find((g) => g.includes('windows'));
  assert.ok(winGlob, 'release.yml no longer requires a windows asset');
  assert.ok(globToRegExp(winGlob).test(name),
    `release.yml glob "${winGlob}" does not match the real asset name "${name}"`);
});

// Cosmo ships `.com` by the same mechanism. It is not in REQUIRED today, but if
// it is ever added, an extensionless glob would fail exactly as windows did.
test('a cosmo glob, if ever required, would have to tolerate the .com extension', () => {
  const name = canon.assetName('cosmo', '0.20260801.1');
  assert.match(name, /\.com$/, 'cosmo asset no longer ends in .com');

  const cosmoGlob = requiredGlobs().find((g) => g.includes('cosmo'));
  if (!cosmoGlob) return; // not required today — nothing to assert
  assert.ok(globToRegExp(cosmoGlob).test(name),
    `release.yml glob "${cosmoGlob}" does not match the real cosmo asset "${name}"`);
});

// The tag must gate on the same evidence main does.
//
// ci.yml has no tag trigger, so tagging never runs the unit/fidelity suite; and
// ci.yml cancels superseded main runs, so a commit can reach a tag with no
// completed run of its own. Before 2026-08-01 that left a tag gated by build +
// smoke + be-oracle and nothing else — which is how a hermeticity violation in
// 6bd9088 (run cancelled by supersession) came within one bot push of shipping.
// release.yml therefore runs the full suite itself, and `release` needs it.
// Asserted here so removing that dependency is a deliberate, visible edit.
test('the release job gates on the full suite, and both workflows share ONE definition', () => {
  const text = fs.readFileSync(RELEASE_YML, 'utf8');
  const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const suite = fs.readFileSync(path.join(REPO, '.github/workflows/suite.yml'), 'utf8');

  // The shared definition is the only place `npm test` is spelled out.
  assert.match(suite, /run: npm test/,
    'suite.yml no longer runs `npm test` — the shared definition is empty');
  assert.match(suite, /workflow_call/,
    'suite.yml is no longer a reusable workflow, so nothing can call it');

  // Both callers must USE it rather than restating it. A hand-mirrored copy is
  // the exact shape that produced the release-gate `.exe` bug and the
  // SHA256SUMS blob omission on 2026-08-01.
  const REF = /uses:\s*\.\/\.github\/workflows\/suite\.yml/;
  assert.match(text, REF, 'release.yml no longer calls the shared suite workflow');
  assert.match(ci, REF, 'ci.yml no longer calls the shared suite workflow');
  for (const [name, src] of [['release.yml', text], ['ci.yml', ci]]) {
    assert.ok(!/run: npm test/.test(src),
      `${name} spells out \`npm test\` itself — that is a second definition of the `
      + 'suite and will drift from suite.yml; call the reusable workflow instead');
  }

  // ...and the tag must actually depend on it, or the gate is decorative.
  const needs = text.match(/^\s{2}release:\n\s+needs:\s*\[([^\]]+)\]/m);
  assert.ok(needs, 'could not read the release job\'s needs: list');
  const list = needs[1].split(',').map((s) => s.trim());
  assert.ok(list.includes('suite'),
    `release must need the suite job so a tag cannot publish untested; needs = ${JSON.stringify(list)}`);
});
