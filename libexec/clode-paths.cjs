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
function nodeStore(env = process.env) {
  return env.CLODE_NODES || path.join(clodeDataDir(env), 'nodes');
}
// watchDir builds on cacheBase, NOT clodeCacheDir — it must ignore CLODE_CACHE (the
// pre-refactor clode-watch.watchDir did), else the watcher writes into the version-
// keyed bundle cache and collides (test_keying/test_selfupdate).
function watchDir(env = process.env) {
  return env.CLODE_WATCH_DIR || cacheBase(env);
}

module.exports = { homeDir, clodeDataDir, clodeCacheDir, depsStore, providersDir, nodeStore, watchDir, cacheBase };
