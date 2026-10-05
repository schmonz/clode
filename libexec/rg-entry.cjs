'use strict';
// rg-entry.cjs — quaude's rg as a COMMAND: what the Bash tool's `rg` runs (grep-native Task 10c, user ruling
// 2026-10-04: mirror native exactly).
//
// NATIVE'S SHAPE (2.1.283's snapshot writer, mAn/aAn/dbe). Every snapshot carries, in every mode,
//
//     if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then
//       function rg { ... ARGV0=rg "$_cc_bin" ${1+"$@"} ... (exec -a rg "$_cc_bin" ${1+"$@"}) ... }
//     fi
//
// so the Bash tool's `rg` is the host's ripgrep when one is installed, and otherwise the claude binary itself run
// with argv[0] `rg`, which answers as its embedded ripgrep. `--allowedTools` (searchToolsOptIn) only decides the
// SEPARATE find/grep shadows. quaude mirrors it: bun-shim's snapshot rewrite writes rgShadowFunction() below in
// that same place, inside that same guard, and a quaude (or naude) whose invocation isRgInvocation() reads as rg
// runs main() below BEFORE any of the bundle loads (libexec/quaude-bootstrap.mjs, libexec/naude-entry.cjs). main()
// answers with rg-native.cjs, the rg every Grep and Glob call gets and test/fidelity/rg-differential.test.cjs
// judges byte for byte against native's embedded rg; its Bash-route column judges THIS route the same way.
//
// THE RULES THIS FILE STATES (each has a same-named test in test/rg-entry.test.cjs, its literals from native):
//   RG-ARGV0          which invocations are rg: isRgInvocation
//   RG-IMPLICIT-PATH  what a pathless rg searches: implicitPath (rg-native.cjs reads the answer)
//   RG-CONFIG         RIPGREP_CONFIG_PATH, which native's Bash `rg` reads and quaude's rg cannot: refused by name
//
// bun-shim.cjs requires this file (for rgShadowFunction), so it travels beside bun-shim in every packaging
// (test/shim-companions.test.cjs); its own companion is rg-native.cjs, required on first use. Node builtins only.
// Node builtins are required where they are used, never at the top: the quaude bootstrap evaluates this file before
// any module system exists, for isRgInvocation alone (libexec/quaude-bootstrap.mjs).
const fsm = () => require('fs');
const pathm = () => require('path');

// RG-ARGV0: native 2.1.283 (darwin-arm64, measured 2026-10-04, `--version` under each spelling) answers as rg when
// argv[0]'s last path component is exactly `rg` (`rg`, `/x/rg`, a symlink named rg), or when the environment's
// ARGV0 is exactly `rg` (bash's `ARGV0=rg cmd` exports it; upstream's msys branch spells rg that way); not `RG`,
// not `rg.exe`, not ARGV0=/x/rg, not `a\rg` or `C:rg` (a backslash and a drive are no separators off Windows). A path
// component is the platform's: `/` off Windows; on Windows `\` and `/`, after any drive (unmeasured there). Stated
// ONCE: naude's entry requires it, and the quaude bootstrap evaluates this file's member for it.
const RG_ARGV0 = 'rg';
function isRgInvocation(argv0, env, platform = typeof process !== 'undefined' ? process.platform : '') {
  if (env && env.ARGV0 === RG_ARGV0) return true;
  if (typeof argv0 !== 'string') return false;
  const leaf = platform === 'win32' ? argv0.split(/[\\/]/).pop().replace(/^[A-Za-z]:/, '') : argv0.split('/').pop();
  return leaf === RG_ARGV0;
}

