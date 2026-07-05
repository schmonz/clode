'use strict';
// Unit tests for libexec/clode-watch.cjs — the JS port of bin/clode's
// opportunistic update-signal watcher (bin/clode:396-547). Mirrors the behavior
// spec in test/test_watch.bats (21 tests) using file:// fixtures + a fake
// provider store so no network is touched:
//   REPO/stable       -> "<latest>\n"   (channel -> version resolution)
//   REPO/CHANGELOG.md                    (HIGH/low signal source)
//   CLODE_PROVIDERS/<v>/claude + current symlink   (fake clode-managed provider)
//
// version_gt uses the REAL `semver` ext-dep; like test_watch.bats we pin
// CLODE_DEPS to the real store (per-test HOME/XDG overrides mustn't hide it) and
// skip when it's absent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  versionGt, watchDir, fileMtime, writeWatchNotice,
  clodeWatch, clodeWatchBanner, clodeWatchFire, clodeWatchMaybe,
} = require('../libexec/clode-watch.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIBEXEC = path.join(REPO_ROOT, 'libexec');
const HERE = path.join(REPO_ROOT, 'bin');
const NODE = process.env.CLODE_NODE || process.execPath;

// Pin the real dep store so version_gt's semver resolves regardless of the
// per-test HOME/XDG overrides (identical to test_watch.bats's setup()).
const REAL_STORE = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'clode');
const HAVE_SEMVER = fs.existsSync(path.join(REAL_STORE, 'node_modules', 'semver'));
const semverOpts = { skip: HAVE_SEMVER ? false : 'semver ext-dep not installed' };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-watch-'));
}

// A stderr/stdout sink so we can assert on the (stderr-bound) banner/summary.
function sink() {
  const buf = [];
  return { write(x) { buf.push(x); return true; }, text() { return buf.join(''); } };
}

// Mirror test_watch.bats's _watch_fixture: fake releases repo + provider store.
// latest=stable version, current=provider version ('' = none), tier='high'|'low'.
function watchFixture(latest, current, tier) {
  const tmp = tmpdir();
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  const cache = path.join(tmp, 'cache');
  const providers = path.join(tmp, 'data', 'clode', 'providers');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'stable'), latest + '\n');
  fs.writeFileSync(path.join(repo, 'latest'), latest + '\n');
  const prev = current || '0.0.0';
  const body = tier === 'high'
    ? `# Changelog\n\n## ${latest}\n\n- requires the native binary now\n## ${prev}\n\n- old\n`
    : `# Changelog\n\n## ${latest}\n\n- minor fix\n## ${prev}\n\n- old\n`;
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), body);
  const watchDirPath = path.join(cache, 'clode');
  if (current) {
    fs.mkdirSync(path.join(providers, current), { recursive: true });
    fs.writeFileSync(path.join(providers, current, 'claude'), '');
    fs.writeFileSync(path.join(providers, 'current'), current + '\n');
  }
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(tmp, 'data'),
    XDG_CACHE_HOME: cache,
    CLODE_WATCH_DIR: watchDirPath,
    CLODE_RELEASES_URL: 'file://' + repo,
    CLODE_CHANGELOG_URL: 'file://' + path.join(repo, 'CHANGELOG.md'),
    CLODE_PROVIDERS: providers,
    // Pin the real store so semver resolves.
    CLODE_DEPS: REAL_STORE,
  };
  const notice = path.join(watchDirPath, 'watch-notice');
  return { tmp, env, notice, watchDirPath, providers };
}

