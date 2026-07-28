'use strict';
// ONE source of truth for clode's OWN artifact names: the published asset filename,
// the `--list-targets` tag, the engine artifact name, and platform-tag's build/host
// tokens all derive from here, so a download name == its `--list-targets` tag == the
// engine a fetching clode looks for. Externally-fixed spellings are NOT produced here
// (they stay map-only in their own consumers): Node `process.arch`/`process.platform`,
// upstream Bun provider strings (`linux-x64`), NetBSD MACHINE_ARCH (`evbarm`), toolchain
// triples (`x86_64-apple-darwin`), file(1). Decisions locked 2026-07-27 (see
// docs/superpowers/plans/2026-07-27-arch-artifact-name-rationalization.md):
//   arch = common Unix/Debian vocabulary (amd64/arm64/i386/ppc/sparc/m68k/…);
//   OS word `macos` for the Darwin era; floor is DASHED (<os>-<floor>-<arch>);
//   engine/pin = <engine>-<os>-<arch>-<ver>[-<sha7>].

// OS word: only darwin -> macos. Everything else is already our canonical word
// (linux, windows, netbsd, freebsd, openbsd, dragonflybsd, omnios, openindiana,
// solaris, midnightbsd, haiku). win32/dragonfly are Node process.platform only.
const OS_MAP = { darwin: 'macos' };
// Arch: a TOTAL normalizer from every spelling that can reach a name-builder ->
// our canonical Unix/Debian vocabulary. It must handle the raw LEG TOKEN alone
// (bash's asset-name mirror has only the token, never guest-arch), so the NetBSD
// PORT names that some leg tokens use as their arch segment (macppc/pmax/sgimips)
// are normalized here too. Anything already canonical (amd64/arm64/i386/ppc/sparc/
// sparc64/m68k/mipsel/mipseb/mips64eb/riscv64/s390x/alpha/hppa/sh3el/loongarch64/
// armv7/earmv7hf/ppc64le) is absent -> identity.
const ARCH_MAP = {
  // our leg-token spellings
  x64: 'amd64', x86: 'i386',
  // NetBSD port names used as a token's arch segment (netbsd-macppc/-pmax/-sgimips)
  macppc: 'ppc', pmax: 'mipsel', sgimips: 'mipseb',
  // Node process.arch / native (Mach-O, CMAKE, guest-arch) spellings, so the same
  // map serves platform-tag's host arch and any guest-arch consumer.
  ia32: 'i386', x86_64: 'amd64', aarch64: 'arm64', powerpc: 'ppc',
};

function canonOs(os) { return OS_MAP[os] || os; }
function canonArch(arch) { return ARCH_MAP[arch] || arch; }

// Split a leg token `<os>-<arch>[-<libc>]`: os is the first segment, arch the second,
// and a trailing `musl`/`glibc` (only on 3-segment legs) is the libc variant.
function splitLeg(leg) {
  const parts = leg.split('-');
  const last = parts[parts.length - 1];
  const libc = (parts.length >= 3 && (last === 'musl' || last === 'glibc')) ? last : null;
  return { os: parts[0], arch: parts[1], libc };
}

// Canonical target name `<os>-<arch>` (libc dropped) — the manifest key + the
// successor to build-templates' cleanTargetName.
function targetName(leg) {
  const { os, arch } = splitLeg(leg);
  return `${canonOs(os)}-${canonArch(arch)}`;
}

// The canonical tag shared by the published asset filename and the `--list-targets`
// tag. Floored: `<os>-<floor>-<arch>` (dashed). Bare: `<os>-<arch>[-<libc>]`.
function tagFor(leg, floor) {
  const { os, arch, libc } = splitLeg(leg);
  const co = canonOs(os), ca = canonArch(arch);
  if (floor) return `${co}-${floor}-${ca}`;
  return libc ? `${co}-${ca}-${libc}` : `${co}-${ca}`;
}

// Published builder asset filename.
function assetName(leg, version, floor) {
  return `clode-${version}-${tagFor(leg, floor)}`;
}

// Engine artifact name `<engine>-<os>-<arch>-<pin>` (engine: 'tjs' | 'node'). The pin
// is `<ver>[-<sha7>]` (no `v`; source-sha only for source-built engines) — its
// producer/verifier live where the version is known (build-templates tjsPinFromPins).
function engineName(engine, leg, pin) {
  return `${engine}-${targetName(leg)}-${pin}`;
}

// Reverse the canonical vocabulary to Node's own process.platform/process.arch
// spelling, for the naude Node fetch (clode-node.cjs speaks Node's names). Accepts
// both a canonical target (macos-amd64) and a raw leg token (darwin-x64). Returns
// null for a well-formed target whose OS is not one Node ships a binary for — the
// caller turns that into "naude is Node-only; use quaude". Node publishes
// darwin/linux/win32.
// keyed by canonOs() output (macos, linux, windows), not raw process.platform
const OS_TO_NODE = { macos: 'darwin', linux: 'linux', windows: 'win32' };
// keyed by canonArch() output (amd64, arm64), not raw process.arch
const ARCH_TO_NODE = { amd64: 'x64', arm64: 'arm64' };
function targetToNode(target) {
  const { os, arch } = splitLeg(target);
  const platform = OS_TO_NODE[canonOs(os)];
  const nodeArch = ARCH_TO_NODE[canonArch(arch)];
  if (!platform || !nodeArch) return null;
  return { platform, arch: nodeArch };
}

module.exports = {
  OS_MAP, ARCH_MAP, canonOs, canonArch, splitLeg, targetName, tagFor, assetName, engineName,
  targetToNode,
};
