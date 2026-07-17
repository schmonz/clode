'use strict';
// Three DIFFERENT things live under build/, keyed by three different things
// because they are determined by three different things (and have three
// different lifetimes) — this file is the single source of truth for all
// three keys. A future reader must not re-merge them:
//
//   * ARTIFACT dirs (build/<artifact-name>/, see artifactName/artifactDir) —
//     what we would SHIP for this host: naude, clode (--self), deps.tar,
//     deps.sig, sea-prep.blob, sea-config.json. Keyed by the ARTIFACT NAME —
//     locally the host's own OS version (hostOsVersionToken), matching what
//     CI actually publishes (build-leg/action.yml's `steps.name`) so
//     "build/clode-*" always means "shippable". CI overrides the whole name
//     via CLODE_ASSET_NAME so a release leg's dir carries its deliberate
//     compat FLOOR (e.g. darwin11.0) instead of the build host's real
//     version — a floor is a chosen target, not a fact about the box.
//   * the TOOLCHAIN dir (build/toolchain/<platform>-node<major>/, see
//     toolchainDir) — the native tool cache (esbuild/postject node_modules)
//     the build scripts install. This is a build TOOL, not a thing we'd
//     ship, and it is invalidated by a DIFFERENT axis than an artifact is:
//     the node major running the toolchain, not the OS/arch being targeted.
//     Keeps platformTag()'s existing `${osToken}-${arch}-node${nodeMajor}`
//     shape — that shape is correct HERE, and only here.
//   * platform-INDEPENDENT bundles (clode-main.bundle.cjs,
//     naude-entry.bundle.cjs — see scripts/build-clode-main.mjs and
//     scripts/build-naude.mjs) are pure JS with no native/platform coupling
//     at all, so they are keyed by NEITHER of the above: they live at
//     build/bundle/, unkeyed (one copy, whichever host esbuilt it last).
//
// The PTY test harness's native node-pty cache (harnessDir, test/.harness/)
// is a fourth thing but stays OUTSIDE build/ entirely (test-only, not a
// build output) — it is a tool cache like the toolchain dir, so it keeps
// platformTag()'s shape too; see harnessDir's comment.
//
// platformTag()'s own OS-version token is chosen to be HUMAN-MEANINGFUL and
// to name the portability floor, not just to be unique:
//   * darwin -> `macos-<ver>` from `sw_vers -productVersion` (authoritative, verified
//     Mavericks..Tahoe). The 10.x era keeps two components (10.9); 11+ keeps one (14,
//     26) — Apple's marketing major. Bare `macos-10` would collapse all of 10.x.
//   * linux  -> `linux-glibc<ver>` using the glibc the running Node was COMPILED against
//     (`process.report...glibcVersionCompiler`) — the true minimum to RUN the binary.
//     musl / field absent -> `linux-musl`.
//   * win32  -> `windows` (no OS-version token: Windows is ABI-stable across releases,
//     and the embedded node<major> already pins the real compat floor).
//   * anything else -> the raw kernel/OS major (never mis-maps; only ever over-splits,
//     the safe direction to err).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function readProductVersion() {
  return execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
}

// macOS marketing version, reduced to the significant version (see file header).
function macosVersion(productVersion = readProductVersion()) {
  const parts = String(productVersion).trim().split('.');
  return parts[0] === '10' ? parts.slice(0, 2).join('.') : parts[0];
}

// Linux portability floor: the glibc the running Node was compiled against.
function linuxGlibc(report = process.report && process.report.getReport()) {
  const g = report && report.header && report.header.glibcVersionCompiler;
  return g ? `glibc${g}` : 'musl';
}

// The full OS-version token for a platform (includes the platform prefix).
function osToken(platform = process.platform) {
  if (platform === 'darwin') return `macos-${macosVersion()}`;
  if (platform === 'linux') return `linux-${linuxGlibc()}`;
  if (platform === 'win32') return 'windows';   // ABI-stable; node<major> pins compat
  return `${platform}-${String(os.release()).split('.')[0]}`;
}