function readNotice(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// --- versionGt (real semver) ------------------------------------------------

test('versionGt uses real semver: greater, equal, lesser, prerelease', semverOpts, () => {
  const env = { CLODE_DEPS: REAL_STORE };
  const o = { env };
  assert.strictEqual(versionGt('2.0.0', '1.9.9', o), true);
  assert.strictEqual(versionGt('2.1.10', '2.1.9', o), true);
  assert.strictEqual(versionGt('1.0.0', '1.0.0', o), false);
  assert.strictEqual(versionGt('1.9.9', '2.0.0', o), false);
  assert.strictEqual(versionGt('2.0.0', '2.0.0-rc1', o), true);
});

test('versionGt is conservative (false) on garbage / no semver', () => {
  // Bogus store => semver unresolvable => conservative non-greater.
  const env = { CLODE_DEPS: '/nonexistent-store-xyz', XDG_DATA_HOME: '/nonexistent-xyz' };
  assert.strictEqual(versionGt('2.0.0', '1.0.0', { env }), false);
});

test('versionGt works with a semver exposing only compare() (no gt)', () => {
  // The sanctioned fake semver (test_helper.bash seed + managed-deps fixture)
  // exports compare/satisfies only. versionGt must not depend on gt().
  const tmp = tmpdir();
  const nm = path.join(tmp, 'clode', 'node_modules', 'semver');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'),
    '{"name":"semver","version":"0.0.0-test","main":"index.js"}');
  fs.writeFileSync(path.join(nm, 'index.js'),
    'const P=v=>String(v).replace(/^[v=]+/,"").split(".").map(n=>parseInt(n,10)||0);' +
    'exports.compare=(a,b)=>{const x=P(a),y=P(b);for(let i=0;i<3;i++)' +
    'if((x[i]||0)!==(y[i]||0))return (x[i]||0)<(y[i]||0)?-1:1;return 0;};' +
    'exports.satisfies=()=>true;');
  const env = { CLODE_DEPS: path.join(tmp, 'clode') };
  assert.strictEqual(versionGt('2.0.0', '1.0.0', { env }), true, 'greater');
  assert.strictEqual(versionGt('1.0.0', '2.0.0', { env }), false, 'lesser');
  assert.strictEqual(versionGt('1.0.0', '1.0.0', { env }), false, 'equal');
});

test('versionGt resolves semver via clode\'s own node_modules (npm-global layout)', semverOpts, () => {
  const tmp = tmpdir();
  const appBin = path.join(tmp, 'app', 'bin');
  const appNm = path.join(tmp, 'app', 'node_modules');
  fs.mkdirSync(appBin, { recursive: true });
  fs.mkdirSync(appNm, { recursive: true });
  fs.symlinkSync(path.join(REAL_STORE, 'node_modules', 'semver'),
    path.join(appNm, 'semver'));
  const env = { CLODE_DEPS: path.join(tmp, 'empty'), XDG_DATA_HOME: path.join(tmp, 'empty') };
  assert.strictEqual(versionGt('2.0.0', '1.0.0', { env, here: appBin }), true);
});

// --- watchDir ---------------------------------------------------------------

test('watchDir honors CLODE_WATCH_DIR then XDG_CACHE_HOME then HOME', () => {
  const u = (p) => p.replace(/\\/g, '/'); // normalize Windows separators from path.join
  assert.strictEqual(watchDir({ CLODE_WATCH_DIR: '/x/y' }), '/x/y');
  assert.strictEqual(u(watchDir({ XDG_CACHE_HOME: '/c', HOME: '/h' })), '/c/clode');
  assert.strictEqual(u(watchDir({ HOME: '/h' })), '/h/.cache/clode');
});

// --- writeWatchNotice -------------------------------------------------------

test('writeWatchNotice emits parseable key=value lines', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'n');
  writeWatchNotice(p, '2.0.0', '1.0.0', 1, 1700000000);
  const n = readNotice(p);
  assert.strictEqual(n.latest, '2.0.0');
  assert.strictEqual(n.current, '1.0.0');
  assert.strictEqual(n.high, '1');
  assert.strictEqual(n.checked_at, '1700000000');
});

// --- fileMtime --------------------------------------------------------------

test('fileMtime returns a numeric epoch; 0 for missing', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'f');
  fs.writeFileSync(f, '');
  const m = fileMtime(f);
  assert.ok(Number.isInteger(m) && m > 0, 'existing file -> positive integer epoch');
  assert.strictEqual(fileMtime(path.join(dir, 'nope')), 0);
});

// --- clodeWatch: the poll->detect->notify cycle ----------------------------

