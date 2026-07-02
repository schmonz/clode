'use strict';
// clode-update — JS port of bin/clode's update + post-update signals digest.
//
//   clode_update         (bin/clode:349)  ->  clodeUpdate(channel, opts)   [async]
//   clode_signals_report (bin/clode:335)  ->  clodeSignalsReport(...)      [async]
//
// Host-agnostic fetch of the upstream Claude Code JS into a clode-owned provider
// store: resolve a version (from a channel file or a numeric arg), read the
// platform checksum from manifest.json, download the FIXED platform binary to a
// temp partial, verify its sha256, atomically rename into place, chmod +x, then
// re-point the `current` symlink and print a warn-only "direction of travel"
// signals digest. Behavior-for-behavior with the sh launcher, including every
// exact message and the atomic temp->verify->rename->symlink ordering.
//
// The sh shells out to curl/wget + sha256sum/shasum; this port reuses clode-net's
// downloadFile (built-in fetch/file://) + sha256Of (crypto). Dropping curl/wget
// is an explicit project goal, so (unlike sh) there is no downloader precheck.
// Node stdlib + sibling requires only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadFile, sha256Of } = require('./clode-net.cjs');

// `[ -f "$p" ]`: exists AND is a regular file.
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// `[ -d "$p" ]`: exists AND is a directory.
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Env defaults, mirroring bin/clode:323-327,371.
function releasesUrl(env) {
  return env.CLODE_RELEASES_URL || 'https://downloads.claude.ai/claude-code-releases';
}
function fetchPlatform(env) {
  return env.CLODE_FETCH_PLATFORM || 'linux-x64';
}
function changelogUrl(env) {
  return env.CLODE_CHANGELOG_URL ||
    'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
}
function providersDir(env) {
  if (env.CLODE_PROVIDERS) return env.CLODE_PROVIDERS;
  const home = env.HOME || '';
  const xdgData = env.XDG_DATA_HOME || `${home}/.local/share`;
  return `${xdgData}/clode/providers`;
}

// Settings files claude reads the auto-update channel from, HIGHEST precedence
// first: enterprise-managed policy (platform-fixed path), then user settings
// (CLODE honors CLAUDE_CONFIG_DIR like claude, defaulting to ~/.claude). We scope
// to the machine/user-global tiers where `autoUpdatesChannel` actually lives, not
// per-directory project settings (a global provider fetch has no project cwd).
function settingsFiles(env) {
  const managed = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32'
      ? 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
      : '/etc/claude-code/managed-settings.json';
  const cfgDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== ''
    ? env.CLAUDE_CONFIG_DIR
    : path.join(env.HOME || '', '.claude');
  return [managed, path.join(cfgDir, 'settings.json')];
}

// The `autoUpdatesChannel` value from the first settings file that defines it as
// a non-empty string, or '' if none do. Best-effort: an absent/unreadable/invalid
// file is skipped, never thrown (a broken settings.json must not break `update`).
function readAutoUpdatesChannel(env) {
  for (const f of settingsFiles(env)) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const v = obj && obj.autoUpdatesChannel;
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

// Resolve the effective channel, matching claude's precedence: an explicit CLI
// arg wins; else the autoUpdatesChannel setting; else 'latest' (claude's default).
function resolveChannel(explicit, env) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  return readAutoUpdatesChannel(env) || 'latest';
}

// Extract the platform's checksum from a manifest body. Mirrors the inline node
// in bin/clode:365-366: `const p = m.platforms || m; (p[plat]||{}).checksum||""`,
// tolerant of a flat (no top-level "platforms") shape. Any parse error -> "".
function checksumFor(manifestText, plat) {
  try {
    const m = JSON.parse(manifestText);
    const p = m.platforms || m;
    return (p[plat] || {}).checksum || '';
  } catch {
    return '';
  }
}

// Force-(re)create `current` as a relative symlink to `ver`. Mirrors
// `ln -sfn "$ver" "$current"`: replace any existing entry (file/dir/symlink)
// without dereferencing, then link to the RELATIVE target so the store is
// relocatable.
function relinkCurrent(current, ver) {
  try { fs.lstatSync(current); fs.rmSync(current, { recursive: true, force: true }); } catch { /* absent */ }
  fs.symlinkSync(ver, current);
}