// The shell function the snapshot defines rg as: upstream's own writer (2.1.283's dbe) called as dbe("rg", "rg")
// — the shape native's snapshot carries, line for line, with quaude's own binary as the fallback where native
// names its install path (test/build-gates/shadow-writer-gates.test.cjs evaluates the carve's writer and holds
// this to it). It runs whatever CLAUDE_CODE_EXECPATH names, which the bundle sets in the Bash tool's environment
// to process.execPath: the quaude or naude binary, which answers as rg (above).
// WINDOWS (unmeasured, as native's writer does there): the fallback is spelled as msys sees it (C:\a\b -> /c/a/b).
function shWord(s) {
  return /^[A-Za-z0-9_\/.,:+=@%-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'"'"'`)}'`;
}
function rgShadowFunction(execPath, platform = process.platform) {
  const self = platform === 'win32' ? String(execPath).replace(/^([A-Za-z]):[\\/]/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : execPath;
  const args = '${1+"$@"}';
  return [
    'function rg {',
    '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
    `  [[ -x $_cc_bin ]] || _cc_bin=${shWord(self)}`,
    `  if [[ ! -x $_cc_bin ]]; then command rg ${args}; return; fi`,
    '  if [[ -n ${ZSH_VERSION:-} ]]; then',
    `    ARGV0=${RG_ARGV0} "$_cc_bin" ${args}`,
    '  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then',
    `    ARGV0=${RG_ARGV0} "$_cc_bin" ${args}`,
    '  else',
    `    (exec -a ${RG_ARGV0} "$_cc_bin" ${args})`,
    '  fi',
    '}',
  ].join('\n');
}

// RG-IMPLICIT-PATH: a pathless rg searches its stdin when that is a regular file, a FIFO or a socket, and ./
// otherwise (a terminal, a character device such as the /dev/null the Bash tool gives every command, a closed
// fd 0): ripgrep 14.1.1's hiargs.rs over grep-cli's is_readable_stdin. --files always lists ./ (rg-native.cjs).
function implicitPath(fstat0 = () => fsm().fstatSync(0)) {
  try {
    const st = fstat0();
    return st.isFile() || st.isFIFO() || st.isSocket() ? 'stdin' : 'cwd';
  } catch { return 'cwd'; }
}

// fd 0, a piece at a time (RG-STREAM: rg searches its stdin as it arrives). A read that fails with ENXIO or EBADF is
// the END of the input, as Rust's stdin reads a closed fd 0 (native 2.1.283, `rg needle - <&-`: nothing read, rc 1, no
// message): under tjs a closed fd 0 is not closed by the time any JS runs (libuv's kqueue takes the number on darwin
// and NetBSD, reading as a FIFO and failing ENXIO; Linux's epoll reads as no FIFO, so it is ./ at once). Any other
// failure (EAGAIN from a non-blocking stdin with nothing in it) is rg's error for <stdin>, as native's
// (`rg: <stdin>: Resource temporarily unavailable (os error 35)`, rc 2): never waited out.
const closedStdin = (e) => !!e && (e.code === 'ENXIO' || e.code === 'EBADF');
function stdinPieces(readFd = (b) => fsm().readSync(0, b, 0, b.length, null)) {
  const piece = Buffer.alloc(64 * 1024);
  let ended = false;
  const next = () => {
    if (ended) return null;
    let n;
    try { n = readFd(piece); } catch (e) { if (closedStdin(e)) { ended = true; next.closed = true; return null; } throw e; }
    if (!n) { ended = true; return null; }
    return Buffer.from(piece.subarray(0, n));
  };
  next.closed = false;            // the end was a closed fd 0
  return next;
}

// The ugrep quaude's rg searches with: CLODE_UGREP, else the first executable `ugrep` on PATH (bun-shim's which()
// rule, without the bundle-facing rg special case: rg is never looked up).
function findUgrep(env) {
  if (env.CLODE_UGREP) return env.CLODE_UGREP;
  const fs = fsm(), path = pathm();
  const win = process.platform === 'win32';
  const leaves = win ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((x) => 'ugrep' + x.toLowerCase()) : ['ugrep'];
  for (let dir of String(env.PATH || '').split(path.delimiter)) {
    if (win && dir.length > 1 && (dir[0] === '"' || dir[0] === "'") && dir[dir.length - 1] === dir[0]) dir = dir.slice(1, -1);
    if (!dir) continue;
    for (const leaf of leaves) {
      const p = path.join(dir, leaf);
      // runnable: a regular file, with an execute bit off Windows (where there are none: PATHEXT decides)
      try { const st = fs.statSync(p); if (st.isFile() && (win || (st.mode & 0o111) !== 0)) return p; } catch { /* next */ }
    }
  }
  return null;
}

// rg's stdout and stderr, as Rust's std writes them. EPIPE (a reader that went away: `rg x | head -1`) ends rg at
// once and quietly (native dies of SIGPIPE: the shell's 141); a closed fd (`rg x >&-`: EBADF, or ENXIO under tjs) writes nothing, the
// search going on to its own status (native: rc 0 for a match). stderr's failures change nothing (rc 2 stays 2).
const sinkClosed = () => Object.assign(new Error('rg: the reader went away'), { sinkClosed: true });
function fdWriter(fd, { quiet = false } = {}) {
  const fs = fsm();
  let gone = false;
  return (buf) => {
    let off = 0;
    while (!gone && off < buf.length) {
      let n;
      try { n = fs.writeSync(fd, buf, off, buf.length - off); } catch (e) {
        if (e && e.code === 'EAGAIN') continue;
        // a closed fd under tjs is libuv's kqueue by now (writing it fails ENXIO), as a closed fd 0 is (above)
        if (quiet || (e && (e.code === 'EBADF' || e.code === 'ENXIO'))) { gone = true; return; }
        if (e && e.code === 'EPIPE') throw sinkClosed();
        throw e;
      }
      off += n;
    }
  };
}

// The command. io is injectable for tests; the defaults are this process's own.
function main(io = {}) {
  const rgn = require(__dirname + '/rg-native.cjs');
  const {
    argv = process.argv.slice(2), env = process.env, cwd = process.cwd(),
    fstat0, readFd, out = fdWriter(1), err = fdWriter(2, { quiet: true }),
    exit = (c) => process.exit(c),
  } = io;
  const debug = (args, verdict) => { if (env.CLODE_RG_DEBUG) err(Buffer.from(`clode rg-debug: rg ${args.join(' ')} ${verdict}\n`)); };
  let implicit = implicitPath(fstat0);
  const parsed = rgn.parseRgSearch(argv, { implicit });
  // RG-CONFIG: native's shell function runs its rg without --no-config, so native's Bash `rg` reads the file
  // RIPGREP_CONFIG_PATH names (an empty value names none); quaude's rg reads no config file.
  if (env.RIPGREP_CONFIG_PATH && !(parsed.spec && parsed.spec.noConfig)) {
    return finish(rgn.rgRefusal(`quaude answers rg with its own emulation over ugrep, on purpose, and it cannot yet read the config file `
      + `RIPGREP_CONFIG_PATH names (${env.RIPGREP_CONFIG_PATH}), which native's rg reads, so it refuses rather than search `
      + 'without it (unset it, or pass --no-config); nothing was searched'), err, exit);
  }
  const pieces = stdinPieces(readFd);
  // RG-IMPLICIT-PATH, a closed fd 0: native finds no readable stdin there and searches ./ (`rg needle <&-`). Under tjs
  // that fd 0 reads as a FIFO (above), so a pathless search reads its first piece before it starts: one that meets a
  // closed fd 0 is the ./ search native makes.
  let ahead = null;
  if (parsed.spec && parsed.spec.implicitStdin) {
    let piece = null, error = null;
    try { piece = pieces(); } catch (e) { error = e; }
    if (!error && piece === null && pieces.closed) implicit = 'cwd';
    else ahead = { piece, error };
  }
  const stdinChunk = () => {
    if (ahead) { const a = ahead; ahead = null; if (a.error) throw a.error; return a.piece; }
    return pieces();
  };
  const input = () => { const all = []; for (let c; (c = stdinChunk());) all.push(c); return Buffer.concat(all); };
  let r;
  try {
    r = rgn.runRg(argv, { cwd, env, implicit, input, stdinChunk, stream: true, sink: out, ugrep: () => findUgrep(env), debug });
  } catch (e) {
    if (e && e.sinkClosed) { exit(141); return; }
    throw e;
  }
  try { out(r.stdout || Buffer.alloc(0)); } catch (e) { if (e && e.sinkClosed) { exit(141); return; } throw e; }
  return finish(r, err, exit);
}

function finish(r, err, exit) {
  err(r.stderr || Buffer.alloc(0));
  exit(typeof r.status === 'number' ? r.status : 2);
}

module.exports = { RG_ARGV0, isRgInvocation, rgShadowFunction, implicitPath, stdinPieces, findUgrep, main };

if (require.main === module) main();