test('clodeWatch: newer version with HIGH signal writes high=1 notice', semverOpts, async () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  const rc = await clodeWatch('', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: sink() });
  assert.strictEqual(rc, 0);
  const n = readNotice(fx.notice);
  assert.strictEqual(n.latest, '2.0.0');
  assert.strictEqual(n.current, '1.0.0');
  assert.strictEqual(n.high, '1');
});

test('clodeWatch: newer version without HIGH signal writes high=0', semverOpts, async () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'low');
  const rc = await clodeWatch('', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: sink() });
  assert.strictEqual(rc, 0);
  assert.strictEqual(readNotice(fx.notice).high, '0');
});

test('clodeWatch: not newer writes high=0, never banners', semverOpts, async () => {
  const fx = watchFixture('1.0.0', '1.0.0', 'high');
  const err = sink();
  const rc = await clodeWatch('', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: err });
  assert.strictEqual(rc, 0);
  assert.strictEqual(readNotice(fx.notice).high, '0');
  assert.strictEqual(err.text(), '');
});

test('clodeWatch: no provider store is a silent no-op (no notice written)', semverOpts, async () => {
  const fx = watchFixture('2.0.0', '', 'high');
  const rc = await clodeWatch('', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: sink() });
  assert.strictEqual(rc, 0);
  assert.strictEqual(fs.existsSync(fx.notice), false);
});

test('clodeWatch manual mode: HIGH prints a Node-impact summary to stderr', semverOpts, async () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  const err = sink();
  const rc = await clodeWatch('manual', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: err });
  assert.strictEqual(rc, 0);
  assert.match(err.text(), /may affect running under Node/);
});

test('clodeWatch manual mode: low prints an available/no-signals summary', semverOpts, async () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'low');
  const err = sink();
  const rc = await clodeWatch('manual', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: err });
  assert.strictEqual(rc, 0);
  assert.match(err.text(), /is available \(no Node-impacting signals\)/);
});

test('clodeWatch manual mode: up-to-date prints an up-to-date summary', semverOpts, async () => {
  const fx = watchFixture('1.0.0', '1.0.0', 'high');
  const err = sink();
  const rc = await clodeWatch('manual', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: err });
  assert.strictEqual(rc, 0);
  assert.match(err.text(), /up to date \(1\.0\.0; latest 1\.0\.0\)/);
});

test('clodeWatch follows autoUpdatesChannel when picking the upstream pointer', semverOpts, async () => {
  // stable -> 1.0.0 (== current), latest -> 2.0.0. Default (no setting) follows
  // latest, so 2.0.0 is seen as newer; autoUpdatesChannel=stable sees up-to-date.
  const fx = watchFixture('2.0.0', '1.0.0', 'low');
  fs.writeFileSync(path.join(fx.tmp, 'repo', 'stable'), '1.0.0\n');

  const def = await clodeWatch('', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: sink() });
  assert.strictEqual(def, 0);
  assert.strictEqual(readNotice(fx.notice).latest, '2.0.0', 'default follows latest pointer');

  const cfg = path.join(fx.env.HOME, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }) + '\n');
  const err = sink();
  const rc = await clodeWatch('manual', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: err });
  assert.strictEqual(rc, 0);
  assert.match(err.text(), /up to date \(1\.0\.0; stable 1\.0\.0\)/, 'stable setting follows stable pointer');
});

test('clodeWatch non-manual mode is silent (no stderr)', semverOpts, async () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  const err = sink();
  const rc = await clodeWatch('', { env: fx.env, libexec: LIBEXEC, here: HERE, node: NODE, stderr: err });
  assert.strictEqual(rc, 0);
  assert.strictEqual(err.text(), '');
});

// --- clodeWatchBanner -------------------------------------------------------

test('clodeWatchBanner prints once for a HIGH notice that still applies', semverOpts, () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  fs.mkdirSync(fx.watchDirPath, { recursive: true });
  fs.writeFileSync(fx.notice, 'latest=2.0.0\ncurrent=1.0.0\nhigh=1\nchecked_at=1\n');
  const err = sink();
  const rc = clodeWatchBanner({ env: fx.env, here: HERE, stderr: err });
  assert.strictEqual(rc, 0);
  const t = err.text();
  assert.match(t, /2\.0\.0/);
  assert.match(t, /may affect running under Node/);
  // EXACT banner text (the deliberate silent-by-default exception).
  assert.strictEqual(t.trim(),
    "clode: Claude Code 2.0.0 is available and may affect running under Node (run 'clode --clode-watch' for details, 'clode update' to take it).");
});

