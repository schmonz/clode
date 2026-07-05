'use strict';
// Unit tests for libexec/clode-update.cjs — the JS port of bin/clode's
// clode_update (bin/clode:349) + clode_signals_report (bin/clode:335). Mirrors
// the semantics of test/test_self_update.bats using file:// fixtures (a fake
// releases repo) so no network is touched:
//   REPO/stable            -> "9.9.9\n"     (channel -> version resolution)
//   REPO/9.9.9/manifest.json                (platform checksum)
//   REPO/9.9.9/linux-x64/claude             (a fake provider binary via mkfixture)
//   REPO/CHANGELOG.md                       (post-update signals digest input)
// with CLODE_RELEASES_URL=file://REPO, CLODE_PROVIDERS=<tmp>, CLODE_CHANGELOG_URL,
// CLODE_SIGNALS_DIR=<tmp> (keeps signals offline + out of this checkout's signals/).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIBEXEC = path.join(REPO_ROOT, 'libexec');
const HERE = path.join(REPO_ROOT, 'bin');
const NODE = process.env.CLODE_NODE || process.execPath;

const { clodeUpdate, binaryFor } = require('../libexec/clode-update.cjs');
const { sha256Of } = require('../libexec/clode-net.cjs');

const V = '9.9.9';
const PLAT = 'linux-x64';

// A stderr sink so we can assert on the (stderr-bound) messages + signals digest.
function sink() {
  const buf = [];
  return { write(x) { buf.push(x); return true; }, text() { return buf.join(''); } };
}

// Build the whole fixture repo + a tmp provider/signals area; return the env
// object + paths. Uses mkfixture.cjs for a carve-able fake provider binary and
// clode-net's sha256Of for the manifest checksum (matches the update's verify).
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-upd-'));
  const repo = path.join(tmp, 'repo');
  const providers = path.join(tmp, 'providers');
  const signals = path.join(tmp, 'signals');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(repo, V, PLAT), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const claudeSrc = path.join(repo, V, PLAT, 'claude');
  const mk = spawnSync(NODE, [path.join(REPO_ROOT, 'test', 'mkfixture.cjs'), claudeSrc, 'v'],
    { encoding: 'utf8' });
  assert.strictEqual(mk.status, 0, 'mkfixture built the fake provider binary');
  const sum = sha256Of(claudeSrc);

  fs.writeFileSync(path.join(repo, 'stable'), V + '\n');
  fs.writeFileSync(path.join(repo, 'latest'), V + '\n');
  fs.writeFileSync(path.join(repo, V, 'manifest.json'),
    JSON.stringify({ platforms: { [PLAT]: { checksum: sum } } }) + '\n');
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'),
    `# Changelog\n\n## ${V}\n\n- Upgraded the bundled Bun runtime to 9.9\n- Fixed a thing\n`);

  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(tmp, 'data'),
    CLODE_RELEASES_URL: 'file://' + repo,
    CLODE_FETCH_PLATFORM: PLAT,
    CLODE_PROVIDERS: providers,
    CLODE_CHANGELOG_URL: 'file://' + path.join(repo, 'CHANGELOG.md'),
    CLODE_SIGNALS_DIR: signals,
  };
  return { tmp, repo, providers, signals, sum, env };
}

function opts(env, stderr) {
  return { env, libexec: LIBEXEC, here: HERE, node: NODE, stderr };
}

function cleanup(fx) { fs.rmSync(fx.tmp, { recursive: true, force: true }); }

test('binaryFor reads the manifest platform binary name, defaults to claude', () => {
  const m = JSON.stringify({ platforms: { 'win32-x64': { binary: 'claude.exe' }, 'linux-x64': {} } });
  assert.strictEqual(binaryFor(m, 'win32-x64'), 'claude.exe');
  assert.strictEqual(binaryFor(m, 'linux-x64'), 'claude'); // no binary field -> default
  assert.strictEqual(binaryFor('not json', 'linux-x64'), 'claude'); // parse error -> default
});

