'use strict';
// clode-node.cjs — fetch/store/verify seam for the pinned Node that naude's
// build embeds. Every test injects fake download/verify seams so none of this
// touches the network; the sha-mismatch and already-present cases exercise the
// real store layout via CLODE_STATE_ROOT (clode-paths.cjs's nodeStore()).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { nodeAsset, ensurePinnedNode, nodeBinPath, PINNED_VERSION, tarExtract } = require('../libexec/clode-node.cjs');

test('nodeAsset: darwin-arm64 -> a nodejs.org url + the pinned sha', () => {
  const a = nodeAsset('darwin', 'arm64');
  assert.match(a.url, new RegExp(`nodejs\\.org/dist/v${PINNED_VERSION}/node-v${PINNED_VERSION}-darwin-arm64\\.tar\\.gz$`));
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(a.filename, `node-v${PINNED_VERSION}-darwin-arm64.tar.gz`);
});

test('nodeAsset: unsupported platform fails loud (Windows is out of scope)', () => {
  assert.throws(() => nodeAsset('win32', 'x64'), /naude.*not supported|unsupported/i);
});

test('ensurePinnedNode: sha mismatch fails loud and leaves nothing behind', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'nodestore-'));
  const env = { CLODE_STATE_ROOT: store };
  // Pin platform/arch to a SUPPORTED target (like the happy-path test below):
  // otherwise this resolves the HOST platform, and on win32 — where naude is a
  // deferred follow-on with no pinned Node — ensurePinnedNode throws "not
  // supported" before it ever reaches the sha check, so the assertion misses.
  await assert.rejects(
    ensurePinnedNode({ env, platform: 'linux', arch: 'x64', download: async (url, dest) => { fs.writeFileSync(dest, 'not-a-node'); }, verify: async () => 'deadbeef'.repeat(8) }),
    /sha mismatch/i);
  // nothing left in the versioned dir
  assert.ok(!fs.existsSync(path.join(store, 'share', 'clode', 'nodes', PINNED_VERSION)));
});

test('ensurePinnedNode: an already-present node is returned without downloading', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'nodestore-'));
  const env = { CLODE_STATE_ROOT: store };
  const binp = nodeBinPath(env);
  fs.mkdirSync(path.dirname(binp), { recursive: true }); fs.writeFileSync(binp, '#!node\n');
  let downloaded = false;
  const got = await ensurePinnedNode({ env, download: async () => { downloaded = true; } });
  assert.strictEqual(got, binp);
  assert.strictEqual(downloaded, false);
});

test('ensurePinnedNode: happy path downloads, verifies, extracts, and returns nodeBinPath', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'nodestore-'));
  const env = { CLODE_STATE_ROOT: store };
  const platform = 'linux';
  const arch = 'x64';
  const asset = nodeAsset(platform, arch);
  let extractCalled = null;
  const fakeExtract = async (tarball, destDir) => {
    extractCalled = { tarball, destDir };
    // Mimic tar -xzf: the tarball's top-level dir is node-v<version>-<plat>-<arch>/
    const top = path.join(destDir, `node-v${PINNED_VERSION}-${platform}-${arch}`);
    fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(top, 'bin', 'node'), '#!fake node\n');
  };
  const got = await ensurePinnedNode({
    env,
    platform,
    arch,
    download: async (url, dest) => { fs.writeFileSync(dest, 'fake-tarball-bytes'); },
    verify: async () => asset.sha256,
    extract: fakeExtract,
  });
  assert.strictEqual(got, nodeBinPath(env, platform, arch));
  assert.ok(fs.existsSync(got), 'extracted node binary should exist at nodeBinPath');
  assert.ok(extractCalled, 'extract seam should have been invoked');
  // no leftover temp download
  assert.ok(!fs.existsSync(path.join(store, 'share', 'clode', 'nodes', '.tmp')) ||
    fs.readdirSync(path.join(store, 'share', 'clode', 'nodes', '.tmp')).length === 0);
});

