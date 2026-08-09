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
  const m = buildManifest({ tjsPin: '26.6.0-1a230d3', inputs });
  assert.strictEqual(m.schema, 1);
  assert.strictEqual(m.tjsPin, '26.6.0-1a230d3');
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

test('cleanTargetName drops the libc suffix AND canonicalizes os/arch', () => {
  assert.strictEqual(cleanTargetName('linux-x64-musl'), 'linux-amd64');
  assert.strictEqual(cleanTargetName('linux-x64-glibc'), 'linux-amd64');
  assert.strictEqual(cleanTargetName('darwin-arm64'), 'macos-arm64');    // darwin -> macos
  assert.strictEqual(cleanTargetName('netbsd-amd64'), 'netbsd-amd64');   // already canonical
  assert.strictEqual(cleanTargetName('netbsd-macppc'), 'netbsd-ppc');    // port name -> arch
  assert.strictEqual(cleanTargetName('netbsd-sparc64'), 'netbsd-sparc64'); // not a libc suffix
});

test('deriveVerified maps leg exec-fidelity to a trust level', () => {
  assert.strictEqual(deriveVerified({ smoke: 'full' }), 'smoke');           // built + ran product
  assert.strictEqual(deriveVerified({ smoke: 'version' }), 'version');      // booted, --version only
  assert.strictEqual(deriveVerified({ 'no-exec': true, smoke: 'full' }), 'attest-only'); // never executed
  assert.strictEqual(deriveVerified({ 'soft-fail': true }), 'emulated');    // ran under emulation, may flake
  assert.strictEqual(deriveVerified({ pack: true, publish: false }), 'attest-only'); // pack-only engine (darwin slice): product never fused+run in CI
  assert.strictEqual(deriveVerified({}), 'smoke');                          // default: full smoke
});

test('deriveTag == the published asset name tag (canonical os/arch, dashed floor, from the LEG TOKEN)', () => {
  // Derived from leg.leg + leg.floor ONLY; guest-arch/guest-platform (native spellings
  // like x86_64) are deliberately ignored so the tag stays canonical and == the download.
  assert.strictEqual(deriveTag({ leg: 'linux-x64-musl', 'guest-arch': 'x86_64' }), 'linux-amd64-musl');
  assert.strictEqual(deriveTag({ leg: 'netbsd-amd64', floor: '10.1' }), 'netbsd-10.1-amd64');
  assert.strictEqual(deriveTag({ leg: 'netbsd-m68k', floor: '10.1' }), 'netbsd-10.1-m68k');
  assert.strictEqual(deriveTag({ leg: 'windows-amd64' }), 'windows-amd64');
  // Our leg ids are canonical now, but deriveTag must still normalize a RAW
  // vendor token — that is canonical-name's whole job, and dropping it would
  // break any external string that still says x64.
  assert.strictEqual(deriveTag({ leg: 'windows-x64' }), 'windows-amd64');
  assert.strictEqual(deriveTag({ leg: 'netbsd-sparc', floor: '10.1' }), 'netbsd-10.1-sparc');
  assert.strictEqual(deriveTag({ leg: 'netbsd-macppc', floor: '10.1' }), 'netbsd-10.1-ppc'); // port name -> arch
  assert.strictEqual(deriveTag({ leg: 'darwin-x64', floor: '10.6' }), 'macos-10.6-amd64');   // darwin -> macos
});

test('tjsPinFromPins derives <ver>-<sha7> with NO leading v (matches thisTjsPin + bakedTjsPin)', () => {
  const pins = 'quickjs-ng v0.15.1 fd0a021 2026\ntxiki.js v26.6.0 1a230d31183f062fae7a6c4fd2cff466cecc1787 2026-07-06\n';
  assert.strictEqual(tjsPinFromPins(pins), '26.6.0-1a230d3');
  // A future PINS.md that already drops the v must derive identically.
  assert.strictEqual(tjsPinFromPins('txiki.js 27.0.0 abcdef01234 2026'), '27.0.0-abcdef0');
  assert.strictEqual(tjsPinFromPins('no txiki here'), null);
});

