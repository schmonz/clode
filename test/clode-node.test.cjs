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

const { nodeAsset, ensurePinnedNode, nodeBinPath, PINNED_VERSION } = require('../libexec/clode-node.cjs');

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
  await assert.rejects(
    ensurePinnedNode({ env, download: async (url, dest) => { fs.writeFileSync(dest, 'not-a-node'); }, verify: async () => 'deadbeef'.repeat(8) }),
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
  assert.strictEqual(got, nodeBinPath(env));
  assert.ok(fs.existsSync(got), 'extracted node binary should exist at nodeBinPath');
  assert.ok(extractCalled, 'extract seam should have been invoked');
  // no leftover temp download
  assert.ok(!fs.existsSync(path.join(store, 'share', 'clode', 'nodes', '.tmp')) ||
    fs.readdirSync(path.join(store, 'share', 'clode', 'nodes', '.tmp')).length === 0);
});

test('nodeBinPath: <nodeStore>/<version>/bin/node, whether or not it exists', () => {
  const env = { CLODE_STATE_ROOT: '/nowhere-real' };
  const p = require('../libexec/clode-paths.cjs');
  assert.strictEqual(nodeBinPath(env), path.join(p.nodeStore(env), PINNED_VERSION, 'bin', 'node'));
});
