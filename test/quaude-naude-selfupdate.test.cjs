'use strict';
// Task 5 acceptance: a BUILT TARGET REBUILDS ITSELF to a newer Claude Code.
//
// This is the end-to-end proof for the target-update-rebuild feature (Tasks
// 1-4, already committed): a booted quaude/naude sets CLODE_TARGET_KIND +
// CLODE_TARGET in its env and its patched updater calls
// `CLODE_SELF --clode-internal-update [channel]`. clode-main.cjs dispatches
// that to targetUpdate (libexec/clode-target-update.cjs), which fetches a
// newer Claude Code (clodeUpdate), rebuilds the target's OWN kind into a temp
// in the target's dir (clodeBuild — PONG + attest IS the verify), and swaps
// it in place (clode-swap.cjs). Here we drive that for real, twice (quaude
// and naude), using the fused NATIVE clode builder (test/clode-native.test.cjs's
// `clode build --self`) as the callback — exactly what a real CLODE_SELF would
// invoke.
//
// Deliberately NOT in test/clode-native.test.cjs: that file's CI step asserts
// `skipped 0`, and this acceptance needs TWO REAL provider versions (an OLD
// one to bake into the initial target, a NEWER one to update to) — CI
// provisions only one. This file lives on its own and SKIPS CLEANLY (never
// fails) when its prerequisites are absent, so it never breaks that gate.
//
// The fetch mechanism (the crux): clodeUpdate resolves the version named by
// the releases fixture's channel file, then — when that exact version is
// ALREADY a byte-verified match in the provider store — SHORT-CIRCUITS to
// "clode: already have <ver>" and returns 0 WITHOUT downloading anything
// (libexec/clode-update.cjs:246-260). So the releases fixture never needs to
// serve a real ~250MB provider binary: it only needs a manifest whose
// checksum matches a NEWER real provider version we pre-seed into a sandbox
// provider store (copied byte-for-byte from this host's real
// ~/.local/share/clode/providers/<ver>/claude). clodeUpdate re-points that
// sandbox store's `current` at the NEW version; the following clodeBuild call
// (made WITHOUT CLODE_CLAUDE_BIN) resolves the provider via `current` and so
// bakes the NEW Claude Code into the rebuilt target.
//
// Gates (all clean SKIPs, never failures):
//   - no tjs binary (CLODE_TJS / build/tjs/tjs)
//   - no esbuilt clode-main bundle (and no esbuild toolchain to make one)
//   - fewer than two REAL provider versions under this host's provider store
//     (~/.local/share/clode/providers/<ver>/claude, or CLODE_PROVIDERS' store)
//
// Run with a real provider store (needs >=2 real versions already fetched —
// `clode fetch <ver>` for however many are missing):
//   DYLD_INSERT_LIBRARIES= node --test --test-timeout=1400000 \
//     test/quaude-naude-selfupdate.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { tjsPath, REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { toolchainDir } = require('../scripts/platform-tag.cjs');
const cpaths = require('../libexec/clode-paths.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
const PLAT = 'linux-x64'; // clode-update's fixed carve platform (CLODE_FETCH_PLATFORM default)

// -- A fresh (or newest available) esbuilt clode-main bundle, written OUTSIDE
// the repo. Copied from test/clode-native.test.cjs's stageMainBundle — same
// rationale (the builder's behavior is frozen in the esbuilt bundle).
function stageMainBundle(dir) {
  const buildDir = path.join(REPO, 'build');
  const tool = path.join(toolchainDir(REPO), 'package.json');
  try {
    const esbuild = createRequire(tool)('esbuild');
    const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').replace(/\n+$/, '');
    const out = path.join(dir, 'clode-main.bundle.cjs');
    esbuild.buildSync({
      entryPoints: [path.join(REPO, 'libexec', 'clode-main.cjs')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      define: { __CLODE_BUNDLE_VERSION__: JSON.stringify(VERSION) },
      outfile: out,
    });
    esbuild.buildSync({
      entryPoints: [path.join(REPO, 'libexec', 'naude-entry.cjs')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      outfile: path.join(dir, 'naude-entry.bundle.cjs'),
    });
    return out;
  } catch { /* toolchain not installed on this host */ }
  let tags = [];
  try { tags = fs.readdirSync(buildDir); } catch { return null; }
  let newest = null;
  for (const d of tags) {
    const c = path.join(buildDir, d, 'clode-main.bundle.cjs');
    try { const m = fs.statSync(c).mtimeMs; if (!newest || m > newest.m) newest = { c, m }; } catch { /* */ }
  }
  return newest && newest.c;
}

// Real provider versions this host already has fully fetched: a directory
// under providersDir() named a version, containing a non-empty regular file
// `claude` (excludes the `current` pointer file and any in-progress
// `.claude.partial`-only download). Sorted OLDEST -> NEWEST by numeric
// dotted-version comparison.
function realProviderVersions(env) {
  const dir = cpaths.providersDir(env);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const versions = names.filter((n) => {
    if (n === 'current') return false;
    const bin = path.join(dir, n, 'claude');
    try { return fs.statSync(bin).isFile() && fs.statSync(bin).size > 0; } catch { return false; }
  });
  versions.sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return versions.map((v) => ({ version: v, bin: path.join(dir, v, 'claude') }));
}

function runNative(bin, args, env, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}

let SKIP = null;
let DIR = null, NATIVE = null, OLD = null, NEW = null;
let RELEASES_URL = null, PROVIDERS_SANDBOX = null;
let NODES = null, NAUDE_SKIP = null;

before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  // Explicit opt-in, like clode-native.test.cjs's provider acceptances: this
  // drives SEVERAL real target builds (minutes each), so it must NOT run as part
  // of the default `node test/run.mjs` just because a dev box happens to have two
  // providers cached. CLODE_PROVIDER_BIN is the standard "run the heavy provider
  // e2es" switch; without it, skip.
  if (!process.env.CLODE_PROVIDER_BIN) { SKIP = 'no CLODE_PROVIDER_BIN (heavy provider self-update e2e — opt in to run)'; return; }
  const versions = realProviderVersions(process.env);
  if (versions.length < 2) {
    SKIP = `fewer than two REAL provider versions in ${cpaths.providersDir(process.env)} `
      + `(found ${versions.map((v) => v.version).join(', ') || 'none'}; run \`clode fetch <ver>\` `
      + 'to fetch a second one — this acceptance needs an OLD and a NEW to prove a rebuild)';
    return;
  }
  OLD = versions[0];
  NEW = versions[versions.length - 1];

  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-selfupdate-'));
  const bundle = stageMainBundle(DIR);
  if (!bundle) { SKIP = 'no esbuilt clode-main bundle and no esbuild toolchain (run scripts/build-clode-main.mjs)'; return; }

  NATIVE = path.join(DIR, 'clode-native');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--self', '--out', NATIVE], {
    encoding: 'utf8',
    timeout: 300000,
    env: { ...process.env, CLODE_TJS: tjsPath(), CLODE_MAIN_BUNDLE: bundle, DYLD_INSERT_LIBRARIES: '' },
  });
  if (build.status !== 0) {
    SKIP = `clode build --self failed (cannot exercise the callback without a NATIVE builder):\n${build.stdout}\n${build.stderr}`;
    return;
  }

  // -- The releases fixture + a sandbox provider store carrying ONLY the NEW
  // version's real bytes (see the file header for why no bundle download is
  // needed). Shared by both the quaude and naude acceptances below — the
  // fetch/rebuild target is the same NEW Claude Code either way.
  PROVIDERS_SANDBOX = path.join(DIR, 'providers-sandbox');
  fs.mkdirSync(path.join(PROVIDERS_SANDBOX, NEW.version), { recursive: true });
  const newBinCopy = path.join(PROVIDERS_SANDBOX, NEW.version, 'claude');
  fs.copyFileSync(NEW.bin, newBinCopy);
  fs.chmodSync(newBinCopy, 0o755);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(newBinCopy)).digest('hex');

  const releases = path.join(DIR, 'releases-repo');
  fs.mkdirSync(path.join(releases, NEW.version), { recursive: true });
  fs.writeFileSync(path.join(releases, 'stable'), NEW.version + '\n');
  fs.writeFileSync(path.join(releases, 'latest'), NEW.version + '\n');
  fs.writeFileSync(path.join(releases, NEW.version, 'manifest.json'),
    JSON.stringify({ platforms: { [PLAT]: { checksum: sum, binary: 'claude' } } }) + '\n');
  RELEASES_URL = pathToFileURL(releases).href;

  // -- naude's extra prerequisite: the pinned-node store. Reuse a real cached
  // one if present (fast, no network); else warm a sandbox copy via the HOST
  // clode (like acceptance 4 in clode-native.test.cjs) so the naude case can
  // still run when nothing is cached yet. Any failure here just narrows the
  // naude acceptance to a clean skip — the quaude acceptance is unaffected.
  NODES = process.env.CLODE_NODES || cpaths.nodeStore(process.env);
  const fetchNode = spawnSync(process.execPath, [ENTRY, 'fetch', '--naude'], {
    encoding: 'utf8', timeout: 300000,
    env: { ...process.env, CLODE_NODES: NODES, DYLD_INSERT_LIBRARIES: '' },
  });
  if (fetchNode.status !== 0) {
    NAUDE_SKIP = `pinned node unavailable (offline?): ${fetchNode.stderr || fetchNode.stdout}`;
  }
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

