'use strict';
// node:os — M1 surface.
//
// tjs.homeDir and tjs.tmpDir were verified (not just probed) against the
// pinned tjs v26.6.0 binary: `tjs eval 'console.log(typeof tjs.homeDir,
// typeof tjs.tmpDir)'` -> "string string", and both hold real absolute
// paths (tjs.homeDir === "$HOME", tjs.tmpDir === the OS temp dir). So the
// optimistic reads from the plan draft are correct and kept; the
// tjs.env.HOME / tjs.env.TMPDIR reads remain as fallbacks for engines/builds
// where those properties are absent.
//
// tmpdir() strips a trailing slash to match host node, but guards on
// length > 1 so a value of exactly "/" is left as "/" (host node's
// os.tmpdir() does the same length check — an unconditional strip would
// turn "/" into ""). Pinned by test/node-shim-path.test.cjs (TMPDIR=/ row).
// os.constants.signals (Task 4 wall): the -p boot's `human-signals` dependency
// destructures `os.constants.signals[NAME]` for every signal it enumerates —
// os.constants and its .signals map must be real objects. Characterized by
// test/node-shim-core.test.cjs (os.constants.signals row).
//
// DIVERGENCE: this is the DARWIN signal-number table (byte-identical to host
// node's os.constants.signals on darwin — the row asserts that). The numbers
// are platform-specific: Linux assigns several signals different numbers
// (e.g. SIGCHLD/SIGSTOP/SIGUSR1). We build/target darwin-arm64 and run on this
// darwin host, so the darwin table is correct here; wire a per-platform table
// (or read tjs signal constants, if a future tjs exposes them) when a Linux
// boot is actually driven. Only .signals is populated — the other host-node
// os.constants groups (errno/priority/dlopen/UV_*) are not read on the -p path;
// add them test-first if a later boot destructures them.
const SIGNALS_DARWIN = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGIOT: 6, SIGBUS: 10, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11,
  SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20, SIGCONT: 19,
  SIGSTOP: 17, SIGTSTP: 18, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 16, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 23, SIGINFO: 29,
  SIGSYS: 12,
};

// process.platform -> node's os.type() spelling (uname -s). One case per
// release-matrix identity; unknown values pass through untouched.
function unameType(p) {
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

module.exports = {
  homedir: () => tjs.homeDir ?? tjs.env.HOME ?? '/',
  tmpdir: () => { const v = tjs.tmpDir ?? tjs.env.TMPDIR ?? '/tmp'; return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v; },
  platform: () => process.platform,
  arch: () => process.arch,
  // os.type() (Task 4 wall): the -p boot compares os.type() against 'OS400'
  // (AIX/IBM i detection). Maps process.platform to Node's uname-style string,
  // covering every release-matrix identity now that detectPlatform is honest
  // (netbsd/dragonfly/midnightbsd/haiku joined when the 'linux' fallthrough
  // lie was fixed — see process.cjs detectPlatform). Characterized by
  // test/node-shim-platform.test.cjs.
  type: () => unameType(process.platform),
  __typeFor: unameType,               // test hook (node-shim-platform.test.cjs)
  // os.release() (Task 4 wall): the -p bundle builds the system prompt's
  // environment block with `${os.type()} ${os.release()}` (its `j_o` helper). A
  // missing os.release throws `TypeError: not a function` and crashes the query
  // session (surfaced as an error_during_execution result) BEFORE the Messages
  // POST. DIVERGENCE: this tjs build exposes no uname/kernel-release API
  // (tjs.system has cpus/loadAvg/networkInterfaces/uptime/userInfo only), so the
  // real kernel-release string is unavailable — return the empty string. This is
  // the OS-version suffix in a system-prompt line only (informational; the mock
  // ignores content and a live prompt is unaffected in substance). A path that
  // needs the true release is a future wall: add a tjs uname primitive then.
  // Characterized by test/node-shim-path.test.cjs (os.release/hostname row).
  release: () => '',
  // os.version() — same unavailability; empty string DIVERGENCE (see release()).
  version: () => '',
  hostname: () => tjs.hostName ?? tjs.env.HOSTNAME ?? 'localhost',
  networkInterfaces: () => (tjs.system && tjs.system.networkInterfaces) || {},
  // arm64/x64 are little-endian; this tjs build targets arm64 (see process.arch).
  endianness: () => 'LE',
  machine: () => process.arch,
  // Memory figures: tjs exposes no free/total memory API. DIVERGENCE: return 0 so
  // callers that only read `.length`/compare-to-0 don't crash; a path needing real
  // memory sizing is a future wall.
  freemem: () => 0,
  totalmem: () => 0,
  getPriority: () => 0,
  setPriority: () => {},
  EOL: '\n',
  // os.cpus()/availableParallelism (Task 4 wall): the -p boot sizes worker
  // parallelism from os.cpus().length. Backed by tjs.system.cpus, which is the
  // real per-core table in Node's exact shape (model/speed/times{user,nice,sys,
  // idle,irq}). Characterized by test/node-shim-path.test.cjs (os.cpus row).
  cpus: () => (tjs.system && tjs.system.cpus) || [],
  availableParallelism: () => ((tjs.system && tjs.system.cpus && tjs.system.cpus.length) || 1),
  loadavg: () => (tjs.system && tjs.system.loadAvg) || [0, 0, 0],
  uptime: () => (tjs.system && tjs.system.uptime) || 0,
  constants: { signals: SIGNALS_DARWIN },
  userInfo: () => ({ username: tjs.env.USER ?? 'unknown', homedir: module.exports.homedir() }),
};
