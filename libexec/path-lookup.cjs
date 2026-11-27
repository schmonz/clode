'use strict';
// path-lookup — THE one PATH search. Every lookup of a bare command name in clode, quaude and naude goes through
// lookPath (or, where the probe must be asynchronous, through pathCandidates plus the caller's own probe):
// clode-hosttools.findTool, the node-shim's resolveExe, clode-resolve.whichClaude, rg-entry.findUgrep,
// bun-shim's Bun.which and Bun.spawn, target-env's rg discovery and quaude-bootstrap's sandbox facts. There used to be
// seven of these, and they disagreed (an execute bit checked or not, PATHEXT read from the wrong env, X_OK asked on
// Windows, an empty PATH entry meaning cwd in one and nothing in the next): docs/superpowers/findings/
// 2026-11-27-latent-capabilities-audit.md, D2.
//
// THE DEFAULT IS NODE'S, which is libuv's. What node runs when asked to spawn a bare name is what lookPath answers:
//
//   POSIX (libuv src/unix/process.c, its execvpe emulation copied from musl):
//     - a name containing '/' is not searched: it is the path.
//     - PATH comes from the env handed to the call; an env with NO PATH uses _PATH_DEFPATH, "/usr/bin:/bin".
//     - entries are tried in order; an EMPTY entry (leading, trailing or doubled ':', or PATH='') is the current
//       directory (musl joins it as the bare name).
//     - a candidate counts when the spawn would succeed: libuv tries posix_spawn on each and walks on past ENOENT,
//       ENOTDIR and EACCES. A directory and a non-executable file are both EACCES, so the question is "a regular file
//       with the execute bit", asked here as statSync().isFile() + accessSync(X_OK).
//   win32 (libuv src/win/process.c, search_path):
//     - a name containing '\', '/' or ':' is not searched; only its extensions are tried in its own directory.
//     - PATH (case-insensitive key: Path and PATH are one variable on Windows) comes from the env handed to the call.
//     - the current directory is searched FIRST, before PATH, unless NoDefaultCurrentDirectoryInExePath is set
//       (NeedCurrentDirectoryForExePathW).
//     - a zero-length entry is skipped; a quoted entry ("..." or '...') is unquoted.
//     - in each directory: the exact name, only if it HAS an extension (a dot with something after it), then the name
//       with .com appended, then with .exe appended. PATHEXT is NOT consulted.
//     - a candidate counts when it exists and is not a directory (GetFileAttributesW). There is no execute bit, and
//       asking X_OK is worse than useless: under tjs fs.accessSync is the CRT's _access, which rejects mode 1 with
//       EINVAL for every path (clode-hosttools.cjs and CI run 33245690046 have the history).
//
// TWO NAMED OPTIONS, and only two, let a caller diverge, each for a reason it must write at its call site:
//   pathext: true      — on win32, append the env's PATHEXT extensions (default .COM;.EXE;.BAT;.CMD) instead of
//                        libuv's .com/.exe. For callers asking "which tool would a Windows shell run" (cmd.exe and
//                        `where` honour PATHEXT; npm and its kin install as .cmd), not "what would spawn run".
//   windowsCwd: false  — on win32, do not search the current directory first. For callers locating a tool clode
//                        itself will run, where a planted tar.exe in whatever directory the user stands in must not win.
// Neither changes POSIX: there is one POSIX rule.
//
// REQUIRE-FREE AT THE TOP LEVEL ON PURPOSE. quaude's bootstrap evaluates this file as a blobulated member under tjs
// before any module system exists (it hands target-env.cjs this module, and asks pathCandidates itself for the sandbox
// facts), so nothing here may reach for a runtime unless a caller asks for the default predicate, which requires fs
// on first use. Paths are joined by hand, for the same reason.

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const POSIX_DEFAULT_PATH = '/usr/bin:/bin';
const LIBUV_WIN_EXTS = ['.com', '.exe'];

const winOf = (platform) => platform === 'win32';

// A variable from `env`; on win32 the key is case-insensitive (a computed key, but only ever PATH, PATHEXT or
// NoDefaultCurrentDirectoryInExePath: test/env-indirect.cjs records this file as key-agnostic), as it is to the OS (and to libuv's env-block scan).
function envGet(env, key, isWin) {
  if (!env) return undefined;
  if (env[key] !== undefined || !isWin) return env[key];
  const want = key.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) return env[k];
  return undefined;
}

// Is the name already a path, so PATH is not searched? POSIX: a '/' anywhere. win32: '\', '/' or a drive colon.
function isPathed(name, platform) {
  const s = String(name);
  return s.includes('/') || (winOf(platform) && (s.includes('\\') || s.includes(':')));
}

// The extensions a win32 lookup appends, lower-cased (NTFS is case-insensitive; a predictable spelling comes back).
// A PATHEXT entry without a leading dot is ignored rather than concatenated into `ugrepexe`.
function winExtensions(env, pathext) {
  if (!pathext) return LIBUV_WIN_EXTS;
  const raw = envGet(env, 'PATHEXT', true);
  const out = [];
  for (const entry of String(raw === undefined || raw === null || raw === '' ? DEFAULT_PATHEXT : raw).split(';')) {
    const ext = entry.trim().toLowerCase();
    if (ext && ext[0] === '.' && !out.includes(ext)) out.push(ext);
  }
  return out;
}