// Pure formatter: <osToken>-<arch>-node<major>. Every input is injectable for tests.
// This is the TOOLCHAIN/harness key — see the file header for why it must NOT be
// used for artifact dirs (that is hostOsVersionToken/artifactName, below).
function platformTag({
  token = osToken(),
  arch = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  const nodeMajor = String(nodeVersion).split('.')[0];
  return `${token}-${arch}-node${nodeMajor}`;
}

// The per-tag PTY/TUI test-harness dir (node_modules with node-pty's native binary).
// A tool cache, like the toolchain dir — deliberately keyed by platformTag(), NOT
// artifactName(): nothing here is ever shipped, so it must never gain an artifact
// name (see the file header).
function harnessDir(repo) {
  return path.join(repo, 'test', '.harness', platformTag());
}

// The native TOOL CACHE (esbuild/postject node_modules) the build scripts install
// into — see the file header for why this key (platform tuple + node-major) is
// right here and wrong for an artifact dir. Nested under build/toolchain/ so
// `build/clode-*` stays "only what we'd ship" (the artifact dir's whole point).
function toolchainDir(repo) {
  return path.join(repo, 'build', 'toolchain', platformTag());
}

// The VERSION file at the repo root — the same source scripts/build-clode-main.mjs's
// own repoVersion() reads (for the embedded __CLODE_BUNDLE_VERSION__ define).
// Duplicated on purpose, not shared: this is a 3-line leaf read and platform-tag.cjs
// must stay a dependency-free leaf module (build-clode-main.mjs already requires THIS
// file; the reverse would be backwards).
function repoVersion(repo) {
  try { return fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').replace(/\n+$/, '') || 'dev'; }
  catch { return 'dev'; }
}

// The LOCAL, no-floor "own OS version" token for the artifact name, in the SAME
// vocabulary CI uses for the OS+FLOOR component of a published asset name
// (build-leg/action.yml's `asset=clode-$V-${OS}${FLOOR}-${ARCH}`): the OS word CI
// uses (`darwin`, not `macos`), with the version glued on with NO separator
// (mirrors CI's raw OS+FLOOR string concatenation, e.g. `darwin11.0`).
//
// Unlike a release leg's FLOOR (scripts/tjs-legs.mjs — a deliberately CHOSEN old
// compat target, e.g. darwin-arm64's floor: '11.0'), this is the host's ACTUAL
// running OS version: a local build is not built against an old SDK, so it must
// never claim that floor (see CLODE_ASSET_NAME on artifactDir for how CI gets its
// real, floor-carrying name instead of this one).
function hostOsVersionToken(platform = process.platform) {
  if (platform === 'darwin') {
    const v = macosVersion();
    // CI's darwin floors are always major.minor (10.6, 11.0, ...). macosVersion()
    // returns a bare marketing major for 11+ (e.g. "26") — pad it to match that
    // SHAPE rather than inventing a fake minor version that isn't true.
    return `darwin${v.includes('.') ? v : `${v}.0`}`;
  }
  if (platform === 'linux') return `linux-${linuxGlibc()}`; // no CI linux floor exists to shape-match; keep the honest token
  if (platform === 'win32') return 'windows';                // CI: ABI-stable, no floor either
  // Anything else: no established CI floor vocabulary to match for this OS —
  // degrade honestly to the raw kernel/OS major (osToken's fallback shape).
  // Never invent a floor-shaped value for a platform that doesn't have one.
  return `${platform}-${String(os.release()).split('.')[0]}`;
}

// Pure formatter for the local artifact name: clode-<version>-<token>-<arch>.
// `token` defaults to hostOsVersionToken() (see its comment for why that is NOT
// osToken()/platformTag()'s token). Every input injectable, same discipline as
// platformTag().
function artifactName({
  version,
  token = hostOsVersionToken(),
  arch = process.arch,
} = {}) {
  return `clode-${version}-${token}-${arch}`;
}

// The directory holding THIS host's SHIPPABLE outputs — see the file header for
// the full rationale. `env.CLODE_ASSET_NAME` overrides the WHOLE dir name: CI
// computes the real published asset name (build-leg/action.yml's
// `steps.name.outputs.asset`, floor included) and passes it through so its build
// dirs match the shipped name exactly, rather than this function's host-honest
// (floor-less) default. `version` defaults to repoVersion(repo) (the VERSION
// file) so callers don't all need to thread it through by hand.
function artifactDir(repo, { version, env = process.env } = {}) {
  const name = env.CLODE_ASSET_NAME || artifactName({ version: version || repoVersion(repo) });
  return path.join(repo, 'build', name);
}

// SEA output binary path for a given base name (e.g. 'naude'): <repo>/build/<artifact-name>/<base>[.exe].
// opts ({ version, env }) forwards to artifactDir — see its comment.
function seaOut(repo, base, opts = {}) { return path.join(artifactDir(repo, opts), base); }
function seaBin(repo, base, opts = {}) { return seaOut(repo, base, opts) + (process.platform === 'win32' ? '.exe' : ''); }

module.exports = {
  macosVersion, linuxGlibc, osToken, platformTag, harnessDir, toolchainDir,
  repoVersion, hostOsVersionToken, artifactName, artifactDir, seaBin, seaOut,
};