// Drives the whole acceptance for one kind ('quaude' | 'naude'):
//   1. build the initial target from the OLD provider (CLODE_CLAUDE_BIN=OLD).
//   2. record its baked Claude Code version (`--version`).
//   3. run the fused NATIVE builder as `--clode-internal-update stable`
//      against the sandbox releases fixture + sandbox provider store (no
//      CLODE_CLAUDE_BIN — resolution must go through the store's `current`,
//      which clodeUpdate re-points to NEW).
//   4. assert: exit 0; the binary AT the target path now reports the NEW
//      version; it still PONGs.
async function runSelfUpdateAcceptance(t, kind) {
  const work = fs.mkdtempSync(path.join(DIR, `${kind}-`));
  const target = path.join(work, `${kind}-old`);
  const cache = path.join(work, 'cache');
  const buildArgs = ['build', ...(kind === 'naude' ? ['--naude'] : []), '--out', target];
  const buildEnv = {
    PATH: '/usr/bin:/bin',
    HOME: work,
    CLODE_CLAUDE_BIN: OLD.bin,
    CLODE_CACHE: cache,
    // The bytecode fuse worker runs under the template tjs; back-to-back real
    // builds (build-OLD then the callback rebuild, ×2 kinds) can push it past
    // its default 300s cap on a loaded box. Scale the build-pipeline timeouts up
    // so a slow-but-healthy fuse is not mistaken for a hang.
    CLODE_TIMEOUT_SCALE: '4',
    ...(kind === 'naude' ? { CLODE_NODES: NODES } : {}),
  };
  const built = await runNative(NATIVE, buildArgs, buildEnv, 600000);
  assert.strictEqual(built.status, 0,
    `initial ${kind} build (from OLD ${OLD.version}) failed:\nstdout:\n${built.stdout}\nstderr:\n${built.stderr}`);
  assert.ok(fs.existsSync(target), `${kind}-old was not produced at ${target}`);
  if (kind === 'quaude') assert.match(built.stdout, /PONG round-trip ok, attest ok/);
  else assert.match(built.stdout, /built naude/);

  const versionEnv = { PATH: '/usr/bin:/bin', HOME: work };
  const oldV = await runNative(target, ['--version'], versionEnv, 60000);
  assert.strictEqual(oldV.status, 0, `${kind}-old --version failed: ${oldV.stderr}`);
  const oldVersion = oldV.stdout.trim();
  assert.match(oldVersion, new RegExp(OLD.version.replace(/\./g, '\\.')),
    `${kind}-old --version (${oldVersion}) does not mention the OLD provider version ${OLD.version}`);

  // The callback: env sets CLODE_TARGET_KIND/CLODE_TARGET (what a real booted
  // target's patched updater would set), the releases fixture, and the
  // sandbox provider store — deliberately NO CLODE_CLAUDE_BIN, so clodeBuild
  // resolves the provider through the store's `current`, which clodeUpdate
  // just re-pointed at NEW.
  const updateEnv = {
    PATH: '/usr/bin:/bin',
    HOME: work,
    CLODE_TARGET_KIND: kind,
    CLODE_TARGET: target,
    CLODE_RELEASES_URL: RELEASES_URL,
    CLODE_PROVIDERS: PROVIDERS_SANDBOX,
    CLODE_CACHE: cache,
    CLODE_CHANGELOG_URL: 'file:///nonexistent-clode-selfupdate-changelog',
    CLODE_SIGNALS_DIR: path.join(work, 'signals'),
    CLODE_TIMEOUT_SCALE: '4',   // headroom for the fuse worker (see buildEnv)
    ...(kind === 'naude' ? { CLODE_NODES: NODES } : {}),
  };
  const cb = await runNative(NATIVE, ['--clode-internal-update', 'stable'], updateEnv, 600000);
  assert.strictEqual(cb.status, 0,
    `--clode-internal-update failed:\nstdout:\n${cb.stdout}\nstderr:\n${cb.stderr}`);
  assert.match(cb.stdout, new RegExp(`rebuilt ${kind} at .*restart to apply`));
  // The short-circuit fetch path (NO bundle download) — clodeUpdate prints
  // "already have <ver>" when it re-points a fresh store's `current`, or
  // "already up to date (<ver>)" when `current` already names it (the case for
  // whichever acceptance runs second against this shared sandbox store). Both
  // prove the same invariant: the newer provider was resolved from the store
  // without a network/bundle download.
  assert.match(cb.stderr, /already have|already up to date/,
    'expected the short-circuit fetch path (no bundle download)');

  const newV = await runNative(target, ['--version'], versionEnv, 60000);
  assert.strictEqual(newV.status, 0, `${kind} (post-update) --version failed: ${newV.stderr}`);
  const newVersion = newV.stdout.trim();
  assert.notStrictEqual(newVersion, oldVersion,
    `the on-disk ${kind} still reports the OLD version (${oldVersion}) after --clode-internal-update`);
  assert.match(newVersion, new RegExp(NEW.version.replace(/\./g, '\\.')),
    `${kind} (post-update) --version (${newVersion}) does not mention the NEW provider version ${NEW.version}`);

  // Still PONGs after the rebuild+swap.
  const mock = await startMockAnthropic();
  try {
    const pong = await runNative(target, ['-p', 'say PONG'], {
      PATH: '/usr/bin:/bin', HOME: work,
      ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock',
    }, 120000);
    assert.strictEqual(pong.status, 0, `rebuilt ${kind} PONG smoke failed: ${pong.stderr}`);
    assert.match(pong.stdout, /PONG/, `rebuilt ${kind} did not say PONG:\n${pong.stdout}`);
  } finally { await mock.close(); }
}

test('acceptance 5a: a quaude rebuilds ITSELF to a newer Claude Code via the callback', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  await runSelfUpdateAcceptance(t, 'quaude');
});

test('acceptance 5b: a naude rebuilds ITSELF to a newer Claude Code via the callback', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (NAUDE_SKIP) { t.skip(NAUDE_SKIP); return; }
  await runSelfUpdateAcceptance(t, 'naude');
});
