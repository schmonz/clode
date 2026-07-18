'use strict';
// The env contract a BUILT target applies to itself at boot.
//
// This was libexec/clode-run.cjs's applyBundleEnv — knowledge that used to live
// on the launcher, back when clode ran Claude Code. clode is a builder now, so
// the knowledge belongs to the things it builds: quaude applies it in its fused
// bootstrap, naude in its SEA entry. Same contract either way.
//
// DEPENDENCY-FREE ON PURPOSE. quaude's bootstrap evaluates this as a fused
// member under tjs, BEFORE the node-shim loader exists — there is no node:fs and
// no node:path there. Every primitive is injected. Callers supply them; nothing
// here reaches for a runtime.
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
    self = null,
    targetKind = null,
    targetPath = null,
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
  const rg = env.CLODE_RG || findOnPath({ env, platform, delimiter, isExec });
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

  // Claude Code's in-app autoupdater is patched (extract-claude-js.cjs) to spawn
  // CLODE_SELF --clode-internal-update. A baked target CANNOT rewrite its own
  // bytecode, so this points at the clode BUILDER, which fetches a newer Claude
  // Code and rebuilds. No builder known -> leave unset, so the updater fails
  // loud rather than doing something wrong.
  if (self) env.CLODE_SELF = self;

  // The target declares WHAT IT IS and WHERE IT LIVES so the patched updater's
  // callback (CLODE_SELF --clode-internal-update, inheriting this env) can rebuild
  // the right kind and swap the right file. No binary-detection: a target knows
  // what it is; a sniffer would also try to "update" a builder (itself a QAUDEv0
  // artifact). Absent -> unset, same fail-loud contract as a missing CLODE_SELF.
  if (targetKind) env.CLODE_TARGET_KIND = targetKind;
  if (targetPath) env.CLODE_TARGET = targetPath;

  return env;
}

// Candidate rg paths, in PATH order.
function rgCandidates({ env, platform, delimiter }) {
  const bin = platform === 'win32' ? 'rg.exe' : 'rg';
  const sep = platform === 'win32' ? '\\' : '/';
  return (env.PATH || '').split(delimiter).filter(Boolean).map((dir) => dir + sep + bin);
}

// "Does a path exist?" and "can I run this path?" are different questions —
// a DIRECTORY or a non-executable file both EXIST, but the Grep tool cannot
// run either of them. `command -v`/`[ -x ]` semantics (what the retired sh
// launcher used) ask the second question; `exists` here would silently answer
// the first and let a same-named directory or non-executable file "win" a PATH
// slot, switching off USE_BUILTIN_RIPGREP's embedded-search fallback for a tool
// that can never run. So rg candidates are asked with `isExec`, never `exists`
// — that predicate is reserved for genuine existence checks (trustd, above).
function findOnPath({ env, platform, delimiter, isExec }) {
  for (const cand of rgCandidates({ env, platform, delimiter })) {
    if (isExec(cand)) return cand;
  }
  return null;
}

// uaPlatform (navigator.userAgentData.platform) -> node's process.platform
// spelling. Lives HERE, not in quaude-bootstrap.mjs or the node-shim, because
// this is the one require-free member both evaluate early: quaude's fused
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
function probePaths({ env, platform, delimiter = ':' }) {
  const paths = [];
  if (platform === 'darwin') paths.push('/usr/libexec/trustd');
  paths.push(...rgCandidates({ env, platform, delimiter }));
  return paths;
}

module.exports = { shapeTargetEnv, probePaths, mapPlatform };
