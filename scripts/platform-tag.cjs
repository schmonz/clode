'use strict';
// A platform tuple that isolates build/test artifacts which are MUTUALLY INCOMPATIBLE
// across machines sharing one (possibly NFS) workdir. Both the SEA binary and the PTY
// test harness embed/compile native code that won't run on a different OS, OS version
// (a binary built for macOS 26 won't run on Mavericks), CPU arch, or Node major.
// Scoping every such artifact under this tag means those environments never share a
// path, so one host's native binary can't clobber another's.
//
//   os.release() gives the kernel major, which maps 1:1 to the OS version on macOS
//   (Darwin 25 = macOS 26, Darwin 13 = OS X 10.9). On Linux it's the kernel major —
//   coarser than the real glibc/musl ABI axis, but only ever OVER-splits (an extra
//   dir, never a wrong-binary overwrite), which is the safe direction to err.
const os = require('os');
const path = require('path');

function platformTag(
  platform = process.platform,
  release = os.release(),
  arch = process.arch,
  nodeVersion = process.versions.node,
) {
  const osMajor = String(release).split('.')[0];
  const nodeMajor = String(nodeVersion).split('.')[0];
  return `${platform}-${osMajor}-${arch}-node${nodeMajor}`;
}

// The per-tag SEA build output dir (holds the toolchain node_modules, the bundle,
// deps.tar, the blob, and the final `clode` binary).
function seaOut(repo) {
  return path.join(repo, 'build', platformTag());
}

// The per-tag PTY/TUI test-harness dir (holds node_modules with node-pty's native
// binary). Kept under a dotdir so `test/` stays uncluttered and it's trivially ignored.
function harnessDir(repo) {
  return path.join(repo, 'test', '.harness', platformTag());
}

module.exports = { platformTag, seaOut, harnessDir };
