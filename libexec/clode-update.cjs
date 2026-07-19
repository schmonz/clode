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
const { provision } = require('./host-provision.cjs');
const cpaths = require('./clode-paths.cjs');
const { currentVersion, setCurrent } = require('./clode-current.cjs');

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
// Node process.platform/arch -> the upstream manifest platform string to fetch.
// Bun specializes each per-platform Claude Code build at compile time (folds
// process.platform/arch AND dead-code-eliminates the other platforms' branches),
// so a linux-x64 carve behaves as LINUX on every host (proven 2026-07-19). We
// therefore match the target's OS. Arch is don't-care for the carve: tjs loads no
// native .node addons and the sole arch-switch is moot, so any same-OS build
// carves the right OS branches. OSes upstream does not build (netbsd/freebsd/...)
// fall back to linux-x64 (Unix-closest branches), LOGGED, never silently.
function manifestPlatforms(manifestText) {
  try { const m = JSON.parse(manifestText); return Object.keys(m.platforms || m); }
  catch { return []; }
}

// glibc runtime absent => musl (mirrors scripts/platform-tag.cjs linuxGlibc()).
function isMuslRuntime() {
  try { return !process.report.getReport().header.glibcVersionRuntime; }
  catch { return false; }
}

function providerFor(platform, arch, available, opts = {}) {
  const log = opts.log || (() => {});
  const has = (p) => available.includes(p);
  if (platform === 'linux') {
    const musl = 'isMusl' in opts ? opts.isMusl : isMuslRuntime();
    const exact = `linux-${arch}${musl ? '-musl' : ''}`;
    if (has(exact)) return exact;
    if (has(`linux-${arch}`)) return `linux-${arch}`;
    const anyLinux = available.find((p) => p.startsWith('linux-'));
    if (anyLinux) return anyLinux;
  } else if (platform === 'darwin' || platform === 'win32') {
    const exact = `${platform}-${arch}`;
    if (has(exact)) return exact;
    const sameOs = available.find((p) => p.startsWith(platform + '-')); // arch don't-care
    if (sameOs) return sameOs;
  }
  log(`clode: no upstream provider for ${platform}-${arch}; carving linux-x64 (Unix-closest branches)`);
  return has('linux-x64') ? 'linux-x64' : (available.find((p) => p.startsWith('linux-')) || 'linux-x64');
}

function fetchPlatform(env, manifestText, opts) {
  if (env.CLODE_FETCH_PLATFORM) return env.CLODE_FETCH_PLATFORM;
  return providerFor(process.platform, process.arch, manifestPlatforms(manifestText || ''), opts);
}
function changelogUrl(env) {
  return env.CLODE_CHANGELOG_URL ||
    'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
}
function providersDir(env) {
  return cpaths.providersDir(env);
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

// The container filename for a platform, from the manifest's platforms.<plat>.binary
// (self-describing: "claude" for linux-x64, "claude.exe" for win32-x64). Defaults to
// "claude". This is only the name of the file we DOWNLOAD — we carve the JS out of it
// and store it under clode's canonical `claude` name; we never run it, so which
// platform's container we fetch is arbitrary (the JS is identical per version).
function binaryFor(manifestText, plat) {
  try {
    const m = JSON.parse(manifestText);
    const p = m.platforms || m;
    return (p[plat] || {}).binary || 'claude';
  } catch {
    return 'claude';
  }
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

  // Fetch + parse the manifest for this version's platform checksum.
  let manifestText;
  try {
    manifestText = await downloadFile(`${base}/${ver}/manifest.json`);
  } catch {
    err(`clode: failed to fetch manifest for ${ver}`);
    return 1;
  }
  const plat = fetchPlatform(env, manifestText, { log: err });
  const sum = checksumFor(manifestText, plat);
  if (!/^[0-9a-f]/.test(sum)) {
    err(`clode: platform ${plat} not in manifest for ${ver}`);
    return 1;
  }

  // Verifying the download's sha256 against the manifest checksum is mandatory
  // (upstream's integrity gate). Provision the digest tool NOW — before a ~265MB
  // download — so a toolless host fails instantly, not after minutes of transfer.
  try {
    provision('sha256', { env });
  } catch (e) {
    err(e.message);
    return 1;
  }

  const providers = providersDir(env);
  const dest = path.join(providers, ver);
  const bin = path.join(dest, 'claude');

  // The version `current` points at now — for no-op detection and the signals
  // diff's baseline.
  const prevVer = currentVersion(env);

  const haveIt = isFile(bin) && sha256Of(bin, { env }) === sum;

  // Nothing to do: we already have this exact build AND `current` already points
  // at it. Report it cleanly and stop — no false "updated to", and no signals
  // digest diffing the version against itself.
  if (haveIt && prevVer === ver) {
    err(`clode: already up to date (${ver}).`);
    return 0;
  }

  if (haveIt) {
    // Byte-verified copy on disk (a re-point to an already-fetched version):
    // short-circuit the download (bin/clode:373-385).
    err(`clode: already have ${ver}`);
  } else {
    err(`clode: fetching Claude Code ${ver} (${plat})...`);
    fs.mkdirSync(dest, { recursive: true });
    const tmp = path.join(dest, '.claude.partial');
    // Progress rendering: the provider binary is ~240MB, so a silent download
    // "looks eternally stuck". Update in place on a TTY (\r + clear-to-EOL);
    // fall back to a newline every 10% for a piped/log stderr. Throttled to
    // integer-percent changes (or ~4MB steps when content-length is absent).
    const isTTY = !!stderr.isTTY;
    let lastStep = -1;
    const onProgress = (received, total) => {
      let line, step;
      if (total > 0) {
        step = Math.floor((received / total) * 100);
        if (step === lastStep) return;
        line = `clode: fetching ${ver} — ${step}% (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`;
      } else {
        step = Math.floor(received / 4194304);
        if (step === lastStep) return;
        line = `clode: fetching ${ver} — ${(received / 1048576).toFixed(1)} MB`;
      }
      lastStep = step;
      if (isTTY) stderr.write(`\r${line}\x1b[K`);
      else if (total <= 0 || step % 10 === 0) stderr.write(`${line}\n`);
    };
    try {
      await downloadFile(`${base}/${ver}/${plat}/${binaryFor(manifestText, plat)}`, tmp, { onProgress });
      if (isTTY && lastStep >= 0) stderr.write('\n'); // finish the in-place line
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* absent */ }
      err('clode: download failed');
      return 1;
    }
    if (sha256Of(tmp, { env }) !== sum) {
      try { fs.unlinkSync(tmp); } catch { /* absent */ }
      err(`clode: checksum mismatch for ${ver} (corrupt or tampered download)`);
      return 1;
    }
    fs.renameSync(tmp, bin);                                   // atomic mv
    fs.chmodSync(bin, fs.statSync(bin).mode | 0o111);          // chmod +x
  }

  // Atomically re-point current -> ver.
  setCurrent(env, ver);

  err(`clode: fetched ${ver} — now the active provider.`);

  // Warn-only post-update signals digest (never affects the exit status). Only
  // when the effective version actually changed — a same-version diff is noise.
  if (prevVer !== ver) {
    await clodeSignalsReport(ver, prevVer, bin, { env, libexec, here, node, stderr });
  }

  return 0;
}

module.exports = { clodeUpdate, clodeSignalsReport, resolveChannel, releasesUrl, binaryFor, providerFor, manifestPlatforms };
