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
// os.constants comes from the ENGINE, read from the headers it was compiled
// against — see internal/engine-constants.cjs for why there is no fallback table.
//
// What used to be here: SIGNALS_DARWIN, a hand-written darwin signal table with a
// comment conceding it was wrong on Linux, and (added the same day this was
// replaced) a hand-written errno base plus per-platform deltas. Both were guesses
// about platforms nobody was standing on. The engine knows; ask it.
const EC = require('./../internal/engine-constants.cjs');

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
  // node returns an OBJECT KEYED BY INTERFACE NAME; tjs returns an ARRAY. Passing it
  // through unchanged handed callers the wrong shape, and the existing characterization
  // (`typeof x === 'object'`) could not see it because an array satisfies that. Found
  // 2026-08-25 by running the tests on the engine. Group by name, as node does.
  networkInterfaces: () => {
    const raw = (tjs.system && tjs.system.networkInterfaces) || {};
    if (!Array.isArray(raw)) return raw;          // already keyed (or empty) — leave it
    const out = {};
    for (const i of raw) {
      const name = i && (i.name ?? i.interface);
      if (!name) continue;
      (out[name] ||= []).push(i);
    }
    return out;
  },
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
  constants: {
    signals: EC.signals,
    errno: EC.errno,
    dlopen: EC.dlopen,
    priority: EC.priority,
    UV_UDP_REUSEADDR: EC.UV_UDP_REUSEADDR,
  },
  // os.userInfo() (Task 5 fix, adjacent to process.getuid): was fabricating
  // from tjs.env.USER and omitting uid/gid/shell entirely — Node's real
  // shape is {username, uid, gid, shell, homedir}. tjs.system.userInfo (the
  // SAME real libuv primitive process.cjs's unixGetuid uses — see that
  // file's comment for the "tjs.userInfo doesn't exist, it's
  // tjs.system.userInfo" correction) has every one of those fields for real
  // (uv_os_get_passwd), so use it directly instead of a partial synthesis.
  // Falls back to the previous env-based synthesis (uid/gid -1, shell null —
  // Node's own win32 shape) only if tjs.system.userInfo is ever unavailable.
  userInfo: () => {
    const info = tjs.system?.userInfo;
    if (info) {
      return {
        username: info.userName,
        uid: info.userId,
        gid: info.groupId,
        shell: info.shell ?? null,
        homedir: info.homeDir ?? module.exports.homedir(),
      };
    }
    return { username: tjs.env.USER ?? 'unknown', uid: -1, gid: -1, shell: null, homedir: module.exports.homedir() };
  },
};
