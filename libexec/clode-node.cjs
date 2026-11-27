'use strict';
// clode-node.cjs — fetch/store/verify seam for the pinned Node that naude (the
// Node SEA a later task builds) embeds. deps/clode/node-pin.json is the ONE
// source of truth for which Node version + which sha256s are trusted; this
// module turns that pin into a downloaded, checksummed, extracted node binary
// on disk, idempotently.
//
// The store lives at clode-paths.cjs's nodeStore(env) — <clodeDataDir>/nodes
// by default, overridable via CLODE_NODES (or CLODE_STATE_ROOT, which moves
// the whole data dir). Layout: <nodeStore>/<version>/<platform>-<arch>/bin/node
// — per-platform, so a naude cross-build fetching Node for a non-host target
// stores alongside the host's node instead of clobbering it.
//
// download/verify/extract/log are all injectable seams (default to clode-net's
// downloadFile/sha256Of + unpack.cjs's in-process extractArchive) so callers — and
// every test in this suite — never have to hit the real network or a real tarball.
// The fetch -> verify -> extract sequence itself is unpack.cjs's fetchVerifiedArchive,
// shared with clode-rcodesign.cjs.

const fs = require('node:fs');
const path = require('node:path');

const { nodeStore } = require('./clode-paths.cjs');
const { downloadFile, sha256Of } = require('./clode-net.cjs');
const { extractArchive, fetchVerifiedArchive } = require('./unpack.cjs');

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
// the same vocabulary target-env.cjs's mapPlatform produces. The pin KEY for
// Windows stays `win32-<arch>` (matching process.platform), but nodejs.org's
// actual asset filename/URL spells the OS segment `win-<arch>` (not
// `win32-<arch>`) and ships a `.zip`, not a `.tar.gz` — everyone else keeps
// `<platform>-<arch>.tar.gz`.
// Is there a pinned Node for this platform/arch, and if not, WHY — as one sentence, in
// one place. Returns null when the platform is servable, else the refusal message.
//
// Exported because the answer is a pure table lookup that costs nothing, while the work it
// gates (staging + extracting the upstream bundle) costs MINUTES on a code-split bundle.
// `clode build naude` therefore asks this BEFORE it stages anything — see clode-build's
// naude branch, and the ordering test in test/clode-build-naude.test.cjs. nodeAsset throws
// exactly this message, so the early refusal and the late one can never drift apart.
function pinnedNodeRefusal(platform, arch) {
  return PIN.sha256[`${platform}-${arch}`]
    ? null
    : `naude on ${platform}-${arch} is not supported (no pinned Node for this platform)`;
}

function nodeAsset(platform, arch) {
  const key = `${platform}-${arch}`;
  const sha256 = PIN.sha256[key];
  if (!sha256) {
    throw new Error(`clode-node: ${pinnedNodeRefusal(platform, arch)}`);
  }
  const isWin = platform === 'win32';
  const ext = isWin ? 'zip' : 'tar.gz';
  const filename = `node-v${PINNED_VERSION}-${isWin ? `win-${arch}` : key}.${ext}`;
  const url = `https://nodejs.org/dist/v${PINNED_VERSION}/${filename}`;
  return { url, sha256, filename };
}

// Resolve a user-facing `--target` (canonical or leg token) to a pinned Node
// asset. naude only reaches Node platforms; a well-formed but non-Node target is a
// loud, actionable refusal (quaude is the answer there), NOT a silent skip.
function targetToNodeAsset(target) {
  const { targetToNode } = require('../scripts/canonical-name.cjs');
  const nt = targetToNode(target);
  if (!nt) {
    throw new Error(`clode-node: '${target}' is not a Node platform — naude cannot target it; cross-build a quaude instead (clode build quaude --target ${target})`);
  }
  return nodeAsset(nt.platform, nt.arch); // throws its own clear error if the pin lacks this key
}

// Where the pinned node's binary lives, whether or not it has been fetched yet.
// Per-(version,platform,arch): a naude cross-build fetches Node for a target
// platform that need not be the host's, so the store must hold more than one
// platform's node at once without one clobbering another. win32's archive has
// no bin/ dir — node.exe sits at the top of the version dir — everyone else
// keeps bin/node.
function nodeBinPath(env = process.env, platform = process.platform, arch = process.arch) {
  const leaf = platform === 'win32' ? ['node.exe'] : ['bin', 'node'];
  return path.join(nodeStore(env), PINNED_VERSION, `${platform}-${arch}`, ...leaf);
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
    extract = extractArchive,
    log = () => {},
    platform = process.platform,
    arch = process.arch,
  } = opts;

  const binPath = nodeBinPath(env, platform, arch);
  if (fs.existsSync(binPath)) {
    return binPath;
  }

  const asset = nodeAsset(platform, arch);
  const store = nodeStore(env);
  return fetchVerifiedArchive({
    label: 'clode-node', what: 'node', asset, tmpRoot: path.join(store, '.tmp'),
    download, verify, extract, log,
    install: (extractedInto) => {
      flattenExtractedTopDir(extractedInto, path.join(store, PINNED_VERSION, `${platform}-${arch}`));
      if (!fs.existsSync(binPath)) {
        throw new Error(`clode-node: extraction completed but ${binPath} is missing`);
      }
      return binPath;
    },
  });
}

module.exports = { PINNED_VERSION, nodeAsset, pinnedNodeRefusal, ensurePinnedNode, nodeBinPath, targetToNodeAsset };
