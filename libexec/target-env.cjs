'use strict';
// The env contract a BUILT target applies to itself at boot.
//
// This was libexec/clode-run.cjs's applyBundleEnv — knowledge that used to live
// on the launcher, back when clode ran Claude Code. clode is a builder now, so
// the knowledge belongs to the things it builds: quaude applies it in its blobulated
// bootstrap, naude in its SEA entry. Same contract either way.
//
// DEPENDENCY-FREE ON PURPOSE. quaude's bootstrap evaluates this as a blobulated
// member under tjs, BEFORE the node-shim loader exists — there is no node:fs and
// no node:path there. Every primitive is injected. Callers supply them; nothing
// here reaches for a runtime. Its one require is path-lookup.cjs (the PATH
// search, see rgCandidates), which is require-free too and which the bootstrap
// hands it.
//
// NODE_PATH is deliberately NOT our business: naude builds its own from the
// materialized deps, and quaude carries its deps as trailer members with no
// node_modules on disk at all.

// sh `: "${VAR:=value}"` — assign only when unset OR empty.
function setIfUnset(env, name, value) {
  if (env[name] == null || env[name] === '') env[name] = value;
}

function shapeTargetEnv(opts) {
  const {
    env,
    platform,
    delimiter = ':',
    exists,
    isExec,
    dirname,
  } = opts;

  // The bundle's own npm-deprecation/installation nags assume an npm install we
  // are not; NODE_USE_ENV_PROXY makes it honor HTTP(S)_PROXY.
  setIfUnset(env, 'DISABLE_INSTALLATION_CHECKS', '1');
  setIfUnset(env, 'NODE_USE_ENV_PROXY', '1');

  // Old macOS has no /usr/libexec/trustd; the bundle's default trust path then
  // finds no store. Modern macOS: leave the app default alone.
  if (platform === 'darwin' && !exists('/usr/libexec/trustd')) {
    setIfUnset(env, 'CLAUDE_CODE_CERT_STORE', 'bundled');
  }

  // Point the Grep tool at a real ripgrep when one exists. rg stays OPTIONAL —
  // none found means leave the config alone (the bundle falls back to its
  // embedded search). CLODE_RG wins verbatim.
  const rg = env.CLODE_RG || findOnPath({ env, platform, isExec });
  if (rg) {
    setIfUnset(env, 'USE_BUILTIN_RIPGREP', '0');
    const rgdir = dirname(rg);
    const cur = env.PATH || '';
    // Whole-segment membership test, matching applyRipgrepEnv's
    // `case ":$PATH:" in *":$_rgdir:"*)` — not just the first segment.
    // This is nearly always a no-op: PATH discovery finds rg in a dir that,
    // by construction, is already on PATH somewhere. The prepend only fires
    // for an explicit CLODE_RG pointing at a dir outside PATH.
    if (!cur.split(delimiter).includes(rgdir)) {
      env.PATH = cur ? rgdir + delimiter + cur : rgdir;
    }
  }

  // NOTE: a built target used to bake env pointing back at the clode BUILDER
  // that made it, so Claude Code's patched in-app updater could spawn a rebuild.
  // That rebuild machinery is RETIRED — auto-update is now a check-and-notify
  // (extract-claude-js.cjs's patches call globalThis.__clodeCheckUpdate, no
  // builder, no rebuild) — so a target no longer declares a builder path or its
  // own kind/path here. Nothing reads that env anymore.

  return env;
}

// Candidate rg paths, in search order: path-lookup.cjs's pathCandidates, the one PATH search, so what this probes is
// what the Grep tool's later spawn of `rg` would find (on win32 libuv's rg.com/rg.exe, a quoted entry unquoted).
// Two caller-side choices, both because the rg dir found here is put on PATH for the WHOLE session: windowsCwd: false,
// and only ABSOLUTE candidates (an empty POSIX entry, or a relative PATH dir, is the current directory or relative to
// it, which stops being the same directory the moment the session cds). It is also what lets probePaths stay a pure
// list, computed before anything has looked at a filesystem.
//
// path-lookup.cjs is this file's one require, and it is require-free itself: quaude's bootstrap, which evaluates this
// file before any module system exists, hands it over as the answer to that require (libexec/quaude-bootstrap.mjs).
// Required on first use, so an evaluation that only wants mapPlatform needs nothing at all.
function rgCandidates({ env, platform }) {
  const isWin = platform === 'win32';
  return require('./path-lookup.cjs').pathCandidates('rg', { env, platform, windowsCwd: false })
    .filter((p) => (isWin ? /^([a-zA-Z]:)?[\\/]/.test(p) : p[0] === '/'));
}

// "Does a path exist?" and "can I run this path?" are different questions —
// a DIRECTORY or a non-executable file both EXIST, but the Grep tool cannot
// run either of them. `command -v`/`[ -x ]` semantics (what the retired sh
// launcher used) ask the second question; `exists` here would silently answer
// the first and let a same-named directory or non-executable file "win" a PATH
// slot, switching off USE_BUILTIN_RIPGREP's embedded-search fallback for a tool
// that can never run. So rg candidates are asked with `isExec`, never `exists`
// — that predicate is reserved for genuine existence checks (trustd, above).
function findOnPath({ env, platform, isExec }) {
  for (const cand of rgCandidates({ env, platform })) {
    if (isExec(cand)) return cand;
  }
  return null;
}

// uaPlatform (navigator.userAgentData.platform) -> node's process.platform
// spelling. Lives HERE, not in quaude-bootstrap.mjs or the node-shim, because
// this is the one require-free member both evaluate early: quaude's blobulated
// bootstrap runs this switch pre-node-shim (via the same `new Function`
// evaluation it uses for shapeTargetEnv/probePaths), and the node-shim's
// process.cjs requires this file directly (it has require by then). One copy
// keeps the two from drifting apart the way they already had — see both call
// sites for the shared comment.
//
// NO navigator.platform regex fallback here: quaude's bootstrap never has a
// second signal to fall back to (tjs.system.platform is empty), so its
// fallback for empty/absent input is 'linux' — the last branch below. The
// node-shim's detectPlatform has that second signal and keeps its own
// regex-based fallback locally, only calling into this switch first.
function mapPlatform(uaPlatform) {
  switch (uaPlatform) {
    case 'macOS': return 'darwin';
    case 'Windows': return 'win32';
    case 'Linux': return 'linux';
    case 'FreeBSD': return 'freebsd';
    case 'OpenBSD': return 'openbsd';
    default: return uaPlatform ? String(uaPlatform).toLowerCase() : 'linux';
  }
}

// Every path shapeTargetEnv may test, computed WITHOUT touching a filesystem.
//
// This exists for quaude: tjs has no statSync (only async tjs.stat), so its
// bootstrap cannot answer a sync exists() on demand. It resolves this list once,
// asynchronously, then answers shapeTargetEnv from the result. Keeping the list
// in THIS module is what stops it drifting from what shapeTargetEnv actually
// asks about — test/target-env.test.cjs asserts exactly that.
function probePaths({ env, platform }) {
  const paths = [];
  if (platform === 'darwin') paths.push('/usr/libexec/trustd');
  paths.push(...rgCandidates({ env, platform }));
  return paths;
}

module.exports = { shapeTargetEnv, probePaths, mapPlatform };
