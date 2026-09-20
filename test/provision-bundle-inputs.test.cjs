'use strict';
// scripts/provision-bundle-inputs.sh, offline. The ONLINE half — a genuinely cold vendor
// checkout completing --source-only with no npm and no node — is
// test/build-tjs-cold-provision.test.cjs; this file is everything that can be proven
// against fixtures, which is the derivation, the refusals, and the two known-answer tests.
//
// WHAT IS WORTH TESTING HERE, and it is not "it downloads". It is:
//   * that every pin is READ FROM THE PINNED CHECKOUT'S OWN package-lock.json, so no
//     version, URL or digest is written down in this repo where it could go stale. That
//     is the entire design, and a fixture with invented packages proves it: a script with
//     a hard-coded table cannot satisfy this file.
//   * that the base64->hex decoder and the sha512 tool are BOTH known-answer tested
//     before either verifies anything. Memory has two scars exactly here ("Host-tool
//     provisioning (fetch-verify origin)" — a silent pure-JS verify; "Instruments lie").
//   * that a digest mismatch REFUSES rather than shrugging. These bytes get bundled into
//     the engine.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SH = path.join(REPO, 'scripts', 'provision-bundle-inputs.sh');

// Same wall as test/bootstrap-engine.test.cjs: spawnSync('/bin/sh', ...) on win32 resolves
// to <drive>:\bin\sh and ENOENTs, and no Windows path reaches this script anyway (see the
// scope note in build-tjs.cjs's provisionBundleInputs).
const WIN = process.platform === 'win32';

function sh(args, env = {}) {
  return spawnSync('/bin/sh', [SH, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env } });
}

const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clode-provision-'));

// A checkout that is nothing but a lockfile, with INVENTED package names. A script
// carrying its own table of the real seven passes every other row in this file and fails
// this one, which is the point.
function fixture(entries) {
  const dir = mkdtemp();
  const packages = { '': { name: 'fixture' } };
  for (const [name, e] of Object.entries(entries)) packages[`node_modules/${name}`] = e;
  fs.writeFileSync(path.join(dir, 'package-lock.json'),
    `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }, null, 2)}\n`);
  return dir;
}

test('every pin is read from the checkout lockfile, not from a table in this repo', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const dir = fixture({
    'not-a-real-package': {
      version: '9.9.9',
      resolved: 'https://example.invalid/not-a-real-package-9.9.9.tgz',
      integrity: 'sha512-AAAA',
      // A nested object, because every real entry has one and a naive reader ends the
      // entry at its closing brace — which would silently drop `integrity` for exactly
      // the packages that have dependencies (@jridgewell/trace-mapping, @jsr/std__tar).
      dependencies: { 'also-invented': '^1.0.0' },
    },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = sh(['--plan', dir, 'not-a-real-package']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(),
    'plan not-a-real-package 9.9.9 https://example.invalid/not-a-real-package-9.9.9.tgz sha512-AAAA');
});

test('a name the lockfile does not carry is refused, never fetched unpinned', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const dir = fixture({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = sh([dir, 'web-streams-polyfill']);
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no complete entry for web-streams-polyfill/);
  assert.match(r.stderr, /unpinned fetch is not something this script will do/);
});

test('an integrity that is not sha512-<base64> is refused, not skipped', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const dir = fixture({
    legacy: { version: '1.0.0', resolved: 'https://example.invalid/x.tgz', integrity: 'sha1-abcdef' },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = sh([dir, 'legacy']);
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /not the sha512-<base64> this verifies/);
});

// THE KNOWN-ANSWER TEST, tested. CLODE_SHA512 is the override the script offers, so
// pointing it at a program that confidently prints the WRONG 128 hex digits is the exact
// shape of "the measuring device was wrong" — and the script must refuse to use it rather
// than verify a download with it.
test('a sha512 tool that fails its known-answer test is not used to verify anything', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const dir = fixture({
    x: { version: '1.0.0', resolved: 'https://example.invalid/x.tgz', integrity: `sha512-${'A'.repeat(86)}==` },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const liar = path.join(dir, 'liar');
  fs.writeFileSync(liar, `#!/bin/sh\nprintf '%s\\n' '${'0'.repeat(128)}'\n`);
  fs.chmodSync(liar, 0o755);
  const r = sh([dir, 'x'], { CLODE_SHA512: liar });
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /nothing on this host can verify a sha512/);
  assert.match(r.stderr, new RegExp(`${liar} -> ${'0'.repeat(128)}`),
    `the refusal must name the tool AND what it answered:\n${r.stderr}`);
});

// A digest mismatch must DELETE and refuse. Proven without a network by pre-seeding the
// tarball cache with the wrong bytes: the script re-verifies a cache hit for exactly this
// reason (bytes from somewhere else), so the file:// path is not needed to reach the check.
test('a cached tarball whose digest does not match the lockfile is discarded, not used', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const dir = fixture({
    bogus: {
      version: '1.0.0',
      resolved: 'https://example.invalid/bogus-1.0.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
    },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(cache, 'bundle-inputs'), { recursive: true });
  const tgz = path.join(cache, 'bundle-inputs', 'bogus-1.0.0.tgz');
  fs.writeFileSync(tgz, 'these are not the bytes the lockfile pins');
  const r = sh([dir, 'bogus'], { CLODE_CACHE: cache, CLODE_OFFLINE: '1' });
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /does not match the sha512 .* records — discarding and re-fetching/);
  assert.ok(!fs.existsSync(tgz), 'a tarball that failed its digest must not survive the run');
  // And with nothing to re-fetch from, it says THAT rather than proceeding.
  assert.match(r.stderr, /CLODE_OFFLINE=1 and bogus@1\.0\.0 is not in the\n\s*cache/);
});