test('clodeWatchBanner is silent for a high=0 notice', semverOpts, () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'low');
  fs.mkdirSync(fx.watchDirPath, { recursive: true });
  fs.writeFileSync(fx.notice, 'latest=2.0.0\ncurrent=1.0.0\nhigh=0\nchecked_at=1\n');
  const err = sink();
  assert.strictEqual(clodeWatchBanner({ env: fx.env, here: HERE, stderr: err }), 0);
  assert.strictEqual(err.text(), '');
});

test('clodeWatchBanner self-clears once the provider has caught up', semverOpts, () => {
  const fx = watchFixture('2.0.0', '2.0.0', 'high'); // provider advanced to 2.0.0
  fs.mkdirSync(fx.watchDirPath, { recursive: true });
  fs.writeFileSync(fx.notice, 'latest=2.0.0\ncurrent=1.0.0\nhigh=1\nchecked_at=1\n');
  const err = sink();
  assert.strictEqual(clodeWatchBanner({ env: fx.env, here: HERE, stderr: err }), 0);
  assert.strictEqual(err.text(), '');
});

test('clodeWatchBanner is a silent no-op when no notice exists', () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  const err = sink();
  assert.strictEqual(clodeWatchBanner({ env: fx.env, here: HERE, stderr: err }), 0);
  assert.strictEqual(err.text(), '');
});

// --- clodeWatchMaybe (throttle) --------------------------------------------

test('clodeWatchMaybe fires (and stamps throttle) when none exists', () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  let fired = 0;
  clodeWatchMaybe({ env: fx.env, self: '/bin/true', fire: () => { fired++; } });
  assert.strictEqual(fired, 1);
  assert.ok(fs.existsSync(path.join(fx.watchDirPath, 'last-watch')), 'throttle stamped');
});

test('clodeWatchMaybe is a no-op under CLODE_NO_WATCH=1', () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  fx.env.CLODE_NO_WATCH = '1';
  let fired = 0;
  clodeWatchMaybe({ env: fx.env, self: '/bin/true', fire: () => { fired++; } });
  assert.strictEqual(fired, 0);
});

test('clodeWatchMaybe respects a fresh throttle (no re-fire)', () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  fs.mkdirSync(fx.watchDirPath, { recursive: true });
  fs.writeFileSync(path.join(fx.watchDirPath, 'last-watch'), '');
  let fired = 0;
  clodeWatchMaybe({ env: fx.env, self: '/bin/true', fire: () => { fired++; } });
  assert.strictEqual(fired, 0);
});

test('clodeWatchMaybe fires when the throttle is stale (interval 0)', () => {
  const fx = watchFixture('2.0.0', '1.0.0', 'high');
  fs.mkdirSync(fx.watchDirPath, { recursive: true });
  fs.writeFileSync(path.join(fx.watchDirPath, 'last-watch'), '');
  fx.env.CLODE_WATCH_INTERVAL = '0';
  let fired = 0;
  clodeWatchMaybe({ env: fx.env, self: '/bin/true', fire: () => { fired++; } });
  assert.strictEqual(fired, 1);
});

// --- clodeWatchFire (detached spawn) ---------------------------------------

test('clodeWatchFire spawns the parameterized self --clode-watch and never throws', () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'fired');
  // A tiny stub launcher: on `--clode-watch` it touches the marker, then exits.
  const stub = path.join(dir, 'stub.sh');
  fs.writeFileSync(stub,
    `#!/bin/sh\n[ "$1" = --clode-watch ] && : > "${marker}"\n`);
  fs.chmodSync(stub, 0o755);
  // Must not throw even for a bogus self.
  assert.doesNotThrow(() => clodeWatchFire({ self: '/nonexistent/launcher-xyz' }));
  assert.doesNotThrow(() => clodeWatchFire({ self: stub }));
});
