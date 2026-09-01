'use strict';
// Several DIFFERENT things are keyed here, because they are determined by
// different things (and have different lifetimes) — this file is the single
// source of truth for all their keys. A future reader must not re-merge them:
//
//   * ARTIFACT dirs (build/<artifact-name>/, see artifactName/artifactDir) —
//     what we would SHIP for this host: naude, clode (--self), deps.tar,
//     deps.sig, sea-prep.blob, sea-config.json. Keyed by the ARTIFACT NAME —
//     locally the host's own OS version (hostOsVersionToken), matching what
//     CI actually publishes (build-leg/action.yml's `steps.name`) so
//     "build/clode-*" always means "shippable". CI overrides the whole name
//     via CLODE_ASSET_NAME so a release leg's dir carries its deliberate
//     compat FLOOR (e.g. macos-11.0) instead of the build host's real
//     version — a floor is a chosen target, not a fact about the box. This
//     is the ONE of these that legitimately lives inside the checkout, under
//     build/ — see build-scratch.cjs's file header for why: it is the
//     sanctioned copy-back target for a finished, shippable artifact.
//   * the TOOLCHAIN dir (see toolchainDir) — the native tool cache
//     (esbuild/postject node_modules) the build scripts install. This is a
//     build TOOL, not a thing we'd ship, and it is invalidated by a
//     DIFFERENT axis than an artifact is: the node major running the
//     toolchain, not the OS/arch being targeted. Keeps platformTag()'s
//     `${osToken}-${arch}-node${nodeMajor}` shape — that shape is correct
//     HERE, and only here — but is SCRATCH, not product, so it now resolves
//     through build-scratch.cjs's buildPath() instead of living under
//     build/ in the checkout (formerly build/toolchain/<tag>/).
//   * platform-INDEPENDENT bundles (clode-main.bundle.cjs,
//     naude-entry.bundle.cjs — see scripts/build-clode-main.mjs and
//     scripts/build-naude.mjs) are pure JS with no native/platform coupling
//     at all, so they are keyed by NEITHER of the above: they live at
//     build/bundle/, unkeyed (one copy, whichever host esbuilt it last).
//
// The PTY test harness's native node-pty cache (harnessDir) and the per-platform
// tjs engine template (tjsDir, a fourth keyed thing — see its own comment) are
// both build/test TOOLS, never shipped, so both resolve through buildPath() too
// — outside the checkout entirely, not merely outside build/.
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
const { canonArch } = require('./canonical-name.cjs');
const { buildPath } = require('./build-scratch.cjs');

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
  // A FLOOR THAT CANNOT BE READ MUST WALL, NOT SHIP EMPTY. The node-shim documents
  // os.release() returning '' as a divergence and calls a caller needing the true release
  // "a future wall" (libexec/node-shim/modules/os.cjs). THIS IS THAT CALLER: under a
  // node-free clode on netbsd/freebsd/haiku this produced `netbsd-` — an artifact token
  // with an EMPTY floor — silently. An asset named for a compatibility floor it does not
  // know is worse than a build that stops. Found 2026-08-25.
  const rel = String(os.release()).split('.')[0];
  if (!rel) {
    throw new Error(`platform-tag: os.release() is empty on ${platform}, so the compatibility `
      + 'floor cannot be determined and the artifact would be named `' + platform + '-`. '
      + 'This host cannot name its own floor — run under a runtime that reports os.release(), '
      + 'or extend platform-tag with a platform-specific floor for ' + platform + '.');
  }
  return `${platform}-${rel}`;
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
//
// SCRATCH, not product: a build/test tool cache belongs outside the checkout, same
// as toolchainDir/tjsDir below (see build-scratch.cjs for why a default was not
// enough). `repo` is retained only for call-site compatibility — every existing
// caller passes it — and is deliberately unused.
function harnessDir(_repo) {
  return buildPath('harness', platformTag());
}

// The native TOOL CACHE (esbuild/postject node_modules) the build scripts install
// into — see the file header for why this key (platform tuple + node-major) is
// right here and wrong for an artifact dir. Formerly nested under build/toolchain/
// so `build/clode-*` stayed "only what we'd ship" (the artifact dir's whole
// point); now it is SCRATCH — a tool cache, never shipped — so it resolves
// through the allocator instead, off in the checkout entirely (see
// build-scratch.cjs). `repo` is retained only for call-site compatibility and is
// deliberately unused.
function toolchainDir(_repo) {
  return buildPath('toolchain', platformTag());
}