test('tarExtract resolves tar via provision and uses the resolved binary', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-'));
  const calls = [];
  // Real tar on the host resolves; assert the actual extract used a resolved path.
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-dst-'));
  // Build a tiny gzip tarball with the host tar to feed the real extract.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-src-'));
  fs.writeFileSync(path.join(src, 'hello'), 'hi');
  const arc = path.join(src, 'a.tgz');
  // Build the fixture archive by BASENAME with cwd=its dir: an absolute `-czf C:\…\a.tgz`
  // is misread as a remote host:path by Git Bash's GNU tar on Windows (the drive-letter
  // colon). Colon-free is uniform across GNU tar / bsdtar. (Same rule tarExtract itself
  // follows.)
  require('node:child_process').spawnSync('tar', ['-czf', path.basename(arc), '-C', src, 'hello'],
    { cwd: path.dirname(arc) });
  tarExtract(arc, destDir, {
    env: { ...process.env },
    spawn: (bin, args, o) => { calls.push(bin); return require('node:child_process').spawnSync(bin, args, o); },
    dataDir,
  });
  assert.strictEqual(fs.readFileSync(path.join(destDir, 'hello'), 'utf8'), 'hi');
  assert.ok(calls.some((b) => path.isAbsolute(b) && /tar|gtar|bsdtar/.test(b)),
    'used a provision-resolved (absolute) tar path');
});

test('nodeBinPath: <nodeStore>/<version>/<platform>-<arch>/bin/node, whether or not it exists', () => {
  const env = { CLODE_STATE_ROOT: '/nowhere-real' };
  const p = require('../libexec/clode-paths.cjs');
  // No platform/arch args: defaults to the host, so single-arg callers still work.
  assert.strictEqual(nodeBinPath(env),
    path.join(p.nodeStore(env), PINNED_VERSION, `${process.platform}-${process.arch}`, 'bin', 'node'));
});

const { targetToNodeAsset } = require('../libexec/clode-node.cjs');

test('nodeBinPath is per-(version,platform,arch), not version-only', () => {
  const env = { CLODE_NODES: '/store' };
  const a = nodeBinPath(env, 'darwin', 'arm64');
  const b = nodeBinPath(env, 'darwin', 'x64');
  assert.notStrictEqual(a, b, 'two platforms must not share one path (no clobber)');
  // Compare with path.join so the assertion holds on Windows too (backslash sep):
  // nodeBinPath uses path.join, so on win32 `a` is `\store\24.18.0\darwin-arm64\bin\node`.
  assert.ok(a.endsWith(path.join(PINNED_VERSION, 'darwin-arm64', 'bin', 'node')), a);
  assert.ok(b.endsWith(path.join(PINNED_VERSION, 'darwin-x64', 'bin', 'node')), b);
});

test('targetToNodeAsset: a canonical target resolves to a pinned Node asset', () => {
  const asset = targetToNodeAsset('linux-arm64');
  assert.match(asset.url, /nodejs\.org\/dist\/v.*\/node-v.*-linux-arm64\.tar\.gz$/);
  assert.ok(/^[0-9a-f]{64}$/.test(asset.sha256));
});

test('targetToNodeAsset: a non-Node target fails loud, names quaude', () => {
  assert.throws(() => targetToNodeAsset('netbsd-sparc'), /not a Node platform|use.*quaude/i);
});

test('ensurePinnedNode fetches two platforms into distinct dirs (no clobber)', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'nodes-'));
  const env = { CLODE_NODES: store };
  let dl = 0;
  const stub = async ({ platform, arch }) => ensurePinnedNode({
    env, platform, arch,
    download: async (_url, dst) => { dl++; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, 'TGZ'); },
    verify: async () => require('../libexec/clode-node.cjs').nodeAsset(platform, arch).sha256, // pass the sha gate
    extract: async (_tar, into) => {
      const top = path.join(into, `node-v${PINNED_VERSION}-${platform}-${arch}`);
      fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(top, 'bin', 'node'), `NODE-${platform}-${arch}`);
    },
  });
  const p1 = await stub({ platform: 'darwin', arch: 'arm64' });
  const p2 = await stub({ platform: 'darwin', arch: 'x64' });
  assert.notStrictEqual(p1, p2);
  assert.strictEqual(fs.readFileSync(p1, 'utf8'), 'NODE-darwin-arm64');
  assert.strictEqual(fs.readFileSync(p2, 'utf8'), 'NODE-darwin-x64', 'second fetch must not clobber the first');
  assert.strictEqual(dl, 2);
});
