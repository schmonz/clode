'use strict';
// clode-watch.cjs — JS port of bin/clode's opportunistic update-signal watcher
// (bin/clode:393-547). One stateless poll->detect->notify cycle for concerning
// upstream releases, a next-launch banner, and the throttled on-launch fire.
//
// WARN-ONLY throughout: every entry point resolves/returns 0 and never blocks a
// launch. Changelog-only (never downloads the ~240MB provider binary). Silent by
// default — stderr is touched only in manual mode and by the HIGH banner (the
// two deliberate exceptions to clode's silent-by-default rule).
//
// Ports (sh -> JS):
//   version_gt         (:475)  -> versionGt(a, b, {env, here})
//   watch_dir          (:490)  -> watchDir(env)
//   file_mtime         (:495)  -> fileMtime(path)
//   write_watch_notice (:501)  -> writeWatchNotice(path, latest, current, high, checkedAt)
//   clode_watch        (:396)  -> clodeWatch(manual, {env, libexec, here, node, stderr})  [async]
//   clode_watch_banner (:509)  -> clodeWatchBanner({env, here, stderr})
//   clode_watch_fire   (:528)  -> clodeWatchFire({self})
//   clode_watch_maybe  (:535)  -> clodeWatchMaybe({env, self, fire})
//
// Downloads go through downloadFile from clode-net.cjs (built-in fetch/file://,
// no curl/wget). The HIGH-signal decision defers to clode-signals.cjs, invoked
// exactly as the sh does: `"$NODE" clode-signals.cjs ... --json` (spawned), with
// high=1 iff the JSON contains `"tier": "high"`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { downloadFile } = require('./clode-net.cjs');
const { resolveChannel, releasesUrl } = require('./clode-update.cjs');
const cpaths = require('./clode-paths.cjs');
const { currentVersion } = require('./clode-current.cjs');

const HERE_DEFAULT = __dirname; // libexec/; bin/ is a sibling
const LIBEXEC_DEFAULT = __dirname;

function envOf(opts) {
  return (opts && opts.env) || process.env;
}

// ---------------------------------------------------------------------------
// version_gt A B -> true iff A is strictly greater than B, using the real
// `semver` ext-dep (the same module the bundle uses). semver is resolved from
// clode's dep store (CLODE_DEPS / XDG_DATA_HOME) AND clode's own node_modules
// ($here/../node_modules, the `npm install -g` layout) — resolved explicitly so
// we never fall back to ambient resolution. Conservative (false) if semver is
// unavailable or the versions are garbage, so the watcher under-alarms rather
// than false-alarms.
function loadSemver(opts) {
  const env = envOf(opts);
  const store = cpaths.depsStore(env);
  const cands = [path.join(store, 'node_modules')];
  const here = (opts && opts.here) || null;
  if (here) cands.push(path.join(here, '..', 'node_modules'));
  for (const base of cands) {
    const pkg = path.join(base, 'semver');
    if (fs.existsSync(path.join(pkg, 'package.json'))) {
      try { return require(pkg); } catch { /* try next */ }
    }
  }
  return null;
}

