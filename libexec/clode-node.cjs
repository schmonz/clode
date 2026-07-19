'use strict';
// clode-node.cjs — fetch/store/verify seam for the pinned Node that naude (the
// Node SEA a later task builds) embeds. deps/clode/node-pin.json is the ONE
// source of truth for which Node version + which sha256s are trusted; this
// module turns that pin into a downloaded, checksummed, extracted node binary
// on disk, idempotently.
//
// The store lives at clode-paths.cjs's nodeStore(env) — <clodeDataDir>/nodes
// by default, overridable via CLODE_NODES (or CLODE_STATE_ROOT, which moves
// the whole data dir). Layout: <nodeStore>/<version>/bin/node.
//
// download/verify/extract/log are all injectable seams (default to clode-net's
// downloadFile/sha256Of + a `tar -xzf` spawn) so callers — and every test in
// this suite — never have to hit the real network or a real tarball.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { nodeStore } = require('./clode-paths.cjs');
const { downloadFile, sha256Of } = require('./clode-net.cjs');

// The pin (version + trusted sha256s) is INLINED at bundle time: a JSON require
// esbuild resolves at build. That is load-bearing for the shipped clode-native,
// which runs under tjs with NO checkout on disk — a __dirname-relative
// fs.readFileSync resolved to a bogus '/deps/clode/node-pin.json' there and
// killed every naude build. A plain checkout resolves the same require to the
// real deps/clode/node-pin.json. Either way the feature hinges on it, so a
// missing/malformed pin fails loud at require time, not deep inside a fetch.
let PIN;
try {
  PIN = require('../deps/clode/node-pin.json');
} catch (err) {
  throw new Error(`clode-node: could not load the pinned-node manifest (deps/clode/node-pin.json): ${err.message}`);
}
if (!PIN || typeof PIN.version !== 'string' || !PIN.sha256 || typeof PIN.sha256 !== 'object') {
  throw new Error('clode-node: deps/clode/node-pin.json is missing required "version"/"sha256" fields');
}

const PINNED_VERSION = PIN.version;

// platform/arch -> { url, sha256, filename }. platform/arch are node's own
// process.platform/process.arch spellings (darwin/linux/win32, arm64/x64) —
// the same vocabulary target-env.cjs's mapPlatform produces. Windows is a
// real, deliberate absence: naude is out of scope there for now.
function nodeAsset(platform, arch) {
  const key = `${platform}-${arch}`;
  const sha256 = PIN.sha256[key];
  if (!sha256) {
    throw new Error(`clode-node: naude on ${platform}-${arch} is not supported (no pinned Node for this platform)`);
  }
  const filename = `node-v${PINNED_VERSION}-${key}.tar.gz`;
  const url = `https://nodejs.org/dist/v${PINNED_VERSION}/${filename}`;
  return { url, sha256, filename };
}

// Where the pinned node's binary lives, whether or not it has been fetched yet.
function nodeBinPath(env = process.env) {
  return path.join(nodeStore(env), PINNED_VERSION, 'bin', 'node');
}

// Default extract seam: a spawned `tar -xzf <tarball> -C <destDir>`, with the
// tar binary itself resolved via host-provision (a KAT-verified tar/gtar/
// bsdtar on PATH), not hardcoded — so a host whose tar lives elsewhere or is
// named gtar/bsdtar still works, and a toolless host fails loud up front.
function tarExtract(tarball, destDir, opts = {}) {
  const { provision } = require('./host-provision.cjs');
  const { spawn = spawnSync, env = process.env, dataDir } = opts;
  fs.mkdirSync(destDir, { recursive: true });
  const { path: tarBin } = provision('tar', { env, dataDir, spawn });
  const res = spawn(tarBin, ['-xzf', tarball, '-C', destDir], { stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`clode-node: ${tarBin} -xzf ${tarball} -C ${destDir} exited ${res.status}`);
  }
}

// Move the platform tarball's flattened contents (node-v<ver>-<plat>-<arch>/*)
// up into <nodeStore>/<version>/, so nodeBinPath's fixed bin/node shape holds
// regardless of the (platform,arch)-specific top-level dir name inside the
// tarball.
function flattenExtractedTopDir(extractedInto, versionDir) {
  const entries = fs.readdirSync(extractedInto, { withFileTypes: true });
  const topDirs = entries.filter((e) => e.isDirectory());
  if (topDirs.length !== 1) {
    throw new Error(
      `clode-node: expected exactly one top-level dir after extraction, found ${topDirs.length} (${extractedInto})`
    );
  }
  const from = path.join(extractedInto, topDirs[0].name);
  fs.mkdirSync(path.dirname(versionDir), { recursive: true });
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.renameSync(from, versionDir);
}

// Ensure the pinned Node is present in the store; return the absolute path to
// its binary. If already present, returns immediately with NO network access.
// Otherwise: download the tarball to a scratch temp dir, verify its sha256
// against the pin (fail loud + clean up on mismatch), extract, flatten into
// <nodeStore>/<version>/, and return nodeBinPath.
async function ensurePinnedNode(opts = {}) {
  const {
    env = process.env,
    download = downloadFile,
    verify = async (p) => sha256Of(p),
    extract = tarExtract,
    log = () => {},
    platform = process.platform,
    arch = process.arch,
  } = opts;

  const binPath = nodeBinPath(env);
  if (fs.existsSync(binPath)) {
    return binPath;
  }

  const asset = nodeAsset(platform, arch);
  const store = nodeStore(env);
  const tmpRoot = path.join(store, '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'dl-'));
  const tarballPath = path.join(workDir, asset.filename);

  try {
    log(`clode-node: downloading ${asset.url}`);
    await download(asset.url, tarballPath);

    const actualSha = await verify(tarballPath);
    if (actualSha !== asset.sha256) {
      throw new Error(
        `clode-node: pinned node sha mismatch — refusing to use it (expected ${asset.sha256}, got ${actualSha})`
      );
    }

    const extractedInto = path.join(workDir, 'extracted');
    fs.mkdirSync(extractedInto, { recursive: true });
    await extract(tarballPath, extractedInto);

    const versionDir = path.join(store, PINNED_VERSION);
    flattenExtractedTopDir(extractedInto, versionDir);

    if (!fs.existsSync(binPath)) {
      throw new Error(`clode-node: extraction completed but ${binPath} is missing`);
    }
    return binPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { PINNED_VERSION, nodeAsset, ensurePinnedNode, nodeBinPath, tarExtract };
