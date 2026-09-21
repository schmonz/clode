'use strict';
// clode-paths — the single source of truth for clode's on-disk state directories.
// Every XDG/HOME-derived path in the runtime resolves through here, so ONE env var
// (CLODE_STATE_ROOT) can redirect ALL of clode's state — the npm dep store, the SEA
// materialized-deps cache, providers, the extracted-bundle cache, and the watch
// state — for BOTH execution shapes. Pure Node stdlib (runs before any ext-deps are
// ensured); env is injected for testability.
//
// Precedence (high→low): specific override (CLODE_DEPS/CLODE_CACHE/CLODE_PROVIDERS/
// CLODE_NODES/CLODE_WATCH_DIR) > CLODE_STATE_ROOT > XDG_* > HOME.
const os = require('node:os');
const path = require('node:path');

function homeDir(env) {
  return env.HOME || os.homedir();
}

// The data base (~/.local/share/clode equiv). No single base-override var exists;
// it is overridden per-use by CLODE_DEPS / CLODE_PROVIDERS.
function clodeDataDir(env = process.env) {
  if (env.CLODE_STATE_ROOT) return path.join(env.CLODE_STATE_ROOT, 'share', 'clode');
  const xdg = env.XDG_DATA_HOME || path.join(homeDir(env), '.local', 'share');
  return path.join(xdg, 'clode');
}

// The cache LOCATION, independent of the CLODE_CACHE override. Both the extracted-
// bundle cache and the watch dir share this base; each layers its OWN override on top
// (CLODE_CACHE / CLODE_WATCH_DIR). Kept separate so the watch dir does NOT move when
// only CLODE_CACHE is set — preserving clode-watch's prior behavior (its watchDir
// never consulted CLODE_CACHE).
function cacheBase(env) {
  if (env.CLODE_STATE_ROOT) return path.join(env.CLODE_STATE_ROOT, 'cache', 'clode');
  const xdg = env.XDG_CACHE_HOME || path.join(homeDir(env), '.cache');
  return path.join(xdg, 'clode');
}

// The extracted-bundle cache dir. CLODE_CACHE IS today's override.
function clodeCacheDir(env = process.env) {
  return env.CLODE_CACHE || cacheBase(env);
}

function depsStore(env = process.env) {
  return env.CLODE_DEPS || clodeDataDir(env);
}
function providersDir(env = process.env) {
  return env.CLODE_PROVIDERS || path.join(clodeDataDir(env), 'providers');
}
// --- THE PROVIDER STORE'S LAYOUT ---------------------------------------------
// `providers/<version>/<os>-<arch>/claude`, and the reason for the middle segment is the
// whole of spec 2026-09-14 phase 4 §7.1: the store used to be `providers/<version>/claude`,
// keyed by VERSION ALONE, while `clode fetch claude` is OS-MATCHED. So the same path meant
// different bytes on different machines -- and on one machine, whichever target was fetched
// FIRST for a version occupied the path and later fetches re-pointed to it instead of
// fetching their own (clode-update's "byte-verified copy on disk" branch). First writer
// wins, silently. Measured consequence, 2026-09-04: `quaude doctor` on a darwin-arm64 Mac
// reporting `Platform: linux-x64`, because Bun folds process.platform at carve time and the
// pinned path held a linux carve -- with upstream's whole macOS credential store
// dead-coded away.
//
// The key is therefore a function of WHAT THE ARTIFACT IS, not of the one attribute
// someone happened to name. Spelled in the repo's ONE naming vocabulary
// (scripts/canonical-name.cjs), the same `<os>-<arch>` that names a published asset, a
// `--list-targets` tag and an engine artifact -- not a second spelling invented here.
const canon = require('../scripts/canonical-name.cjs');

// The store key for a NODE-spelled platform/arch pair: process.platform + process.arch for
// this host, or the two leading segments of an upstream manifest platform string
// (`darwin-arm64`, `linux-x64`, `win32-x64`), or a container sniff
// (providerPlatformOf/providerArchOf). Defaults to this host.
function providerKey(platform = process.platform, arch = process.arch) {
  return canon.targetFromNode(platform, arch);
}

// `providers/<version>` — the entries for one upstream version, one per carve.
function providerVersionDir(env, version) {
  return path.join(providersDir(env), version);
}

// `providers/<version>/<key>/claude` — one provider binary, at a path that says what it is.
function providerBinPath(env, version, key) {
  return path.join(providerVersionDir(env, version), key, 'claude');
}

// WHICH entry a given host may use, out of the keys present for a version. PURE, so the
// policy is testable without a store on disk.
//
// The policy is not invented here either: it is the same one clode-update's providerFor()
// already applies when CHOOSING what to fetch, restated on the reading side so the two
// cannot disagree. Exact `<os>-<arch>` first; then any entry with the SAME OS, because
// "arch is don't-care for the carve" (clode-update: tjs loads no native .node addons and
// the sole arch-switch is moot, so any same-OS build carves the right OS branches) and
// refusing the fallback here would turn a documented fetch fallback into a permanent cache
// miss -- a re-fetch loop, not a fix. What it NEVER does is cross the OS boundary: that is
// the defect, and it is now unrepresentable rather than unlikely.
function pickProviderEntry(keys, platform = process.platform, arch = process.arch) {
  const want = providerKey(platform, arch);
  if (keys.includes(want)) return want;
  const osPrefix = `${canon.canonOsFromNode(platform)}-`;
  return keys.find((k) => k.startsWith(osPrefix)) || null;
}

function nodeStore(env = process.env) {
  return env.CLODE_NODES || path.join(clodeDataDir(env), 'nodes');
}
// watchDir builds on cacheBase, NOT clodeCacheDir — it must ignore CLODE_CACHE (the
// pre-refactor clode-watch.watchDir did), else the watcher writes into the version-
// keyed bundle cache and collides (test_keying/test_selfupdate).
function watchDir(env = process.env) {
  return env.CLODE_WATCH_DIR || cacheBase(env);
}

// The durable build-timing log. It must survive ACROSS builds, so it cannot live in
// build scratch (phase 1 made that off-tree and ephemeral on purpose) and it must not
// live in the checkout (phase 1 exists to keep writes out of it). So it joins the
// existing HOME/XDG state mechanism rather than inventing a location.
function traceLog(env = process.env) {
  return env.CLODE_TRACE_LOG || path.join(clodeDataDir(env), 'build-trace.jsonl');
}

module.exports = {
  homeDir, clodeDataDir, clodeCacheDir, depsStore, providersDir, nodeStore, watchDir, cacheBase, traceLog,
  providerKey, providerVersionDir, providerBinPath, pickProviderEntry,
};