function versionGt(a, b, opts) {
  const semver = loadSemver(opts || {});
  if (!semver) return false;
  // Use compare() (the fundamental primitive every semver-compatible module
  // provides, incl. the render fakes) rather than gt(); a > b iff compare > 0.
  try { return semver.compare(a, b) > 0; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Where watcher state lives (throttle + notice). Independent of the bundle
// cache so it's stable across versions. CLODE_WATCH_DIR overrides.
function watchDir(env) {
  return cpaths.watchDir(env || process.env);
}

// Epoch mtime (truncated seconds) of a file; 0 if unknown.
function fileMtime(p) {
  try { return Math.trunc(fs.statSync(p).mtimeMs / 1000); } catch { return 0; }
}

// Write the watch notice as key=value lines so the next-launch banner reads it
// without a JSON parser.
function writeWatchNotice(p, latest, current, high, checkedAt) {
  try {
    fs.writeFileSync(p,
      `latest=${latest}\ncurrent=${current}\nhigh=${high}\nchecked_at=${checkedAt}\n`);
  } catch { /* warn-only */ }
}

// Parse a key=value notice file into an object; {} if unreadable.
function readNoticeFile(p) {
  const out = {};
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// The version <providers>/current points at, via the clode-current seam ('' if none).
function currentProvider(env) {
  return currentVersion(env);
}

// Spawn clode-signals.cjs exactly as the sh does. Returns stdout (utf8), or ''
// on any failure — warn-only, never throws.
function runSignals(opts, extraArgs) {
  const node = (opts && opts.node) || process.execPath;
  const libexec = (opts && opts.libexec) || LIBEXEC_DEFAULT;
  const script = path.join(libexec, 'clode-signals.cjs');
  try {
    return execFileSync(node, [script, ...extraArgs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return (e && e.stdout) || '';
  }
}

// ---------------------------------------------------------------------------
// One stateless poll->detect->notify cycle. WARN-ONLY: always resolves 0.
// manual (nonempty $1) => also print a human summary to stderr.
async function clodeWatch(manual, opts) {
  opts = opts || {};
  const env = envOf(opts);
  const stderr = opts.stderr || process.stderr;
  const libexec = opts.libexec || LIBEXEC_DEFAULT;
  const here = opts.here || null;

  const wd = watchDir(env);
  try { fs.mkdirSync(wd, { recursive: true }); } catch { return 0; }
  const notice = path.join(wd, 'watch-notice');

  // Poll the SAME channel `clode fetch` would fetch: autoUpdatesChannel, else
  // 'latest' (matching claude), against the resolved releases base (default URL
  // when CLODE_RELEASES_URL is unset). Keeps the nudge and the updater in step.
  const chan = resolveChannel(undefined, env);
  let latest;
  try {
    latest = String(await downloadFile(`${releasesUrl(env)}/${chan}`))
      .replace(/[\r\n]/g, '');
  } catch { return 0; }
  if (!/^[0-9].*\.[0-9].*\.[0-9]/.test(latest)) return 0;

  const current = currentProvider(env);
  if (!current) return 0; // no clode-managed provider -> no-op

  const now = Math.floor(Date.now() / 1000);

  if (!versionGt(latest, current, { env, here })) {
    writeWatchNotice(notice, latest, current, 0, now);
    if (manual) stderr.write(`clode: up to date (${current}; ${chan} ${latest}).\n`);
    return 0;
  }

  // Newer: scan ONLY the changelog for HIGH signals (no --bundle).
  let high = 0;
  // Stage the fetched changelog inside the clode-owned watch dir (`wd`, already created
  // above) — NOT a hardcoded `/tmp`, which on Windows resolves to `<cwd-drive>:\tmp` and
  // is absent when clode runs off a non-C: drive (e.g. CI's `D:\a\...`), silently failing
  // the changelog fetch so HIGH signals were never detected. `wd` is valid on every
  // platform and hermetic. Cleaned up at the end of this branch.
  const cltmp = path.join(wd, `clode-watch-cl.${process.pid}`);
  let haveChangelog = false;
  try {
    await downloadFile(env.CLODE_CHANGELOG_URL, cltmp);
    haveChangelog = true;
  } catch { /* changelog fetch is best-effort */ }

  const haveSignals = fs.existsSync(path.join(libexec, 'clode-signals.cjs'));
  if (haveChangelog && haveSignals) {
    const json = runSignals(opts, ['--version', latest, '--prev', current,
      '--changelog-file', cltmp, '--json']);
    if (json.includes('"tier": "high"')) high = 1;
  }

  writeWatchNotice(notice, latest, current, high, now);

  if (manual) {
    if (haveChangelog && haveSignals) {
      const digest = runSignals(opts, ['--version', latest, '--prev', current,
        '--changelog-file', cltmp]);
      if (digest) stderr.write(digest);
    }
    if (high === 1) {
      stderr.write(`clode: ${latest} may affect running under Node (run 'clode fetch' to take it).\n`);
    } else {
      stderr.write(`clode: ${latest} is available (no Node-impacting signals).\n`);
    }
  }

  try { fs.rmSync(cltmp, { force: true }); } catch { /* ignore */ }
  return 0;
}

// ---------------------------------------------------------------------------
// Print ONE stderr line iff the last watch found a newer HIGH-signal version
// that still applies (installed provider still older than it). Self-clears once
// the provider catches up. Always returns 0.
function clodeWatchBanner(opts) {
  opts = opts || {};
  const env = envOf(opts);
  const stderr = opts.stderr || process.stderr;
  const here = opts.here || null;

  const notice = path.join(watchDir(env), 'watch-notice');
  if (!fs.existsSync(notice)) return 0;
  const n = readNoticeFile(notice);
  if (n.high !== '1' || !n.latest) return 0;

  let cur = currentProvider(env);
  if (!cur) cur = n.current;
  if (!versionGt(n.latest, cur, { env, here })) return 0;

  stderr.write(`clode: Claude Code ${n.latest} is available and may affect running under Node (run 'clode --clode-watch' for details, 'clode fetch' to take it).\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Spawn one watch cycle fully detached so it never adds startup latency/output.
// `self` is parameterized so tests can stub the launcher. Never throws.
function clodeWatchFire(opts) {
  opts = opts || {};
  const self = opts.self;
  try {
    const { spawn } = require('node:child_process');
    const child = spawn(self, ['--clode-watch'],
      { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* swallow ENOENT for a bogus self */ });
    child.unref();
  } catch { /* never throw */ }
}

// ---------------------------------------------------------------------------
// Fire a watch cycle at most once per CLODE_WATCH_INTERVAL (default 1 day).
// Stamps the throttle BEFORE firing so a failing cycle can't cause a re-fire
// storm. Disabled by CLODE_NO_WATCH. Never blocks; always returns 0.
function clodeWatchMaybe(opts) {
  opts = opts || {};
  const env = envOf(opts);
  if (env.CLODE_NO_WATCH) return 0;

  const wd = watchDir(env);
  const throttle = path.join(wd, 'last-watch');
  if (fs.existsSync(throttle)) {
    const now = Math.floor(Date.now() / 1000);
    const age = now - fileMtime(throttle);
    const interval = parseInt(env.CLODE_WATCH_INTERVAL != null && env.CLODE_WATCH_INTERVAL !== ''
      ? env.CLODE_WATCH_INTERVAL : '86400', 10);
    if (!(age >= interval)) return 0;
  }

  try { fs.mkdirSync(wd, { recursive: true }); } catch { return 0; }
  try { fs.writeFileSync(throttle, ''); } catch { return 0; }

  const fire = opts.fire || (() => clodeWatchFire({ self: opts.self }));
  fire();
  return 0;
}

module.exports = {
  versionGt, watchDir, fileMtime, writeWatchNotice,
  clodeWatch, clodeWatchBanner, clodeWatchFire, clodeWatchMaybe,
};