// After an update, surface Anthropic's direction-of-travel signals (release-note
// lines + bundle markers bearing on running the JS under Node). Prints a digest
// to `stderr`; in a source checkout also writes a reviewable signals/<ver>.json.
// STRICTLY best-effort — never throws, never affects the update's exit status
// (warn-only by design). No-op when clode-signals.cjs is absent. Async because it
// fetches the changelog via downloadFile.
//
// opts: { env, libexec, here, node=process.execPath, stderr=process.stderr }.
async function clodeSignalsReport(ver, prev, bin, opts = {}) {
  try {
    const {
      env = process.env,
      libexec,
      here,
      node = process.execPath,
      stderr = process.stderr,
    } = opts;
    if (!libexec) return;
    const tool = path.join(libexec, 'clode-signals.cjs');
    if (!isFile(tool)) return;

    // Best-effort changelog fetch to a temp file (mirrors bin/clode:339-340).
    const cltmp = path.join(os.tmpdir(), `clode-changelog.${process.pid}`);
    let cl = '';
    try { await downloadFile(changelogUrl(env), cltmp); cl = cltmp; } catch { /* offline: skip */ }

    // Snapshot dir: CLODE_SIGNALS_DIR, else the source checkout's signals/ dir
    // when running from a git checkout (bin/clode:341-342).
    let sigdir = env.CLODE_SIGNALS_DIR || '';
    if (!sigdir && here && isDir(path.join(here, '..', '.git'))) {
      sigdir = path.join(here, '..', 'signals');
    }

    // Build argv with only the flags whose values are non-empty (${x:+--flag "$x"}).
    const args = ['--version', ver];
    if (prev) args.push('--prev', prev);
    if (bin) args.push('--bundle', bin);
    if (cl) args.push('--changelog-file', cl);
    if (sigdir) args.push('--snapshot-dir', sigdir);

    // Spawn the signals tool. sh runs `"$NODE" tool ... 2>/dev/null` and the
    // caller redirects the tool's STDOUT (the digest) to stderr; mirror that:
    // capture stdout -> stderr, discard the tool's own stderr, never throw.
    const r = spawnSync(node, [tool, ...args], { env, encoding: 'utf8' });
    if (r && r.stdout) stderr.write(r.stdout);

    try { fs.unlinkSync(cltmp); } catch { /* absent */ }
  } catch {
    // warn-only: any failure in the signals digest is swallowed.
  }
}

// Fetch + install the upstream JS into the provider store. Mirrors clode_update.
// Returns 0 on success (including the already-have short-circuit) and 1 on any
// resolve/fetch/verify failure — main() awaits this and exits with the status.
//
// opts: { env=process.env, libexec, here, node=process.execPath,
//         stderr=process.stderr }.
async function clodeUpdate(channel, opts = {}) {
  const {
    env = process.env,
    libexec,
    here,
    node = process.execPath,
    stderr = process.stderr,
  } = opts;
  const err = (m) => stderr.write(m + '\n');

  const chan = resolveChannel(channel, env);
  const base = releasesUrl(env);

  // Resolve version: a numeric channel is used as-is; otherwise fetch the channel
  // file and trim all CR/LF (bin/clode:355-358). A fetch failure -> empty version
  // -> the resolve-failure path below (matching sh's unguarded command sub).
  let ver;
  if (/^[0-9]/.test(chan)) {
    ver = chan;
  } else {
    try {
      const body = await downloadFile(`${base}/${chan}`);
      ver = body.replace(/[\r\n]/g, '');
    } catch {
      ver = '';
    }
  }

  // Validate N.N.N (glob [0-9]*.[0-9]*.[0-9]* over the whole string).
  if (!/^[0-9].*\.[0-9].*\.[0-9]/.test(ver)) {
    err(`clode: couldn't resolve a version for '${chan}' from ${base}`);
    return 1;
  }

  const plat = fetchPlatform(env);

  // Fetch + parse the manifest for this version's platform checksum.
  let manifestText;
  try {
    manifestText = await downloadFile(`${base}/${ver}/manifest.json`);
  } catch {
    err(`clode: failed to fetch manifest for ${ver}`);
    return 1;
  }
  const sum = checksumFor(manifestText, plat);
  if (!/^[0-9a-f]/.test(sum)) {
    err(`clode: platform ${plat} not in manifest for ${ver}`);
    return 1;
  }

  const providers = providersDir(env);
  const dest = path.join(providers, ver);
  const bin = path.join(dest, 'claude');

  // Already have a byte-verified copy? Short-circuit the download but still
  // re-point `current` + report signals below (bin/clode:373-385).
  if (isFile(bin) && sha256Of(bin) === sum) {
    err(`clode: already have ${ver}`);
  } else {
    err(`clode: fetching Claude Code ${ver} (${plat})...`);
    fs.mkdirSync(dest, { recursive: true });
    const tmp = path.join(dest, '.claude.partial');
    try {
      await downloadFile(`${base}/${ver}/${plat}/claude`, tmp);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* absent */ }
      err('clode: download failed');
      return 1;
    }
    if (sha256Of(tmp) !== sum) {
      try { fs.unlinkSync(tmp); } catch { /* absent */ }
      err(`clode: checksum mismatch for ${ver} (corrupt or tampered download)`);
      return 1;
    }
    fs.renameSync(tmp, bin);                                   // atomic mv
    fs.chmodSync(bin, fs.statSync(bin).mode | 0o111);          // chmod +x
  }

  // Record the previous target, then atomically re-point current -> ver.
  let prevVer = '';
  const current = path.join(providers, 'current');
  try {
    if (fs.lstatSync(current).isSymbolicLink()) prevVer = fs.readlinkSync(current);
  } catch { /* no current yet */ }
  relinkCurrent(current, ver);

  err(`clode: updated to ${ver}. Relaunch clode to use it.`);

  // Warn-only post-update signals digest (never affects the exit status).
  await clodeSignalsReport(ver, prevVer, bin, { env, libexec, here, node, stderr });

  return 0;
}

module.exports = { clodeUpdate, clodeSignalsReport, resolveChannel, releasesUrl };