// The one thing about this script that is not derived from the lockfile: which
// @esbuild/<os>-<arch> package THIS host wants. A wrong answer must be loud, never a
// silently-different platform's binary.
test('an unmapped host platform is named and refused, never guessed', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const dir = fixture({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakebin = path.join(dir, 'bin');
  fs.mkdirSync(fakebin);
  fs.writeFileSync(path.join(fakebin, 'uname'), '#!/bin/sh\nprintf "%s\\n" Plan9\n');
  fs.chmodSync(path.join(fakebin, 'uname'), 0o755);
  const r = sh([dir, 'esbuild'], { PATH: `${fakebin}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no esbuild platform package for Plan9/);
  assert.match(r.stderr, /set CLODE_ESBUILD/);
});

// The REAL checkout, planned but not fetched: this is the row that would go red if the
// pinned txiki commit ever stopped declaring one of the packages the gate derives from its
// own src/js/**, which is the one way this whole scheme can quietly stop working.
test('the real pinned checkout can pin every package the gate derives from it', (t) => {
  if (WIN) return t.skip('POSIX sh');
  const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');
  const { requiredPackages, ESBUILD_PIN } = require('../scripts/bundle-inputs-gate.cjs');
  const checkout = path.join(tjsVendorParentDir(), 'txiki.js');
  if (!fs.existsSync(path.join(checkout, 'package-lock.json'))) {
    return t.skip(`no vendor checkout at ${checkout} — run \`node scripts/build-tjs.cjs --source-only\` once`);
  }
  const names = [...requiredPackages(checkout).needed.keys()];
  assert.ok(names.length >= 7, `the derivation found only ${names.length} packages`);
  const r = sh(['--plan', checkout, 'esbuild', ...names]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const planned = r.stdout.trim().split('\n');
  assert.strictEqual(planned.length, names.length + 1,
    `every name must plan to exactly one pinned tarball:\n${r.stdout}`);
  for (const line of planned) {
    assert.match(line, /^plan \S+ \S+ https:\/\/\S+ sha512-\S+$/, `unpinned plan line: ${line}`);
  }
  // The bundler's pin is ONE pin: ensureEsbuild's literal, bundle-inputs-gate's
  // ESBUILD_PIN, and whatever version the lockfile would actually fetch.
  const esb = planned.find((l) => l.startsWith('plan @esbuild/'));
  assert.strictEqual(`esbuild@${esb.split(' ')[2]}`, ESBUILD_PIN,
    `the lockfile would provision a different esbuild than ${ESBUILD_PIN}:\n${esb}`);
});
