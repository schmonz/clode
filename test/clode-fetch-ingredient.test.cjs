'use strict';
// Unit tests for `clode fetch <ingredient> [--target P]`: the CLI-level branch in
// clode-main.cjs that fetches a build INGREDIENT — `node` (the pinned Node naude
// embeds, via clode-node.cjs's ensurePinnedNode) or `claude` (the upstream binary
// quaude is built from, via clode-update.cjs). clode is invoked as a SUBPROCESS
// here, so we cannot inject ensurePinnedNode directly — instead we PRE-SEED the
// store at the exact path nodeBinPath() computes, so ensurePinnedNode finds it
// already present and returns with NO network access (see clode-node.cjs:174-177).
//
// (Phase 3a task 6 renamed this file: it was clode-fetch-naude.test.cjs, for a
// `clode fetch --naude` spelling that no longer exists.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'stage0.mjs');
const NODE = process.execPath;

const { nodeBinPath } = require('../libexec/clode-node.cjs');

// Mirrors test/clode-build.test.cjs's runEntry: spawnSync scripts/stage0.mjs with
// DYLD_INSERT_LIBRARIES cleared (asdf/system shims break under it) and a
// fresh CLODE_WATCH_DIR (never the real ~/.cache/clode) so this test cannot
// mutate real machine state.
function runEntry(args, extraEnv) {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-ingredient-test-watch-'));
  return spawnSync(NODE, [ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '', CLODE_WATCH_DIR: watchDir }, extraEnv || {}),
  });
}

// A store with the pinned node already in place for (platform, arch): the exact
// path ensurePinnedNode checks first, so it returns without a download.
function seedIn(stateRoot, platform, arch) {
  const binPath = nodeBinPath({ CLODE_STATE_ROOT: stateRoot }, platform, arch);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/bin/sh\n');
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function seedPinnedNode(platform, arch) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-node-state-'));
  return { stateRoot, binPath: seedIn(stateRoot, platform, arch) };
}

test('clode fetch node: the table spelling reaches the pinned-node store, no network', () => {
  const { stateRoot, binPath } = seedPinnedNode(process.platform, process.arch);

  const r = runEntry(['fetch', 'node'], { CLODE_STATE_ROOT: stateRoot });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /clode: pinned node ready at/);
  assert.ok(r.stdout.includes(binPath), r.stdout);
  // Proof it is the INGREDIENT and not a channel: a channel argument would have gone to
  // clodeUpdate, which never prints this and cannot succeed against no network.
  assert.doesNotMatch(r.stderr || '', /couldn't resolve a version/);
});

// TASK 6, carried item 3: the table ADVERTISED `fetch --target` and dispatch read it
// as the legacy channel (`clode fetch --target linux-amd64` -> "couldn't resolve a
// version for '--target'"), because parseArgv recorded the flag but left it in
// cmd.rest. A promised flag that does not work is a lying table. The pinned-node
// store is already per-(version, platform, arch) — nodeBinPath's own reason for
// existing is that a naude CROSS-build fetches a foreign Node — so this ingredient
// is the one that can honestly cross, and here it does.
test('clode fetch node --target: fetches into the TARGET platform store, not the host one', () => {
  const { stateRoot, binPath } = seedPinnedNode('linux', 'arm64');
  // The HOST's node is seeded into the same store too, so a regression that ignores
  // --target reports the host path instead of DOWNLOADING one (this test must never
  // reach the network, in either direction).
  seedIn(stateRoot, process.platform, process.arch);

  const r = runEntry(['fetch', 'node', '--target', 'linux-arm64'], { CLODE_STATE_ROOT: stateRoot });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(binPath), `must report the linux-arm64 store path:\n${r.stdout}`);
  assert.ok(r.stdout.includes(`${path.sep}linux-arm64${path.sep}`), r.stdout);
  assert.doesNotMatch(r.stderr || '', /couldn't resolve a version/,
    '--target must never be read as a release channel');
});

