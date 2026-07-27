const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { sandbox, mkProvider, REPO, NODE } = require('./e2e.cjs');

const BIN = path.join(REPO, 'bin', 'clode');

// `fetch` (clode-main.cjs step 5) is clode's OWN namespace — dispatched before any
// bin resolution/extraction, so unaffected by the runner's retirement. Exercised
// with a direct spawn of bin/clode, not a model runner. (The old
// `--clode-internal-update` rebuild-callback dispatch is RETIRED — auto-update is
// notify-only now — so there is no longer an internal-update command to exercise.)
function run(sbx, args = [], opts = {}) {
  const r = spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...sbx.env, ...(opts.env || {}) },
    cwd: opts.cwd || REPO,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: (r.stdout || '') + (r.stderr || '') };
}

// test_self_update.bats setup(): a file:// releases fixture (channel files, a
// platform provider binary, and a manifest with its sha256) that `clode fetch`
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

test('clode fetch <channel> fetches and reports, then exits', (t) => {
  const { sbx } = withReleases(t);
  const r = run(sbx, ['fetch', 'stable'], { env: { CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /fetched 9\.9\.9/);
  assert.ok(fs.existsSync(path.join(providersDir(sbx), '9.9.9', 'claude')));
});

test('clode --clode-internal-update is retired: an unknown command, not a rebuild', (t) => {
  // The old patched in-app autoupdater's rebuild callback dispatched here; it is
  // GONE (auto-update is notify-only). clode now treats it as any other unknown
  // command — usage error, no fetch, provider store untouched.
  const { sbx } = withReleases(t);
  const r = run(sbx, ['--clode-internal-update', 'stable'],
    { env: { CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.output, /unknown command/);
  assert.ok(!fs.existsSync(path.join(providersDir(sbx), '9.9.9', 'claude')),
    'a retired command must not fetch anything into the provider store');
});

test('clode fetch prints a warn-only signals digest and writes a snapshot', (t) => {
  const { sbx, signalsDir } = withReleases(t);
  const r = run(sbx, ['fetch', 'stable'], { env: { CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);                       // warn-only: never blocks
  assert.match(r.output, /clode signals for 9\.9\.9/);
  assert.match(r.output, /Upgraded the bundled Bun runtime/);   // HIGH release-note signal
  const snap = path.join(signalsDir, '9.9.9.json');
  assert.ok(fs.existsSync(snap));
  assert.match(fs.readFileSync(snap, 'utf8'), /"version": "9\.9\.9"/);
});