// The leaf names tried in one directory. POSIX: the name. win32: libuv's path_search_walk_ext — the exact name only
// when it has an extension (a dot in the last component with something after it: `python3.11` counts, so it is tried
// as spelled AND as python3.11.exe), then each extension appended.
function leafNames(name, { platform, env, pathext } = {}) {
  if (!winOf(platform)) return [name];
  const s = String(name);
  const base = s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'), s.lastIndexOf(':')) + 1);
  const dot = base.indexOf('.');
  const hasExt = dot !== -1 && dot < base.length - 1;
  const leaves = hasExt ? [s] : [];
  for (const ext of winExtensions(env, pathext)) leaves.push(s.endsWith('.') ? s + ext.slice(1) : s + ext);
  return leaves;
}

function isAbsolute(p, isWin) {
  return isWin ? /^([a-zA-Z]:)?[\\/]/.test(p) : p[0] === '/';
}

function join(dir, leaf, isWin) {
  const sep = isWin ? '\\' : '/';
  if (!dir) return leaf;
  const last = dir[dir.length - 1];
  return (last === '/' || (isWin && last === '\\')) ? dir + leaf : dir + sep + leaf;
}

// Anchor a relative candidate at `cwd` when the caller names one (a spawn's opts.cwd: libuv resolves relative PATH
// entries against the CHILD's directory); without one it stays relative, and the probe reads it against the process's.
function anchor(p, cwd, isWin) {
  if (!cwd || isAbsolute(p, isWin) || (isWin && /^[a-zA-Z]:/.test(p))) return p;
  return join(cwd, (p.startsWith('./') || (isWin && p.startsWith('.\\'))) ? p.slice(2) : p, isWin);
}

// win32 PATH entries, sliced as libuv's search_path slices them: a slice that OPENS with a quote runs to the matching
// quote before looking for the ';' (so `"C:\a;b"` is one directory), zero-length slices are skipped, and one leading
// and one trailing quote character are dropped.
function winPathEntries(PATH) {
  const s = PATH === undefined || PATH === null ? '' : String(PATH);
  const out = [];
  let start = 0;
  while (start < s.length) {
    let from = start;
    if (s[start] === '"' || s[start] === "'") {
      const close = s.indexOf(s[start], start + 1);
      from = close === -1 ? s.length : close;
    }
    let end = s.indexOf(';', from);
    if (end === -1) end = s.length;
    let dir = s.slice(start, end);
    if (dir.length && (dir[0] === '"' || dir[0] === "'")) dir = dir.slice(1);
    if (dir.length && (dir[dir.length - 1] === '"' || dir[dir.length - 1] === "'")) dir = dir.slice(0, -1);
    if (dir) out.push(dir);
    start = end + 1;
  }
  return out;
}

// Every candidate path, in the order the search tries them. Pure: no filesystem, so a caller that can only probe
// asynchronously (quaude's bootstrap has no sync stat) walks this list with its own probe.
//   opts: { env, platform, pathext, windowsCwd, cwd }
function pathCandidates(name, opts = {}) {
  const { env = {}, platform, pathext = false, cwd } = opts;
  const isWin = winOf(platform);
  if (!name) return [];
  const leaves = leafNames(name, { platform, env, pathext });
  if (isPathed(name, platform)) return leaves.map((l) => anchor(l, cwd, isWin));
  const out = [];
  if (isWin) {
    const windowsCwd = opts.windowsCwd === undefined
      ? envGet(env, 'NoDefaultCurrentDirectoryInExePath', true) === undefined
      : !!opts.windowsCwd;
    if (windowsCwd) for (const l of leaves) out.push(anchor('.\\' + l, cwd, true));
    for (const dir of winPathEntries(envGet(env, 'PATH', true))) {
      for (const l of leaves) out.push(anchor(join(dir, l, true), cwd, true));
    }
    return out;
  }
  const PATH = env.PATH === undefined || env.PATH === null ? POSIX_DEFAULT_PATH : String(env.PATH);
  for (const dir of PATH.split(':')) {
    // An empty entry is the current directory. './name', not the bare name musl execs, so that what comes back
    // still reads as a path to anyone who spawns it.
    out.push(anchor(dir ? join(dir, name, false) : './' + name, cwd, false));
  }
  return out;
}

// The default predicate: "would a spawn of this path run it?" — a regular file, with the execute bit off Windows
// (see the header for why win32 must not ask X_OK). `fs` is injectable (a test's, or the node-shim's); otherwise
// required on first use, never at load.
function isExecutableFile(p, opts = {}) {
  const fsm = opts.fs || require('fs');
  const isWin = opts.isWin === undefined ? (typeof process !== 'undefined' && process.platform === 'win32') : !!opts.isWin;
  try {
    if (!fsm.statSync(p).isFile()) return false;
    if (isWin) return true;
    fsm.accessSync(p, fsm.constants ? fsm.constants.X_OK : 1);
    return true;
  } catch {
    return false;
  }
}

// The first candidate that is executable, or null.
//   opts: pathCandidates' options, plus isExec (default isExecutableFile on `platform`) and fs (for the default).
function lookPath(name, opts = {}) {
  const platform = opts.platform || (typeof process !== 'undefined' ? process.platform : 'linux');
  const isWin = winOf(platform);
  const isExec = opts.isExec || ((p) => isExecutableFile(p, { fs: opts.fs, isWin }));
  for (const cand of pathCandidates(name, { ...opts, platform })) {
    if (isExec(cand)) return cand;
  }
  return null;
}

module.exports = {
  lookPath,
  pathCandidates,
  isExecutableFile,
  isPathed,
  leafNames,
  DEFAULT_PATHEXT,
  POSIX_DEFAULT_PATH,
};