test('clode_update fetches the fixed platform into the provider store + current pointer', async () => {
  const fx = fixture();
  const err = sink();
  try {
    const status = await clodeUpdate('stable', opts(fx.env, err));
    assert.strictEqual(status, 0, 'update succeeded');
    assert.ok(fs.existsSync(path.join(fx.providers, V, 'claude')), 'provider binary landed');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), V, 'current -> 9.9.9');
    assert.match(err.text(), /updated to 9\.9\.9/, 'updated message');
    // The fetched binary must byte-match the fixture (atomic temp->rename intact).
    assert.strictEqual(sha256Of(path.join(fx.providers, V, 'claude')), fx.sum);
    // chmod +x: the mode carries the execute bit.
    assert.ok(fs.statSync(path.join(fx.providers, V, 'claude')).mode & 0o111, 'executable');
  } finally { cleanup(fx); }
});

test('a bad checksum aborts the update without moving "current"', async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.repo, V, 'manifest.json'),
    JSON.stringify({ platforms: { [PLAT]: { checksum: '0'.repeat(64) } } }) + '\n');
  const err = sink();
  try {
    const status = await clodeUpdate('stable', opts(fx.env, err));
    assert.notStrictEqual(status, 0, 'update aborted (nonzero)');
    assert.match(err.text(), /checksum mismatch/i, 'checksum mismatch message');
    assert.ok(!fs.existsSync(path.join(fx.providers, 'current')), 'current not created');
    // The partial download is cleaned up (no .claude.partial left behind).
    assert.ok(!fs.existsSync(path.join(fx.providers, V, '.claude.partial')), 'partial removed');
  } finally { cleanup(fx); }
});

test('clode_update accepts a numeric version channel (uses it as-is)', async () => {
  const fx = fixture();
  const err = sink();
  try {
    const status = await clodeUpdate(V, opts(fx.env, err));
    assert.strictEqual(status, 0, 'numeric channel update succeeded');
    assert.ok(fs.existsSync(path.join(fx.providers, V, 'claude')), 'provider binary landed');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), V);
  } finally { cleanup(fx); }
});

