'use strict';
// node-shim's ONE host identity: process.platform and process.arch, and node:os's platform, arch, type, release,
// version and machine, all answered from here (latent-capabilities audit, D5). It was three derivations: process.cjs
// read the platform from navigator and SPAWNED `uname -m` for the arch (PROCESSOR_ARCHITECTURE on win32), os.cjs
// read __tjs_uname for machine() only, mapped the platform back to a type() spelling, and answered release() and
// version() with '' (the system prompt's "<type> <release>" line went out with no release).
//
// WHERE EACH ANSWER COMES FROM, as node's own:
//   platform  the engine's COMPILE-TIME platform (txiki's TJS__PLATFORM, lowercase CMAKE_SYSTEM_NAME, which only
//             navigator.userAgentData.platform carries out of tjs:internal/core), as node's process.platform is
//             its build's. See detectPlatform below.
//   type, release, version, machine
//             the engine's __tjs_uname (txiki-uname-global.patch): libuv's uv_os_uname, the call node's os module
//             makes, so each is node's string exactly ("Darwin", "27.2.0", "Darwin Kernel Version ...", "arm64").
//   arch      __tjs_uname's machine in node's spelling (machineToNodeArch). node's process.arch is the arch the
//             binary was compiled for; uname answers the running process, which is the same thing for a native
//             build, under Rosetta (macOS translates uname for an x86_64 process) and under Windows-on-ARM's x64
//             emulation (libuv reads GetSystemInfo, the emulated view, not GetNativeSystemInfo). No leg is known
//             where they differ; the engine exposes no compile-time arch to check against.
//
// This is RUNTIME identity. The build's vocabulary for the same facts (amd64, macos, floors) is
// scripts/canonical-name.cjs, deliberately separate; and the carve's own constant-folded platform constants are
// the bundle's (see carve-platform-constant-folding), not answered here.
//
// THE OLDER ENGINE. The bootstrap engine (scripts/bootstrap-engine.manifest.json's v0.20260831.1) predates
// __tjs_uname and still runs node-shim for the build, which reads process.arch. On it arch takes the route it always
// took (`uname -m` spawned, PROCESSOR_ARCHITECTURE on win32: the same answers, slower, so not refused and not
// logged); type() maps the platform; release() and version() answer '' as they always did; machine() is refused
// by name (os.cjs). Delete the route when the bootstrap tag passes txiki-uname-global.patch (2026-11-21).

// The 5-case uaPlatform->node switch lives ONCE in target-env.cjs's mapPlatform (the require-free member quaude's
// blobulated bootstrap evaluates pre-node-shim); node-shim has require, so it requires the shared file.
const { mapPlatform } = require('../../target-env.cjs');

// Honest process.platform for EVERY release-matrix leg. The old version enumerated Mac/Win/Linux/FreeBSD/OpenBSD
// and DEFAULTED to 'linux', so 8 of the 22 tjs builder legs (netbsd x2, dragonflybsd, midnightbsd, the three
// SunOS/illumos legs, haiku) lied: quaude-on-NetBSD read "Platform: linux" in its own system prompt while uname said
// NetBSD. Primary signal: navigator.userAgentData.platform, which txiki maps for its big five and passes through
// VERBATIM (lowercase CMAKE_SYSTEM_NAME: 'netbsd', 'dragonfly', 'sunos', 'midnightbsd', 'haiku', ...) for everything
// else, matching node's process.platform convention for every known case. Fallback, LOCAL to this module: the
// legacy navigator.platform regexes, for when ua is empty (quaude's blobulated bootstrap never has this second
// signal, so it stays out of the shared mapping). txiki's fallthrough there is "<platform> <machine>" (first token
// = the same lowercase name). Characterized by test/node-shim-platform.test.cjs.
function detectPlatform(uaPlatform, navPlatform) {
  const ua = uaPlatform
    ?? (typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.platform)
    ?? '';
  if (ua) return mapPlatform(ua);
  const np = navPlatform ?? ((typeof navigator !== 'undefined' && navigator.platform) || '');
  if (/^Mac/.test(np)) return 'darwin';
  if (/^Win/.test(np)) return 'win32';
  if (/^Linux/.test(np)) return 'linux';
  if (/^FreeBSD/i.test(np)) return 'freebsd';
  if (/^OpenBSD/i.test(np)) return 'openbsd';
  if (np) return np.split(' ')[0].toLowerCase();
  return 'linux';
}

