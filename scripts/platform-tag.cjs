'use strict';
// A platform tuple that isolates build/test artifacts which are MUTUALLY INCOMPATIBLE
// across machines sharing one (possibly NFS) workdir. Both the SEA binary and the PTY
// test harness embed/compile native code that won't run on a different OS, OS version,
// CPU arch, or Node major. Scoping every such artifact under this tag means those
// environments never share a path, so one host's native binary can't clobber another's.
//
// The OS-version token is chosen to be HUMAN-MEANINGFUL and to name the portability
// floor, not just to be unique:
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
function platformTag({
  token = osToken(),
  arch = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  const nodeMajor = String(nodeVersion).split('.')[0];
  return `${token}-${arch}-node${nodeMajor}`;
}

// The per-tag SEA build output dir (toolchain node_modules, bundle, deps.tar, blob, bin).
function seaOut(repo) {
  return path.join(repo, 'build', platformTag());
}

// The per-tag SEA output BINARY (sibling of seaOut's dir). .exe on Windows.
function seaBin(repo, platform = process.platform) {
  return path.join(seaOut(repo), platform === 'win32' ? 'clode.exe' : 'clode');
}

// The per-tag PTY/TUI test-harness dir (node_modules with node-pty's native binary).
function harnessDir(repo) {
  return path.join(repo, 'test', '.harness', platformTag());
}

module.exports = { macosVersion, linuxGlibc, osToken, platformTag, seaOut, seaBin, harnessDir };