test('manifestTargets(release) = the publish:true OR pack:true legs, indexed by leg name', () => {
  const t = manifestTargets('release');
  assert.ok(t['linux-x64-musl'], 'a published musl leg is a target');
  assert.ok(t['netbsd-m68k'], 'a no-exec cross leg is still a target');
  // The darwin slices ship their builder via the universal binary (publish:false)
  // but their pre-signed engines ARE first-class cross-build --targets (pack:true).
  assert.ok(t['darwin-arm64'], 'a pack-only darwin slice is a cross-build target');
  assert.ok(t['darwin-ppc'], 'the darwin ppc slice is a cross-build target');
  assert.ok(!t['linux-x64-glibc'], 'the validation-twin glibc leg is NOT a target');
  assert.strictEqual(t['linux-x64-musl'].publish, true);
  assert.strictEqual(t['darwin-arm64'].publish, false, 'darwin ships its builder via the universal, not a standalone asset');
  assert.strictEqual(t['darwin-arm64'].pack, true);
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

  const { inputs, skipped } = collectInputs(d, manifestTargets('release'), '26.6.0-1a230d3');
  const byName = Object.fromEntries(inputs.map((i) => [i.name, i]));

  assert.ok(byName['linux-amd64'], 'musl leg -> canonical linux-amd64 target');
  assert.strictEqual(byName['linux-amd64'].engine, 'tjs-linux-amd64-26.6.0-1a230d3'); // pin-versioned pack name
  assert.strictEqual(byName['linux-amd64'].verified, 'smoke');
  assert.strictEqual(fs.readFileSync(byName['linux-amd64'].file).toString(), 'LXENGINE');

  assert.ok(byName['netbsd-m68k'], 'no-exec cross leg is a target');
  assert.strictEqual(byName['netbsd-m68k'].verified, 'attest-only');

  assert.ok(!byName['linux-x64-glibc'] && skipped.includes('linux-x64-glibc'),
    'the glibc validation twin is skipped, not a target');
});

test('collectInputs feeds buildManifest end-to-end', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agg2-'));
  fs.mkdirSync(path.join(d, 'tjs-netbsd-amd64'));
  fs.writeFileSync(path.join(d, 'tjs-netbsd-amd64', 'tjs'), 'NB');
  const { inputs } = collectInputs(d, manifestTargets('release'), '26.6.0-1a230d3');
  const m = buildManifest({ tjsPin: '26.6.0-1a230d3', inputs });
  assert.strictEqual(m.targets['netbsd-amd64'].tag, 'netbsd-10.1-amd64');
  assert.strictEqual(m.targets['netbsd-amd64'].engine, 'tjs-netbsd-amd64-26.6.0-1a230d3');
  assert.strictEqual(m.targets['netbsd-amd64'].sha256,
    crypto.createHash('sha256').update('NB').digest('hex'));
});

test('buildManifest: compression is declared when set, absent otherwise; sha stays the DECOMPRESSED engine', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-'));
  fs.mkdirSync(path.join(d, 'tjs-netbsd-amd64'));
  fs.writeFileSync(path.join(d, 'tjs-netbsd-amd64', 'tjs'), 'ENGINE');
  const { inputs } = collectInputs(d, manifestTargets('release'), '26.6.0-1a230d3');
  const raw = buildManifest({ tjsPin: '26.6.0-1a230d3', inputs });
  assert.strictEqual(raw.compression, undefined, 'no compression field when unset (backward compatible)');
  const gz = buildManifest({ tjsPin: '26.6.0-1a230d3', inputs, compression: 'gzip' });
  assert.strictEqual(gz.compression, 'gzip');
  // sha256 is of the engine bytes themselves, independent of wire compression
  assert.strictEqual(gz.targets['netbsd-amd64'].sha256,
    crypto.createHash('sha256').update('ENGINE').digest('hex'));
});

