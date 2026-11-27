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

test('nodeAsset: unsupported platform fails loud', () => {
  assert.throws(() => nodeAsset('freebsd', 'x64'), /naude.*not supported|unsupported/i);
});

test('nodeAsset: win32 is a .zip from nodejs.org', () => {
  const a = require('../libexec/clode-node.cjs').nodeAsset('win32', 'x64');
  assert.match(a.filename, /node-v.*-win-x64\.zip$/);
  assert.match(a.url, /nodejs\.org\/dist\/.*win-x64\.zip$/);
  assert.ok(/^[0-9a-f]{64}$/.test(a.sha256));
});
test('nodeBinPath: win32 is node.exe at the top (not bin/node)', () => {
  const p = require('../libexec/clode-node.cjs').nodeBinPath({ CLODE_NODES: '/s' }, 'win32', 'x64');
  assert.ok(p.endsWith(path.join('win32-x64', 'node.exe')), p);
});
test('ensurePinnedNode: win32 extracts a .zip via the injected extract, flattens node.exe', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-'));
  const env = { CLODE_NODES: store };
  const { ensurePinnedNode, nodeAsset } = require('../libexec/clode-node.cjs');
  const p = await ensurePinnedNode({
    env, platform: 'win32', arch: 'x64',
    download: async (_u, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, 'ZIP'); },
    verify: async () => nodeAsset('win32', 'x64').sha256,
    extract: async (_zip, into) => {
      // emulate the win32 zip layout: node-v<ver>-win-x64/node.exe at the top
      const top = path.join(into, 'node-vX-win-x64');
      fs.mkdirSync(top, { recursive: true });
      fs.writeFileSync(path.join(top, 'node.exe'), 'WINNODE');
    },
  });
  assert.ok(p.endsWith(path.join('win32-x64', 'node.exe')), p);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'WINNODE');
});

test('ensurePinnedNode: sha mismatch fails loud and leaves nothing behind', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'nodestore-'));
  const env = { CLODE_STATE_ROOT: store };
  // Pin platform/arch to a SUPPORTED target (like the happy-path test below):
  // otherwise this resolves the HOST platform, and on a platform with no
  // pinned Node at all, ensurePinnedNode throws "not supported" before it
  // ever reaches the sha check, so the assertion misses.
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

// The DEFAULT extract (unpack.cjs's extractArchive, no injected seam): the real archive shapes,
// read in process with no tar or unzip on PATH. The tar.gz keeps bin/node's executable bit and
// the bin/npm symlink, as nodejs.org's tarballs carry them; the win32 zip is DOS-made, as
// nodejs.org's is.
async function withEmptyPath(fn) {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try { return await fn(); } finally { process.env.PATH = saved; }
}

test('ensurePinnedNode: the default extract unpacks a real .tar.gz in process, keeping modes and symlinks', async () => {
  const { packTar } = require('../scripts/tar-pack.cjs');
  const zlib = require('node:zlib');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-src-'));
  const top = `node-v${PINNED_VERSION}-linux-x64`;
  fs.mkdirSync(path.join(src, top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(src, top, 'lib', 'npm', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, top, 'bin', 'node'), '#!fake node\n');
  fs.chmodSync(path.join(src, top, 'bin', 'node'), 0o755);
  fs.writeFileSync(path.join(src, top, 'lib', 'npm', 'bin', 'npm-cli.js'), '// npm');
  const canLink = process.platform !== 'win32';
  if (canLink) fs.symlinkSync('../lib/npm/bin/npm-cli.js', path.join(src, top, 'bin', 'npm'));
  const tgz = zlib.gzipSync(packTar(src, [top]));
  const env = { CLODE_NODES: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-store-')) };
  const got = await withEmptyPath(() => ensurePinnedNode({
    env, platform: 'linux', arch: 'x64',
    download: async (_u, dest) => { fs.writeFileSync(dest, tgz); },
    verify: async () => nodeAsset('linux', 'x64').sha256,
  }));
  assert.strictEqual(got, nodeBinPath(env, 'linux', 'x64'));
  assert.strictEqual(fs.readFileSync(got, 'utf8'), '#!fake node\n');
  if (canLink) {
    assert.strictEqual(fs.statSync(got).mode & 0o111, 0o111, 'bin/node is still executable');
    assert.strictEqual(fs.readlinkSync(path.join(path.dirname(got), 'npm')), '../lib/npm/bin/npm-cli.js');
  }
});

test('ensurePinnedNode: the default extract unpacks a real DOS-made win32 .zip in process', async () => {
  const { makeZip } = require('./archive-fixtures.cjs');
  const zip = makeZip([
    { name: 'node-vX-win-x64/', type: 'dir' },
    { name: 'node-vX-win-x64/node.exe', data: 'WINNODE' },
    { name: 'node-vX-win-x64/README.md', data: 'readme', method: 0 },
  ], { unix: false });
  const env = { CLODE_NODES: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-zstore-')) };
  const got = await withEmptyPath(() => ensurePinnedNode({
    env, platform: 'win32', arch: 'x64',
    download: async (_u, dest) => { fs.writeFileSync(dest, zip); },
    verify: async () => nodeAsset('win32', 'x64').sha256,
  }));
  assert.strictEqual(fs.readFileSync(got, 'utf8'), 'WINNODE');
});

test('nodeBinPath: <nodeStore>/<version>/<platform>-<arch>/<leaf>, whether or not it exists', () => {
  const env = { CLODE_STATE_ROOT: '/nowhere-real' };
  const p = require('../libexec/clode-paths.cjs');
  // No platform/arch args: defaults to the host, so single-arg callers still work.
  // The leaf is host-shaped like the function: node.exe at top on win32, else bin/node.
  const leaf = process.platform === 'win32' ? ['node.exe'] : ['bin', 'node'];
  assert.strictEqual(nodeBinPath(env),
    path.join(p.nodeStore(env), PINNED_VERSION, `${process.platform}-${process.arch}`, ...leaf));
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