// The per-platform tjs template binary. A FOURTH keyed thing (see the file
// header's three): the patched txiki.js/QuickJS engine is a NATIVE binary, so it
// MUST be keyed by platform to survive a shared (NFS) tree that many platforms
// build into — a bare `build/tjs/tjs` let a macOS build and a NetBSD build clobber
// each other (and left a foreign-arch binary that defeated existence-only gates).
// Its axis is OS+arch ONLY: unlike toolchainDir it carries NO node major (tjs is a
// C binary with no node coupling), and unlike an artifact dir it carries no clode
// VERSION (tjs is versioned by its own source PIN, not clode's release). token/arch
// are injectable so a cross-build can name the TARGET's dir, not the host's. Like
// toolchainDir, this is a build TOOL/template — never shipped — so it resolves
// through the allocator rather than living under build/ in the checkout; `repo`
// is retained only for call-site compatibility and is deliberately unused.
function tjsDir(_repo, { token = osToken(), arch = process.arch } = {}) {
  return buildPath('tjs', `${token}-${arch}`);
}
// The tjs binary inside tjsDir. Host exe suffix (.exe on win32) — consumers resolve
// the host's own binary; CI cross-builds name the output path explicitly via
// CLODE_TJS_OUT instead of resolving through here.
function tjsBin(repo, opts = {}) {
  return path.join(tjsDir(repo, opts), process.platform === 'win32' ? 'tjs.exe' : 'tjs');
}

// The vendor SOURCE checkout's default PARENT dir — build-tjs.mjs's
// CLODE_TJS_VENDOR default (see its header comment). Local scratch (TMPDIR
// first, never the repo tree, which is commonly NFS-mounted on a dev box)
// unless CLODE_TJS_LOCAL_ROOT/CLODE_TJS_VENDOR override it. Exported so
// tests that drive or read that SAME checkout directly — test/tjs-darwin-
// poll-fixup.test.cjs, test/tls-cacert-pem.test.cjs — resolve the identical
// default instead of hand-copying it, which is exactly the drift class this
// file's header comment (three differently-keyed build/ dirs) warns about:
// a hardcoded 'spike/quickjs/vendor' in a test silently stops matching the
// real default the moment that default changes, and the test just skips
// forever instead of failing loud.
function tjsVendorParentDir(env = process.env) {
  if (env.CLODE_TJS_VENDOR) return env.CLODE_TJS_VENDOR;
  if (env.CLODE_TJS_LOCAL_ROOT) return path.join(env.CLODE_TJS_LOCAL_ROOT, 'clode-tjs-vendor');
  // DURABLE local scratch, deliberately NOT TMPDIR.
  //
  // The vendor checkout has two requirements that pull in opposite directions: it
  // must stay off NFS (the repo is commonly NFS-mounted, and a ~700MB checkout
  // there is the pathology localScratchRoot exists to avoid), and it must not be
  // REAPED. TMPDIR satisfied the first and failed the second: on macOS it resolves
  // under /var/folders, which the OS periodically cleans, and it was reaped twice
  // in one session — once silently breaking a build chain mid-flight.
  //
  // ~/.cache/clode is local, survives reboots, and is where clode already keeps
  // durable state. The XDG lookup is duplicated from libexec/clode-paths.cjs on
  // purpose rather than imported: this file already requires ./build-scratch.cjs
  // (a real dependency — node:child_process, a subprocess spawn — see that
  // module's own header, and this is no longer the "dependency-free leaf" it once
  // was; see repoVersion below for the matching note), but clode-paths.cjs is a
  // dependency of a DIFFERENT kind — it pulls in far more than a path helper
  // should just to duplicate a 3-line XDG lookup.
  //
  // Anyone whose HOME is on NFS should set CLODE_TJS_VENDOR (or
  // CLODE_TJS_LOCAL_ROOT) — the overrides above are unchanged, and CI already
  // sets one.
  const home = env.HOME || env.USERPROFILE;
  const xdg = env.XDG_CACHE_HOME || (home ? path.join(home, '.cache') : null);
  if (xdg) return path.join(xdg, 'clode', 'tjs-vendor');
  return path.join(env.TMPDIR || os.tmpdir(), 'clode-tjs-vendor');
}

