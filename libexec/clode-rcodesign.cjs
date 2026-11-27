'use strict';
// clode-rcodesign.cjs — fetch/store/verify seam for the pinned rcodesign
// (apple-codesign) binary a naude cross-build uses to ad-hoc sign a darwin
// Mach-O off-Mac, where `codesign` (Mac-only) is unavailable. Mirrors
// clode-node.cjs's shape exactly: deps/clode/rcodesign-pin.json is the ONE
// source of truth for which rcodesign version + which sha256s are trusted;
// this module turns that pin into a downloaded, checksummed, extracted
// rcodesign binary on disk, idempotently.
//
// Keyed by the BUILD HOST platform/arch, never the target: rcodesign runs
// WHERE THE BUILD RUNS to sign a darwin output produced elsewhere. A darwin
// host is a deliberate absence from the pin — it uses the system `codesign`
// instead, so there is nothing to fetch there.
//
// The store lives at <depsStore(env)>/tools/rcodesign/<version>/<platform>-
// <arch>/rcodesign(.exe) — per-(version,platform,arch), same reasoning as
// clode-node's nodeBinPath. depsStore honors CLODE_DEPS (falling back to
// clodeDataDir) — the same per-use override CLODE_NODES/CLODE_PROVIDERS give
// nodeStore/providersDir, and how tests isolate this store from a real
// ~/.local/share/clode instead of mutating it.
//
// download/verify/extract/log are all injectable seams (default to clode-net's
// downloadFile/sha256Of + unpack.cjs's in-process extractArchive, which reads the
// linux .tar.gz and the win32 .zip alike) so callers — and every test in this
// suite — never have to hit the real network or a real archive. The fetch ->
// verify -> extract sequence itself is unpack.cjs's fetchVerifiedArchive.

const fs = require('node:fs');
const path = require('node:path');

const { depsStore } = require('./clode-paths.cjs');
const { downloadFile, sha256Of } = require('./clode-net.cjs');
const { extractArchive, fetchVerifiedArchive } = require('./unpack.cjs');

// The pin (version + trusted sha256s + asset filenames) is INLINED at bundle
// time: a JSON require esbuild resolves at build. That is load-bearing for the
// shipped clode-native, which runs under tjs with NO checkout on disk — a
// __dirname-relative fs.readFileSync would resolve to a bogus path there. A
// plain checkout resolves the same require to the real
// deps/clode/rcodesign-pin.json. Either way the feature hinges on it, so a
// missing/malformed pin fails loud at require time, not deep inside a fetch.
let PIN;
try {
  PIN = require('../deps/clode/rcodesign-pin.json');
} catch (err) {
  throw new Error(`clode-rcodesign: could not load the pinned-rcodesign manifest (deps/clode/rcodesign-pin.json): ${err.message}`);
}
if (!PIN || typeof PIN.version !== 'string' || !PIN.sha256 || typeof PIN.sha256 !== 'object'
  || !PIN.asset || typeof PIN.asset !== 'object' || typeof PIN.releaseBase !== 'string') {
  throw new Error('clode-rcodesign: deps/clode/rcodesign-pin.json is missing required "version"/"sha256"/"asset"/"releaseBase" fields');
}

const RCODESIGN_VERSION = PIN.version;

// platform/arch -> { url, sha256, filename }. platform/arch are node's own
// process.platform/process.arch spellings (linux/win32, arm64/x64) — the
// BUILD HOST's, not the darwin target's. darwin hosts (and any other host
// absent from the pin, e.g. sunos) are a loud, deliberate refusal: darwin
// uses system codesign, so rcodesign is never pinned for it.
function rcodesignAsset(platform, arch) {
  const key = `${platform}-${arch}`;
  const sha256 = PIN.sha256[key];
  const filename = PIN.asset[key];
  if (!sha256 || !filename) {
    throw new Error(`clode-rcodesign: rcodesign is not supported / not pinned for host ${platform}-${arch}`);
  }
  const url = `${PIN.releaseBase}${filename}`;
  return { url, sha256, filename };
}

// Where the pinned rcodesign's binary lives, whether or not it has been
// fetched yet. Per-(version,platform,arch), like clode-node's nodeBinPath.
function rcodesignBinPath(env = process.env, platform = process.platform, arch = process.arch) {
  const name = platform === 'win32' ? 'rcodesign.exe' : 'rcodesign';
  return path.join(depsStore(env), 'tools', 'rcodesign', RCODESIGN_VERSION, `${platform}-${arch}`, name);
}

// Recursively hunt extractedInto for a file named binName and return its path,
// or null. The real archive nests it one level down (under the release's
// apple-codesign-<version>-<target>/ top dir, alongside docs/licenses we don't
// need); test doubles for `extract` may drop it straight into extractedInto.
// Searching by name rather than assuming a fixed depth covers both shapes.
function findBinary(dir, binName) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findBinary(full, binName);
      if (found) return found;
    } else if (e.name === binName) {
      return full;
    }
  }
  return null;
}

// Find the extracted rcodesign(.exe) binary anywhere under the extracted
// archive and move it — just the one file, not a bin/ tree — into
// <store>/<version>/<platform>-<arch>/.
function flattenExtractedBinary(extractedInto, versionDir, platform) {
  const binName = platform === 'win32' ? 'rcodesign.exe' : 'rcodesign';
  const from = findBinary(extractedInto, binName);
  if (!from) {
    throw new Error(`clode-rcodesign: extracted archive is missing ${binName} under ${extractedInto}`);
  }
  fs.mkdirSync(versionDir, { recursive: true });
  const to = path.join(versionDir, binName);
  fs.rmSync(to, { force: true });
  fs.renameSync(from, to);
}

// Ensure the pinned rcodesign is present in the store; return the absolute
// path to its binary. If already present, returns immediately with NO network
// access. Otherwise: download the archive to a scratch temp dir, verify its
// sha256 against the pin (fail loud + clean up on mismatch), extract, pull the
// binary out into <store>/<version>/<platform>-<arch>/, chmod +x, and return
// rcodesignBinPath.
async function ensureRcodesign(opts = {}) {
  const {
    env = process.env,
    download = downloadFile,
    verify = async (p) => sha256Of(p),
    extract = extractArchive,
    log = () => {},
    platform = process.platform,
    arch = process.arch,
  } = opts;

  const binPath = rcodesignBinPath(env, platform, arch);
  if (fs.existsSync(binPath)) {
    return binPath;
  }

  const asset = rcodesignAsset(platform, arch);
  const store = path.join(depsStore(env), 'tools', 'rcodesign');
  return fetchVerifiedArchive({
    label: 'clode-rcodesign', what: 'rcodesign', asset, tmpRoot: path.join(store, '.tmp'),
    download, verify, extract, log,
    install: (extractedInto) => {
      flattenExtractedBinary(extractedInto, path.join(store, RCODESIGN_VERSION, `${platform}-${arch}`), platform);
      if (!fs.existsSync(binPath)) {
        throw new Error(`clode-rcodesign: extraction completed but ${binPath} is missing`);
      }
      if (platform !== 'win32') {
        fs.chmodSync(binPath, 0o755);
      }
      return binPath;
    },
  });
}

module.exports = { RCODESIGN_VERSION, rcodesignAsset, rcodesignBinPath, ensureRcodesign };
