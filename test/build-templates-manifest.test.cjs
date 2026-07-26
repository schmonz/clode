'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildManifest, cleanTargetName, deriveVerified, deriveTag,
  tjsPinFromPins, manifestTargets, collectInputs,
} = require('../scripts/build-templates-manifest.mjs');

test('buildManifest computes sha256 + shape from engine files', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  fs.writeFileSync(path.join(d, 'tjs-linux-x64-11'), 'LX');
  const inputs = [{ name: 'linux-x64', tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-11', file: path.join(d, 'tjs-linux-x64-11'), verified: 'smoke' }];
  const m = buildManifest({ tjsPin: 'v26.6.0-1a230d3', inputs });
  assert.strictEqual(m.schema, 1);
  assert.strictEqual(m.tjsPin, 'v26.6.0-1a230d3');
  assert.strictEqual(m.targets['linux-x64'].tag, 'linux-glibc2.28-x64');
  assert.strictEqual(m.targets['linux-x64'].engine, 'tjs-linux-x64-11');
  assert.strictEqual(m.targets['linux-x64'].verified, 'smoke');
  assert.strictEqual(m.targets['linux-x64'].sha256,
    crypto.createHash('sha256').update('LX').digest('hex'));
});

test('buildManifest defaults verified to "unknown"', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2-'));
  fs.writeFileSync(path.join(d, 'e'), 'x');
  const m = buildManifest({ tjsPin: 'p', inputs: [{ name: 'y', tag: 't', engine: 'e', file: path.join(d, 'e') }] });
  assert.strictEqual(m.targets['y'].verified, 'unknown');
});

// --- CI aggregator: leg -> manifest-input derivation (from tjs-legs.mjs) ---

test('cleanTargetName strips only the -musl/-glibc libc suffix', () => {
  assert.strictEqual(cleanTargetName('linux-x64-musl'), 'linux-x64');
  assert.strictEqual(cleanTargetName('linux-x64-glibc'), 'linux-x64');
  assert.strictEqual(cleanTargetName('netbsd-amd64'), 'netbsd-amd64');   // untouched
  assert.strictEqual(cleanTargetName('netbsd-sparc64'), 'netbsd-sparc64'); // not a libc suffix
});

test('deriveVerified maps leg exec-fidelity to a trust level', () => {
  assert.strictEqual(deriveVerified({ smoke: 'full' }), 'smoke');           // built + ran product
  assert.strictEqual(deriveVerified({ smoke: 'version' }), 'version');      // booted, --version only
  assert.strictEqual(deriveVerified({ 'no-exec': true, smoke: 'full' }), 'attest-only'); // never executed
  assert.strictEqual(deriveVerified({ 'soft-fail': true }), 'emulated');    // ran under emulation, may flake
  assert.strictEqual(deriveVerified({}), 'smoke');                          // default: full smoke
});

test('deriveTag builds a platform-floor-arch display tag', () => {
  assert.strictEqual(deriveTag({ leg: 'linux-x64-musl', 'guest-platform': 'alpine', 'guest-arch': 'x86_64' }), 'linux-x86_64');
  assert.strictEqual(deriveTag({ leg: 'netbsd-amd64', 'guest-platform': 'netbsd', floor: '10.1' }), 'netbsd-10.1-amd64');
  assert.strictEqual(deriveTag({ leg: 'netbsd-m68k', 'guest-platform': 'native', 'guest-arch': 'm68k', floor: '10.1' }), 'netbsd-10.1-m68k');
  assert.strictEqual(deriveTag({ leg: 'windows-x64', 'guest-platform': 'native' }), 'windows-x64');
  assert.strictEqual(deriveTag({ leg: 'netbsd-sparc', 'guest-platform': 'qemu-netbsd-sparc', 'guest-arch': 'sparc', floor: '10.1' }), 'netbsd-10.1-sparc');
});

