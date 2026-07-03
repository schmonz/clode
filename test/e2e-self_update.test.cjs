const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { sandbox, runClode, mkProvider } = require('./e2e.cjs');

// test_self_update.bats setup(): a file:// releases fixture (channel files, a
// platform provider binary, and a manifest with its sha256) that `clode update`
// fetches into the clode-owned provider store, PLUS an offline signals digest
// (a local CHANGELOG.md fixture + a temp snapshot dir). The bats file unset
// CLODE_STATE_ROOT and drove everything through XDG_DATA_HOME so its own per-test
// isolation would govern; here CLODE_STATE_ROOT already IS the private sandbox
// (sbx.stateRoot), so we keep it and assert against the store it governs
// (stateRoot/share/clode/providers/...). CLODE_SIGNALS_DIR is pinned at a tmp dir
// under the sandbox so the post-update digest stays offline and NEVER writes into
// this checkout's repo signals/ dir (the $HERE/../.git fallback).
const V = '9.9.9';
const PLAT = 'linux-x64';

// providersDir(sbx.env) with CLODE_STATE_ROOT set and no CLODE_PROVIDERS override
// (cf. libexec/clode-paths.cjs): <stateRoot>/share/clode/providers.
function providersDir(sbx) {
  return path.join(sbx.stateRoot, 'share', 'clode', 'providers');
}

function withReleases(t) {
  const sbx = sandbox(t);

  const releases = path.join(sbx.dir, 'repo');
  const platDir = path.join(releases, V, PLAT);
  fs.mkdirSync(platDir, { recursive: true });

  // The FIXED-platform provider binary + its sha256 in the manifest.
  const providerSrc = path.join(platDir, 'claude');
  mkProvider(providerSrc, 'v');
  const sum = crypto.createHash('sha256').update(fs.readFileSync(providerSrc)).digest('hex');

  fs.writeFileSync(path.join(releases, 'stable'), V + '\n');
  fs.writeFileSync(path.join(releases, 'latest'), V + '\n');
  fs.writeFileSync(path.join(releases, V, 'manifest.json'),
    `{"platforms":{"${PLAT}":{"checksum":"${sum}"}}}\n`);

  // Local changelog fixture (a HIGH release-note signal) + a temp snapshot dir so
  // the post-update signals digest stays offline and out of the real repo.
  fs.writeFileSync(path.join(releases, 'CHANGELOG.md'),
    `# Changelog\n\n## ${V}\n\n- Upgraded the bundled Bun runtime to 9.9\n- Fixed a thing\n`);
  const signalsDir = path.join(sbx.dir, 'signals');

  sbx.env.CLODE_RELEASES_URL = pathToFileURL(releases).href;
  sbx.env.CLODE_CHANGELOG_URL = pathToFileURL(path.join(releases, 'CHANGELOG.md')).href;
  sbx.env.CLODE_SIGNALS_DIR = signalsDir;

  return { sbx, signalsDir };
}

test('clode update <channel> fetches and reports, then exits', (t) => {
  const { sbx } = withReleases(t);
  const r = runClode(sbx, ['update', 'stable'], { env: { CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /updated to 9\.9\.9/);
  assert.ok(fs.existsSync(path.join(providersDir(sbx), '9.9.9', 'claude')));
});

test('clode --clode-internal-update <channel> fetches like update (non-interactive)', (t) => {
  const { sbx } = withReleases(t);
  const r = runClode(sbx, ['--clode-internal-update', 'stable'],
    { env: { CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(providersDir(sbx), '9.9.9', 'claude')));
});

test('clode update prints a warn-only signals digest and writes a snapshot', (t) => {
  const { sbx, signalsDir } = withReleases(t);
  const r = runClode(sbx, ['update', 'stable'], { env: { CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);                       // warn-only: never blocks
  assert.match(r.output, /clode signals for 9\.9\.9/);
  assert.match(r.output, /Upgraded the bundled Bun runtime/);   // HIGH release-note signal
  const snap = path.join(signalsDir, '9.9.9.json');
  assert.ok(fs.existsSync(snap));
  assert.match(fs.readFileSync(snap, 'utf8'), /"version": "9\.9\.9"/);
});

test('after clode update, launching clode extracts the fetched provider', (t) => {
  const { sbx } = withReleases(t);
  const cache = path.join(sbx.dir, 'cache');
  // CLODE_CLAUDE_BIN is set inline for the update only (never persisted onto
  // sbx.env), so the plain launch resolves the fetched provider.
  const u = runClode(sbx, ['update', 'stable'],
    { env: { CLODE_CACHE: cache, CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(u.status, 0);
  runClode(sbx, [], { env: { CLODE_CACHE: cache } });    // `|| true`: exit ignored
  assert.ok(fs.existsSync(path.join(cache, '9.9.9', 'cli.cjs')));
});