test('clode fetch node --target: a non-Node platform is refused by name, nothing fetched', () => {
  const { stateRoot } = seedPinnedNode(process.platform, process.arch);
  const r = runEntry(['fetch', 'node', '--target', 'netbsd-arm64'], { CLODE_STATE_ROOT: stateRoot });
  // A usage error like every other argv the CLI refuses (exit 2): decided entirely
  // from argv, before any work.
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr || '', /netbsd-arm64/);
  assert.doesNotMatch(r.stdout || '', /pinned node ready/);
});

// The OTHER ingredient cannot cross, and says so rather than pretending. MEASURED
// (clode-update.cjs): the provider store is keyed by VERSION ALONE —
// providers/<version>/claude — and a fetch re-points `current` at it, so fetching a
// foreign-OS provider would overwrite this machine's provider in place and leave
// every later build carving the wrong OS branches. The limitation is the STORE's
// missing platform axis, and the refusal names it (and the escape hatch that does
// exist) instead of being a flag that is silently ignored.
test('clode fetch claude --target: refused LOUDLY, naming the limitation', () => {
  const r = runEntry(['fetch', 'claude', '--target', 'linux-amd64'], {
    CLODE_RELEASES_URL: 'file://' + fs.mkdtempSync(path.join(os.tmpdir(), 'clode-empty-releases-')),
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-claude-state-')),
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-claude-home-')),
  });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr || '', /--target/);
  assert.match(r.stderr || '', /provider store/i, 'the refusal must name WHY, not just refuse');
  assert.match(r.stderr || '', /CLODE_FETCH_PLATFORM/, 'and the override that does exist');
  assert.doesNotMatch(r.stderr || '', /couldn't resolve a version/,
    'it must refuse before any network work, and never read --target as a channel');
});

test('clode fetch claude <version>: the release positional still reaches clodeUpdate', () => {
  // The channel/version positional survives the break (a pinned provider is how
  // test/run.mjs seeds the suite), but only AFTER the ingredient: `clode fetch
  // 2.1.251` was the old spelling and is a usage error now.
  const common = {
    CLODE_RELEASES_URL: 'file://' + fs.mkdtempSync(path.join(os.tmpdir(), 'clode-empty-releases-')),
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-ver-state-')),
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fetch-ver-home-')),
  };
  const pinned = runEntry(['fetch', 'claude', '2.1.251'], common);
  assert.strictEqual(pinned.status, 1);
  assert.match(pinned.stderr, /failed to fetch manifest for 2\.1\.251/,
    'a numeric channel is used as-is, so it gets as far as the (absent) manifest');

  const bare = runEntry(['fetch', '2.1.251'], common);
  assert.strictEqual(bare.status, 2, 'the ingredient is required now');
  assert.match(bare.stderr, /ingredient/);
});

// An argument the table does not recognise must be REFUSED, not ignored. `fetch` and
// `read-anthropic-tea-leaves` have no module of their own to parse what follows (build
// and bootstrap do, and declare `ownsArgv` for it), so the table is their whole
// contract — and before task 6 dispatch discarded parseArgv's flag-level complaint for
// every verb, which made `clode fetch claude --bogus` a silent success.
test('an unrecognised argument is a usage error for the verbs the table fully owns', () => {
  const common = {
    CLODE_RELEASES_URL: 'file://' + fs.mkdtempSync(path.join(os.tmpdir(), 'clode-empty-releases-')),
    CLODE_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bogus-state-')),
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bogus-home-')),
  };
  for (const argv of [['fetch', 'claude', '--bogus'], ['read-anthropic-tea-leaves', '--bogus']]) {
    const r = runEntry(argv, common);
    assert.strictEqual(r.status, 2, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr || '', /unknown argument '--bogus'/);
  }
  // The release positional is the CLAUDE ingredient's (SURFACE.verbs.fetch.tail.only):
  // handing one to `node` must say so rather than fetch the pin and ignore it.
  const { stateRoot } = seedPinnedNode(process.platform, process.arch);
  const r = runEntry(['fetch', 'node', 'stable'], { CLODE_STATE_ROOT: stateRoot });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr || '', /takes no release argument/);
  assert.doesNotMatch(r.stdout || '', /pinned node ready/);
});