test('tjsPinFromPins derives vVERSION-sha7 (matches clode thisTjsPin format)', () => {
  const pins = 'quickjs-ng v0.15.1 fd0a021 2026\ntxiki.js v26.6.0 1a230d31183f062fae7a6c4fd2cff466cecc1787 2026-07-06\n';
  assert.strictEqual(tjsPinFromPins(pins), 'v26.6.0-1a230d3');
  assert.strictEqual(tjsPinFromPins('no txiki here'), null);
});

test('manifestTargets(release) = the publish:true legs, indexed by leg name', () => {
  const t = manifestTargets('release');
  assert.ok(t['linux-x64-musl'], 'a published musl leg is a target');
  assert.ok(t['netbsd-m68k'], 'a no-exec cross leg is still a target');
  assert.ok(!t['linux-x64-glibc'], 'the validation-twin glibc leg is NOT a target');
  assert.strictEqual(t['linux-x64-musl'].publish, true);
});

test('collectInputs maps downloaded tjs-<leg>/ engine dirs to manifest inputs', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  // Simulate `actions/download-artifact` (no name): one subdir per artifact.
  fs.mkdirSync(path.join(d, 'tjs-linux-x64-musl'));
  fs.writeFileSync(path.join(d, 'tjs-linux-x64-musl', 'tjs'), 'LXENGINE');
  fs.mkdirSync(path.join(d, 'tjs-netbsd-m68k'));
  fs.writeFileSync(path.join(d, 'tjs-netbsd-m68k', 'tjs'), 'M68KENGINE');
  fs.mkdirSync(path.join(d, 'tjs-linux-x64-glibc'));            // validation twin: present but NOT a target
  fs.writeFileSync(path.join(d, 'tjs-linux-x64-glibc', 'tjs'), 'GLIBC');
  fs.mkdirSync(path.join(d, 'clode-1.2.3-linux-x64-musl'));     // a builder artifact: ignored (not tjs-*)
  fs.writeFileSync(path.join(d, 'clode-1.2.3-linux-x64-musl', 'x'), 'B');

  const { inputs, skipped } = collectInputs(d, manifestTargets('release'), 'v26.6.0-1a230d3');
  const byName = Object.fromEntries(inputs.map((i) => [i.name, i]));

  assert.ok(byName['linux-x64'], 'musl leg -> linux-x64 target');
  assert.strictEqual(byName['linux-x64'].engine, 'tjs-linux-x64-v26.6.0-1a230d3'); // pin-versioned pack name
  assert.strictEqual(byName['linux-x64'].verified, 'smoke');
  assert.strictEqual(fs.readFileSync(byName['linux-x64'].file).toString(), 'LXENGINE');

  assert.ok(byName['netbsd-m68k'], 'no-exec cross leg is a target');
  assert.strictEqual(byName['netbsd-m68k'].verified, 'attest-only');

  assert.ok(!byName['linux-x64-glibc'] && skipped.includes('linux-x64-glibc'),
    'the glibc validation twin is skipped, not a target');
});

test('collectInputs feeds buildManifest end-to-end', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agg2-'));
  fs.mkdirSync(path.join(d, 'tjs-netbsd-amd64'));
  fs.writeFileSync(path.join(d, 'tjs-netbsd-amd64', 'tjs'), 'NB');
  const { inputs } = collectInputs(d, manifestTargets('release'), 'v26.6.0-1a230d3');
  const m = buildManifest({ tjsPin: 'v26.6.0-1a230d3', inputs });
  assert.strictEqual(m.targets['netbsd-amd64'].tag, 'netbsd-10.1-amd64');
  assert.strictEqual(m.targets['netbsd-amd64'].engine, 'tjs-netbsd-amd64-v26.6.0-1a230d3');
  assert.strictEqual(m.targets['netbsd-amd64'].sha256,
    crypto.createHash('sha256').update('NB').digest('hex'));
});
