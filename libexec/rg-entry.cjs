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
const fs = require('fs');
const path = require('path');

// RG-ARGV0: native 2.1.283 (darwin-arm64, measured 2026-10-04, `--version` under each spelling) answers as rg when
// argv[0]'s last path component is exactly `rg` (`rg`, `/x/rg`, a symlink named rg), or when the environment's
// ARGV0 is exactly `rg` (bash's `ARGV0=rg cmd` exports it; upstream's msys branch spells rg that way); not `RG`,
// not `rg.exe`, not ARGV0=/x/rg. The leaf is rg-native.cjs leafOf's rule (both separators, a drive prefix off), one
// rule on every platform. libexec/quaude-bootstrap.mjs carries a copy (it cannot require anything); the test holds
// the copies to the same table.
const RG_ARGV0 = 'rg';
function isRgInvocation(argv0, env) {
  if (env && env.ARGV0 === RG_ARGV0) return true;
  return typeof argv0 === 'string' && argv0.split(/[\\/]/).pop().replace(/^[A-Za-z]:/, '') === RG_ARGV0;
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
function implicitPath(fstat0 = () => fs.fstatSync(0)) {
  try {
    const st = fstat0();
    return st.isFile() || st.isFIFO() || st.isSocket() ? 'stdin' : 'cwd';
  } catch { return 'cwd'; }
}

// fd 0, whole, read only when the search reaches it: { bytes, failed }. A read that fails is the end of the input,
// as Rust's stdin reads a closed fd 0 (native 2.1.283, `rg needle - <&-`: nothing read, rc 1, no message).
// `failed` with nothing read tells main() fd 0 was never a readable stdin (below).
function readStdin(fd = 0) {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n;
    try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) {
      if (e && e.code === 'EAGAIN') continue;
      return { bytes: Buffer.concat(chunks), failed: true };
    }
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return { bytes: Buffer.concat(chunks), failed: false };
}

// The ugrep quaude's rg searches with: CLODE_UGREP, else the first executable `ugrep` on PATH (bun-shim's which()
// rule, without the bundle-facing rg special case: rg is never looked up).
function findUgrep(env) {
  if (env.CLODE_UGREP) return env.CLODE_UGREP;
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

// Everything written, or the reader gone (EPIPE): a reader that went away ends rg, quietly.
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    let n;
    try { n = fs.writeSync(fd, buf, off, buf.length - off); } catch (e) {
      if (e && e.code === 'EAGAIN') continue;
      if (e && e.code === 'EPIPE') return false;
      throw e;
    }
    off += n;
  }
  return true;
}

// The command. io is injectable for tests; the defaults are this process's own.
function main(io = {}) {
  const rgn = require(__dirname + '/rg-native.cjs');
  const {
    argv = process.argv.slice(2), env = process.env, cwd = process.cwd(),
    fstat0, stdin = () => readStdin(0), out = (b) => writeAll(1, b), err = (b) => writeAll(2, b),
    exit = (c) => process.exit(c),
  } = io;
  const debug = (args, verdict) => { if (env.CLODE_RG_DEBUG) err(Buffer.from(`clode rg-debug: rg ${args.join(' ')} ${verdict}\n`)); };
  // RG-CONFIG: native's shell function runs its rg without --no-config, so native's Bash `rg` reads the file
  // RIPGREP_CONFIG_PATH names (an empty value names none); quaude's rg reads no config file.
  const implicit = implicitPath(fstat0);
  const parsed = rgn.parseRgSearch(argv, { implicit });
  if (env.RIPGREP_CONFIG_PATH && !(parsed.spec && parsed.spec.noConfig)) {
    const r = rgn.rgRefusal(`quaude answers rg with its own emulation over ugrep, on purpose, and it cannot yet read the config file `
      + `RIPGREP_CONFIG_PATH names (${env.RIPGREP_CONFIG_PATH}), which native's rg reads, so it refuses rather than search `
      + 'without it (unset it, or pass --no-config); nothing was searched');
    return finish(r, out, err, exit);
  }
  const search = (implicit) => {
    let neverReadable = false;
    const input = () => { const s = stdin(); neverReadable = s.failed && !s.bytes.length; return s.bytes; };
    const r = rgn.runRg(argv, { cwd, env, implicit, input, ugrep: () => findUgrep(env), debug });
    return { r, neverReadable };
  };
  let { r, neverReadable } = search(implicit);
  // RG-IMPLICIT-PATH, a closed fd 0: native's rg finds no readable stdin there and searches ./ (`rg needle <&-`).
  // Under tjs a closed fd 0 is not closed by the time any JS runs: libuv's own first pipe takes the number, and it
  // reads as a FIFO. Reading it fails, so a pathless search whose stdin could not be read at all is run again as
  // the ./ search it was. (node, naude's engine, reopens a closed fd 0 on /dev/null at startup, as a character device.)
  if (neverReadable && parsed.spec && parsed.spec.implicitStdin) ({ r } = search('cwd'));
  return finish(r, out, err, exit);
}

function finish(r, out, err, exit) {
  // A reader that went away (`rg x | head -1`): native's rg dies of SIGPIPE, which the shell reports as 141.
  if (out(r.stdout || Buffer.alloc(0)) === false) { exit(141); return; }
  err(r.stderr || Buffer.alloc(0));
  exit(typeof r.status === 'number' ? r.status : 2);
}

module.exports = { RG_ARGV0, isRgInvocation, rgShadowFunction, implicitPath, readStdin, findUgrep, main };

if (require.main === module) main();