// The VERSION file at the repo root — the same source scripts/build-clode-main.mjs's
// own repoVersion() reads (for the embedded __CLODE_BUNDLE_VERSION__ define).
// Duplicated on purpose, not shared: build-clode-main.mjs already requires THIS
// file, so the reverse (platform-tag.cjs requiring build-clode-main.mjs for a
// 3-line VERSION read) would be backwards. This file is NOT a dependency-free leaf
// any more — it requires ./build-scratch.cjs (toolchainDir/tjsDir/harnessDir all
// resolve through its buildPath(), which pulls in node:child_process to spawn a
// probe — see build-scratch.cjs's own header). The obligation that survives is
// narrower: platform-tag.cjs must still not require anything HEAVIER than that —
// no clode-paths.cjs, no build-clode-main.mjs — and every module it DOES require
// (build-scratch.cjs, canonical-name.cjs) must be carried explicitly in
// libexec/quaude-fuse.js's naude-assembler member list (test/naude-assembler-
// closure.test.cjs enforces this by walking the require closure; it is what
// caught build-scratch.cjs's addition needing a member-list entry).
function repoVersion(repo) {
  try { return fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').replace(/\n+$/, '') || 'dev'; }
  catch { return 'dev'; }
}

// The LOCAL, no-floor "own OS version" token for the artifact name, in the SAME
// canonical vocabulary the published asset name uses (see scripts/canonical-name.cjs):
// the OS word `macos` for Darwin and the version DASHED on (`macos-11.0`), matching
// the asset name's `<os>-<floor>-<arch>` shape so a local build dir looks exactly
// like the shippable name minus the floor's "deliberately chosen" status.
//
// Unlike a release leg's FLOOR (scripts/tjs-legs.mjs — a deliberately CHOSEN old
// compat target, e.g. macos-arm64's floor: '11.0'), this is the host's ACTUAL
// running OS version: a local build is not built against an old SDK, so it must
// never claim that floor (see CLODE_ASSET_NAME on artifactDir for how CI gets its
// real, floor-carrying name instead of this one).
function hostOsVersionToken(platform = process.platform) {
  if (platform === 'darwin') {
    const v = macosVersion();
    // macOS floors are always major.minor (10.6, 11.0, ...). macosVersion() returns
    // a bare marketing major for 11+ (e.g. "26") — pad it to match that SHAPE rather
    // than inventing a fake minor version that isn't true.
    return `macos-${v.includes('.') ? v : `${v}.0`}`;
  }
  if (platform === 'linux') return `linux-${linuxGlibc()}`; // no linux floor to shape-match; keep the honest token
  if (platform === 'win32') return 'windows';                // ABI-stable, no floor either
  // Anything else: no established floor vocabulary for this OS — degrade honestly to
  // the raw kernel/OS major (osToken's fallback shape). Never invent a floor-shaped
  // value for a platform that doesn't have one.
  return `${platform}-${String(os.release()).split('.')[0]}`;
}

// Pure formatter for the local artifact name: clode-<version>-<token>-<arch>, with
// the arch canonicalized (x64->amd64, ia32->i386) through the canonical-name source
// of truth so a local build dir == the published asset name. `token` defaults to
// hostOsVersionToken() (see its comment for why that is NOT osToken()/platformTag()'s
// token). Every input injectable, same discipline as platformTag().
function artifactName({
  version,
  token = hostOsVersionToken(),
  arch = process.arch,
} = {}) {
  return `clode-${version}-${token}-${canonArch(arch)}`;
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
// The `.exe` suffix must key off the TARGET being built for, not the host running
// clode: a cross-build's output runs on the target, so a host-driven `process.platform`
// check would be wrong (and, worse, silently right by luck on a non-Windows host cross-
// building for one — see canonical-name.cjs's targetToNode). `opts.target` (a canonical
// target/leg token) wins when present; no target (native build) falls back to the host,
// which is the pre-existing, still-correct behavior for every current caller.
function seaBin(repo, base, opts = {}) {
  const { target } = opts;
  let win32;
  if (target) {
    const { targetToNode } = require('./canonical-name.cjs');
    win32 = targetToNode(target)?.platform === 'win32'; // no windows target exists today -> always false
  } else {
    win32 = process.platform === 'win32';
  }
  return seaOut(repo, base, opts) + (win32 ? '.exe' : '');
}

module.exports = {
  macosVersion, linuxGlibc, osToken, platformTag, harnessDir, toolchainDir,
  repoVersion, hostOsVersionToken, artifactName, artifactDir, seaBin, seaOut,
  tjsDir, tjsBin, tjsVendorParentDir,
};
