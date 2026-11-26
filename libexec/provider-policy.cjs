'use strict';
// WHICH upstream Claude Code build a host uses: the policy `clode fetch claude` CHOOSES with and the provider store
// READS BACK with (libexec/clode-paths.cjs pickProviderEntry). One copy, pure and spawn-free, so the reader can ask it
// rather than restate it -- the restatement dropped the OS fallback and broke every NetBSD build (2026-11-25).
const canon = require('../scripts/canonical-name.cjs');

// Node process.platform/arch -> the upstream manifest platform string to fetch.
// Bun specializes each per-platform Claude Code build at compile time (folds
// process.platform/arch AND dead-code-eliminates the other platforms' branches),
// so a linux-x64 carve behaves as LINUX on every host (proven 2026-07-19). We
// therefore match the target's OS. Arch is don't-care for the carve: tjs loads no
// native .node addons and the sole arch-switch is moot, so any same-OS build
// carves the right OS branches. OSes upstream does not build (netbsd/freebsd/...)
// fall back to linux-x64 (Unix-closest branches), LOGGED, never silently.
// glibc runtime absent => musl (mirrors scripts/platform-tag.cjs linuxGlibc()).
function isMuslRuntime() {
  try { return !process.report.getReport().header.glibcVersionRuntime; }
  catch { return false; }
}

function providerFor(platform, arch, available, opts = {}) {
  const log = opts.log || (() => {});
  const has = (p) => available.includes(p);
  if (platform === 'linux') {
    const musl = 'isMusl' in opts ? opts.isMusl : isMuslRuntime();
    const exact = `linux-${arch}${musl ? '-musl' : ''}`;
    if (has(exact)) return exact;
    if (has(`linux-${arch}`)) return `linux-${arch}`;
    const anyLinux = available.find((p) => p.startsWith('linux-'));
    if (anyLinux) return anyLinux;
  } else if (platform === 'darwin' || platform === 'win32') {
    const exact = `${platform}-${arch}`;
    if (has(exact)) return exact;
    const sameOs = available.find((p) => p.startsWith(platform + '-')); // arch don't-care
    if (sameOs) return sameOs;
  }
  log(`clode: no upstream provider for ${platform}-${arch}; carving linux-x64 (Unix-closest branches)`);
  return has('linux-x64') ? 'linux-x64' : (available.find((p) => p.startsWith('linux-')) || 'linux-x64');
}

// DOES UPSTREAM CARVE FOR THIS OS AT ALL? Asked OF providerFor, never of a second list:
// hand it a hypothetical manifest offering BOTH a same-OS carve and the linux fallback and
// see which one it takes. If it reaches for the same-OS entry, upstream publishes that OS
// and a matching carve is one `clode fetch claude` away; if it still falls back to linux,
// this OS has no carve to fetch and the linux one is not a mistake — it is the documented
// outcome of the policy three lines up ("OSes upstream does not build (netbsd/freebsd/...)
// fall back to linux-x64 (Unix-closest branches), LOGGED, never silently").
//
// Derived, not declared. A hand-kept list of Bun's target OSes would be a second policy
// beside providerFor's, free to disagree with it — and the disagreement it would encode is
// precisely the bug this function exists to prevent: `clode build`'s carve gate refusing
// the very carve `clode fetch claude` is designed to hand it. The day providerFor learns a
// new upstream OS, this answers differently with no edit. Offline and pure: the probe is
// the policy's own branch structure, not a network call.
//
// The arch is don't-care (providerFor says so itself), so the caller need not know one;
// x64 stands in because every OS upstream publishes, it publishes for x64.
function upstreamCarvesOs(platform, arch = 'x64') {
  const sameOs = `${platform}-${arch}`;
  return providerFor(platform, arch, [sameOs, 'linux-x64'], { isMusl: false }).startsWith(`${platform}-`);
}

// The store key an upstream platform string is fetched under (`linux-x64` -> `linux-amd64`): the one derivation
// `clode fetch claude` writes with and libexec/clode-paths.cjs pickProviderEntry reads back with.
function providerKeyFor(plat) {
  const { os: fetchOs, arch: fetchArch } = canon.splitLeg(plat);
  return canon.targetFromNode(fetchOs, fetchArch);   // clode-paths providerKey's derivation
}

module.exports = { providerFor, upstreamCarvesOs, providerKeyFor, isMuslRuntime };