let _platform;
const platform = () => (_platform ??= detectPlatform());

// The engine's uname, read once (it cannot change under a running process); null on an engine without it.
let _uname;
function uname() {
  if (_uname === undefined) _uname = typeof globalThis.__tjs_uname === 'function' ? globalThis.__tjs_uname() : null;
  return _uname;
}

// uname's machine -> node's process.arch spelling. The old hardcoded 'arm64' here was the Mavericks-build bug: on an
// x86_64 host it made codesignAdHoc (clode-build.cjs) thin the genuinely-fat tjs template down to arm64. Unknown ->
// 'x64' (safe, never the arm64 lie). NetBSD reports 'evbarm' on arm64 (mapping, not passthrough), Windows 'i386'
// .. 'i686' for x86 (libuv appends the processor level), Mac OS X on PowerPC 'Power Macintosh'.
function machineToNodeArch(machine) {
  const m = String(machine || '').trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64') return 'x64';
  if (m === 'arm64' || m === 'aarch64' || m === 'evbarm') return 'arm64';
  if (m === 'i386' || m === 'i486' || m === 'i586' || m === 'i686' || m === 'x86') return 'ia32';
  if (m === 'arm' || /^armv[4-8]/.test(m)) return 'arm';
  if (m === 'ppc64le' || m === 'ppc64') return 'ppc64';
  if (m === 'ppc' || m === 'powerpc' || m === 'power macintosh') return 'ppc';
  if (m === 's390x') return 's390x';
  if (m === 'riscv64') return 'riscv64';
  return m || 'x64';
}

// The older engine's win32 arch: PROCESSOR_ARCHITECTURE (ARM64 | AMD64 | x86), which Windows sets per process.
function winArch(env = (typeof tjs !== 'undefined' && tjs.env) || {}) {
  const pa = String(env.PROCESSOR_ARCHITECTURE || '').toUpperCase();
  if (pa === 'ARM64') return 'arm64';
  if (pa === 'X86') return 'ia32';
  return 'x64'; // AMD64 or unknown -> x64 (the safe existing default)
}

// The older engine's POSIX machine: `uname -m`, spawned. uname-unavailable -> '' (machineToNodeArch's 'x64').
function spawnedMachine() {
  try {
    const r = require('node:child_process').spawnSync('uname', ['-m'], { encoding: 'utf8' });
    return r && r.stdout != null ? String(r.stdout).trim() : '';
  } catch { return ''; }
}

let _arch;
function arch() {
  if (_arch) return _arch;
  const u = uname();
  if (u) return (_arch = machineToNodeArch(u.machine));
  return (_arch = platform() === 'win32' ? winArch() : machineToNodeArch(spawnedMachine()));
}

// node's os.type() spellings by platform: only the older engine's answer, with no uname to read.
function typeFor(p) {
  switch (p) {
    case 'darwin': return 'Darwin';
    case 'linux': return 'Linux';
    case 'win32': return 'Windows_NT';
    case 'freebsd': return 'FreeBSD';
    case 'openbsd': return 'OpenBSD';
    case 'netbsd': return 'NetBSD';
    case 'dragonfly': return 'DragonFly';
    case 'midnightbsd': return 'MidnightBSD';
    case 'haiku': return 'Haiku';
    case 'sunos': return 'SunOS';
    case 'aix': return 'AIX';
    default: return p;
  }
}

const type = () => (uname() ? uname().sysname : typeFor(platform()));
const release = () => (uname() ? uname().release : '');
const version = () => (uname() ? uname().version : '');

module.exports = { platform, arch, type, release, version, uname, detectPlatform, machineToNodeArch, winArch, typeFor };