test('unresolvable channel yields the exact "couldn\'t resolve" error, return 1', async () => {
  const fx = fixture();
  const err = sink();
  try {
    const status = await clodeUpdate('nope', opts(fx.env, err));
    assert.strictEqual(status, 1, 'nonzero on unresolved version');
    assert.match(err.text(),
      new RegExp(`clode: couldn't resolve a version for 'nope' from file://${fx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'exact resolve-failure message');
  } finally { cleanup(fx); }
});

test('platform not in manifest yields the exact error, return 1', async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.repo, V, 'manifest.json'),
    JSON.stringify({ platforms: {} }) + '\n');
  const err = sink();
  try {
    const status = await clodeUpdate('stable', opts(fx.env, err));
    assert.strictEqual(status, 1);
    assert.match(err.text(), new RegExp(`clode: platform ${PLAT} not in manifest for ${V}`));
  } finally { cleanup(fx); }
});

test('clode update prints a warn-only signals digest and writes a snapshot', async () => {
  const fx = fixture();
  const err = sink();
  try {
    const status = await clodeUpdate('stable', opts(fx.env, err));
    assert.strictEqual(status, 0, 'warn-only: signals never block the update');
    const out = err.text();
    assert.match(out, /clode signals for 9\.9\.9/, 'signals digest header');
    assert.match(out, /Upgraded the bundled Bun runtime/, 'HIGH release-note signal surfaced');
    const snap = path.join(fx.signals, V + '.json');
    assert.ok(fs.existsSync(snap), 'snapshot written');
    assert.match(fs.readFileSync(snap, 'utf8'), /"version": "9\.9\.9"/, 'snapshot has version');
  } finally { cleanup(fx); }
});

// Add a second, self-consistent version to an existing fixture repo (its own
// binary + manifest) so channel-resolution tests can prove WHICH channel/version
// was fetched by which version dir + `current` points to.
function addVersion(fx, ver) {
  const dir = path.join(fx.repo, ver, PLAT);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'claude');
  const mk = spawnSync(NODE, [path.join(REPO_ROOT, 'test', 'mkfixture.cjs'), src, 'v'],
    { encoding: 'utf8' });
  assert.strictEqual(mk.status, 0, 'mkfixture built the extra provider binary');
  const sum = sha256Of(src);
  fs.writeFileSync(path.join(fx.repo, ver, 'manifest.json'),
    JSON.stringify({ platforms: { [PLAT]: { checksum: sum } } }) + '\n');
  return sum;
}

// Point stable -> 8.8.8 and latest -> 9.9.9 so the two channels resolve to
// DIFFERENT versions; returns the "other" version added for stable.
function twoChannelRepo(fx) {
  const STABLE_V = '8.8.8';
  addVersion(fx, STABLE_V);
  fs.writeFileSync(path.join(fx.repo, 'stable'), STABLE_V + '\n');
  fs.writeFileSync(path.join(fx.repo, 'latest'), V + '\n'); // V = 9.9.9
  return STABLE_V;
}

function writeUserSettings(fx, obj) {
  const dir = path.join(fx.env.HOME, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj) + '\n');
}

test('no channel arg defaults to latest (matching claude)', async () => {
  const fx = fixture();
  twoChannelRepo(fx);
  const err = sink();
  try {
    const status = await clodeUpdate(undefined, opts(fx.env, err));
    assert.strictEqual(status, 0, 'default-channel update succeeded');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), V,
      'defaulted to latest -> 9.9.9');
  } finally { cleanup(fx); }
});

test('no channel arg honors autoUpdatesChannel:stable from user settings', async () => {
  const fx = fixture();
  const STABLE_V = twoChannelRepo(fx);
  writeUserSettings(fx, { autoUpdatesChannel: 'stable' });
  const err = sink();
  try {
    const status = await clodeUpdate(undefined, opts(fx.env, err));
    assert.strictEqual(status, 0, 'settings-driven update succeeded');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), STABLE_V,
      'followed autoUpdatesChannel=stable -> 8.8.8');
  } finally { cleanup(fx); }
});

test('an explicit channel arg overrides the autoUpdatesChannel setting', async () => {
  const fx = fixture();
  twoChannelRepo(fx);
  writeUserSettings(fx, { autoUpdatesChannel: 'stable' });
  const err = sink();
  try {
    const status = await clodeUpdate('latest', opts(fx.env, err));
    assert.strictEqual(status, 0, 'explicit-channel update succeeded');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), V,
      'explicit latest beat the stable setting -> 9.9.9');
  } finally { cleanup(fx); }
});

test('re-running update on the current version is a clean no-op', async () => {
  const fx = fixture();
  try {
    const first = await clodeUpdate('stable', opts(fx.env, sink()));
    assert.strictEqual(first, 0, 'first update ok');
    const err = sink();
    const second = await clodeUpdate('stable', opts(fx.env, err));
    assert.strictEqual(second, 0, 'second update ok');
    const out = err.text();
    // Nothing changed: one clear line, no bogus "updated to" claim, and NO
    // signals digest diffing the version against itself.
    assert.match(out, /already up to date \(9\.9\.9\)/, 'clean up-to-date message');
    assert.doesNotMatch(out, /updated to/, 'does not claim an update happened');
    assert.doesNotMatch(out, /clode signals for/, 'no self-comparing digest');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), V);
  } finally { cleanup(fx); }
});

test('switching back to an already-downloaded version still re-points + reports', async () => {
  const fx = fixture();
  const OTHER = '8.8.8';
  addVersion(fx, OTHER);
  try {
    await clodeUpdate(V, opts(fx.env, sink()));      // current -> 9.9.9
    await clodeUpdate(OTHER, opts(fx.env, sink()));  // current -> 8.8.8
    const err = sink();
    const rc = await clodeUpdate(V, opts(fx.env, err)); // back to the cached 9.9.9
    assert.strictEqual(rc, 0);
    const out = err.text();
    assert.match(out, /already have 9\.9\.9/, 'reused the cached binary (no re-download)');
    assert.match(out, /updated to 9\.9\.9/, 'a real re-point IS reported');
    assert.strictEqual(fs.readFileSync(path.join(fx.providers, 'current'), 'utf8').trim(), V);
  } finally { cleanup(fx); }
});
