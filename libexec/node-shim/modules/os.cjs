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

// os.getPriority / os.setPriority: see internal/priority.cjs (a real value on every platform, PowerShell on Windows).
// The system is reached through the deps passed here, so that file loads under host node and its Windows branch is
// judged off Windows (test/node-shim-os-priority-win32.test.cjs).
const { getPriority, setPriority } = require('./../internal/priority.cjs').makePriority({
  platform: () => process.platform,
  pid: () => process.pid,
  errno: EC.errno,
  run(cmd, args) {
    const r = require('node:child_process').spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.error) return { missing: `${cmd} could not be run (${r.error.code || r.error.message})` };
    return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
  },
  readProcStat(pid) {
    const fs = require('node:fs');
    if (!fs.existsSync('/proc/self/stat')) return undefined;
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  },
});

// platform, arch, type, release, version and machine are node-shim's one host identity (internal/identity.cjs):
// the engine's compile-time platform and its uname, the same answers process.platform/arch give.
const identity = require('./../internal/identity.cjs');

module.exports = {
  homedir: () => tjs.homeDir ?? tjs.env.HOME ?? '/',
  tmpdir: () => { const v = tjs.tmpDir ?? tjs.env.TMPDIR ?? '/tmp'; return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v; },
  platform: () => identity.platform(),
  arch: () => identity.arch(),
  // os.type(), os.release(), os.version(): uname's sysname, release and version, as node answers them. The -p boot
  // compares os.type() against 'OS400' (AIX/IBM i detection), and the bundle builds the system prompt's environment
  // line from `${os.type()} ${os.release()}`; release() and version() answered '' until they read __tjs_uname.
  // Characterized by test/node-shim-platform.test.cjs.
  type: () => identity.type(),
  __typeFor: identity.typeFor,        // test hook (node-shim-platform.test.cjs)
  release: () => identity.release(),
  version: () => identity.version(),
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
  // The byte order this engine was built for, as node's is its build's. It said 'LE' everywhere, written when every
  // leg was arm64 or x64; the PowerPC, SPARC and s390x legs are big-endian.
  endianness: () => (new Uint8Array(Uint16Array.of(1).buffer)[0] === 1 ? 'LE' : 'BE'),
  // os.machine(): uname's machine, as node answers it ("x86_64" on x86_64 Linux, "arm64" on Apple silicon), from the
  // engine's __tjs_uname (txiki-uname-global.patch). It was process.arch, which is not the same string ("x64"): the
  // node-shim differential on linux-x64-musl read node "x86_64", quaude "x64" (2026-11-21). An engine without it is
  // REFUSED by name, never answered from a guessed arch-to-machine table (scripts/engine-api-floor.cjs).
  machine: () => {
    const u = identity.uname();
    if (!u) {
      const e = new Error('node-shim: this engine has no __tjs_uname (it predates txiki-uname-global.patch), so '
        + 'os.machine() cannot answer uname\'s machine; rebuild it: ./build.sh --only engine.compile');
      e.code = 'ERR_CLODE_ENGINE_FLOOR';
      require('../internal/engine-floor-log.cjs').engineFloorLog(e.message);
      throw e;
    }
    return u.machine;
  },
  // Memory figures: tjs exposes no free/total memory API. DIVERGENCE: return 0 so
  // callers that only read `.length`/compare-to-0 don't crash; a path needing real
  // memory sizing is a future wall.
  freemem: () => 0,
  totalmem: () => 0,
  getPriority,
  setPriority,
  EOL: (globalThis.process && process.platform === 'win32') ? '\r\n' : '\n',
  // node's os.devNull: the 2.1.283 bundle stats it to tell the null device from any other character
  // device (dirSync's stamp); undefined here, that stat failed and nothing was the null device.
  devNull: (globalThis.process && process.platform === 'win32') ? '\\\\.\\nul' : '/dev/null',
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