// The engine asset name has ONE producer. build-templates-manifest used to spell
// `tjs-${name}-${pin}` inline while canonical-name.cjs exported engineName() doing
// the same thing — two implementations of one fact, byte-identical at the time and
// free to drift afterwards. This pins them together: if someone changes either the
// canonical vocabulary or the manifest's engine field, they must move as one.
// (Same lesson as the version bump surface: derive, never repeat.)
test('the manifest engine name comes from the canonical vocabulary, not a second spelling', async () => {
  const canon = require('../scripts/canonical-name.cjs');
  const pin = '26.6.0-1a230d3';
  for (const leg of ['darwin-arm64', 'darwin-ppc', 'linux-x64-musl', 'windows-amd64', 'cosmo']) {
    assert.strictEqual(canon.engineName('tjs', leg, pin), `tjs-${cleanTargetName(leg)}-${pin}`,
      `${leg}: engineName() and the manifest target name disagree`);
  }
  // And the manifest source must actually CALL it — a passing equality above would
  // otherwise be satisfied by two copies that merely happen to agree today.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/build-templates-manifest.mjs'), 'utf8');
  assert.match(src, /engine:\s*canon\.engineName\(/,
    'build-templates-manifest must call canon.engineName for the engine asset name');
  assert.doesNotMatch(src, /engine:\s*`tjs-\$\{/,
    'the inline tjs-${name}-${pin} spelling must not come back');
});

// --- Follow-up 5: blob packing (schema 2) ---------------------------------
// The builder side of test/templates-blob-pack.test.cjs, which covers the
// consumer side. Kept here because packBlob/buildManifest live in this module.
test('packBlob concatenates gzip members and records tiling offsets; buildManifest emits schema 2', async () => {
  const { packBlob, buildManifest } = await import('../scripts/build-templates-manifest.mjs');
  const zlib = require('node:zlib');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-packblob-'));
  const mk = (n, body) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, body);
    return { name: n, tag: n, engine: `tjs-${n}-PIN`, file: f, verified: 'smoke' };
  };
  // Deliberately NOT in sorted order, to prove packBlob sorts for determinism.
  const inputs = [
    mk('zeta', Buffer.from('Z'.repeat(500))),
    mk('alpha', Buffer.from('A'.repeat(300))),
  ];

  const { blob, slices } = packBlob(inputs);
  assert.strictEqual(slices.alpha.offset, 0, 'sorted order => alpha first');
  assert.strictEqual(slices.zeta.offset, slices.alpha.length);
  assert.strictEqual(blob.length, slices.alpha.length + slices.zeta.length);
  for (const it of inputs) {
    const s = slices[it.name];
    assert.deepStrictEqual(zlib.gunzipSync(blob.subarray(s.offset, s.offset + s.length)),
      fs.readFileSync(it.file), `${it.name} slice must inflate to its own engine`);
  }

  // Byte-identical on a re-run: a churning blob would invalidate every recorded
  // offset and force a pointless re-upload.
  assert.deepStrictEqual(packBlob(inputs).blob, blob, 'packBlob must be deterministic');

  const m = buildManifest({ tjsPin: 'PIN', inputs, compression: 'gzip', blob: 'templates-PIN', slices });
  assert.strictEqual(m.schema, 2);
  assert.strictEqual(m.blob, 'templates-PIN');
  assert.strictEqual(m.targets.alpha.offset, 0);
  assert.strictEqual(m.targets.zeta.length, slices.zeta.length);
});

test('buildManifest refuses a blob pack with a target missing its slice', async () => {
  const { buildManifest } = await import('../scripts/build-templates-manifest.mjs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-packblob2-'));
  const f = path.join(dir, 'e');
  fs.writeFileSync(f, 'x');
  const inputs = [{ name: 'solo', tag: 't', engine: 'tjs-solo-PIN', file: f, verified: 'smoke' }];
  assert.throws(
    () => buildManifest({ tjsPin: 'PIN', inputs, blob: 'templates-PIN', slices: {} }),
    /missing a slice for target 'solo'/);
});

test('buildManifest without a blob still emits schema 1 (no offsets leak in)', async () => {
  const { buildManifest } = await import('../scripts/build-templates-manifest.mjs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-packblob3-'));
  const f = path.join(dir, 'e');
  fs.writeFileSync(f, 'x');
  const m = buildManifest({
    tjsPin: 'PIN',
    inputs: [{ name: 'solo', tag: 't', engine: 'tjs-solo-PIN', file: f, verified: 'smoke' }],
  });
  assert.strictEqual(m.schema, 1);
  assert.ok(!('blob' in m));
  assert.ok(!('offset' in m.targets.solo));
});
