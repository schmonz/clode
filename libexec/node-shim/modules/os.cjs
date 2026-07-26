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

// Linux's os.constants.signals differs from darwin's in BOTH numbers (SIGBUS 7,
// SIGUSR1 10, SIGCHLD 17, …) AND its name SET (SIGSTKFLT/SIGPWR/SIGPOLL/SIGUNUSED
// exist; SIGINFO/SIGEMT do NOT). A darwin base overlaid with __tjs_signals leaks
// darwin-only names (SIGINFO) that Linux node lacks, so os.constants.signals fails
// deep-equality there (node-shim-core, excluded until now). Match node's Linux
// table exactly instead. Node lists SIGABRT/SIGIOT (6), SIGIO/SIGPOLL (29) and
// SIGSYS/SIGUNUSED (31) as aliases.
const SIGNALS_LINUX = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18,
  SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29,
  SIGPWR: 30, SIGSYS: 31, SIGUNUSED: 31,
};

// os.constants.signals must deep-equal host node's ON THIS PLATFORM (node-shim-core).
// darwin and the BSDs already match the darwin base (numbers agree; __tjs_signals
// fills any platform extras like NetBSD's SIGPWR). Linux needs its own table (above)
// — the exact-set difference can't be reached by overlaying darwin. Select by
// platform; unknown platforms keep the darwin-base + __tjs_signals merge.
const _tjsSig = globalThis.__tjs_signals && Object.keys(globalThis.__tjs_signals).length
  ? globalThis.__tjs_signals : null;
const SIGNALS = process.platform === 'linux'
  ? SIGNALS_LINUX
  : (_tjsSig ? { ...SIGNALS_DARWIN, ..._tjsSig } : SIGNALS_DARWIN);

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
  // arm64/x64 are little-endian; process.arch is now leg-scoped (arm64 on
  // most legs, x64 on win32 — see process.cjs), and both are LE.
  endianness: () => 'LE',
  machine: () => process.arch,
  // Memory figures: tjs exposes no free/total memory API. DIVERGENCE: return 0 so
  // callers that only read `.length`/compare-to-0 don't crash; a path needing real
  // memory sizing is a future wall.
  freemem: () => 0,
  totalmem: () => 0,
  getPriority: () => 0,
  setPriority: () => {},
  EOL: (globalThis.process && process.platform === 'win32') ? '\r\n' : '\n',
  // os.cpus()/availableParallelism (Task 4 wall): the -p boot sizes worker
  // parallelism from os.cpus().length. Backed by tjs.system.cpus, which is the
  // real per-core table in Node's exact shape (model/speed/times{user,nice,sys,
  // idle,irq}). Characterized by test/node-shim-path.test.cjs (os.cpus row).
  cpus: () => (tjs.system && tjs.system.cpus) || [],
  availableParallelism: () => ((tjs.system && tjs.system.cpus && tjs.system.cpus.length) || 1),
  loadavg: () => (tjs.system && tjs.system.loadAvg) || [0, 0, 0],
  uptime: () => (tjs.system && tjs.system.uptime) || 0,
  constants: { signals: SIGNALS },
  userInfo: () => ({ username: tjs.env.USER ?? 'unknown', homedir: module.exports.homedir() }),
};
