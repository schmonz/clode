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

module.exports = {
  homedir: () => tjs.homeDir ?? tjs.env.HOME ?? '/',
  tmpdir: () => { const v = tjs.tmpDir ?? tjs.env.TMPDIR ?? '/tmp'; return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v; },
  platform: () => process.platform,
  arch: () => process.arch,
  // os.type() (Task 4 wall): the -p boot compares os.type() against 'OS400'
  // (AIX/IBM i detection). Maps process.platform to Node's uname-style string.
  type: () => {
    switch (process.platform) {
      case 'darwin': return 'Darwin';
      case 'linux': return 'Linux';
      case 'win32': return 'Windows_NT';
      case 'freebsd': return 'FreeBSD';
      case 'openbsd': return 'OpenBSD';
      case 'sunos': return 'SunOS';
      case 'aix': return 'AIX';
      default: return process.platform;
    }
  },
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
