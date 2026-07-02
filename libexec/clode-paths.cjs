'use strict';
// clode-paths — the single source of truth for clode's on-disk state directories.
// Every XDG/HOME-derived path in the runtime resolves through here, so ONE env var
// (CLODE_STATE_ROOT) can redirect ALL of clode's state — the npm dep store, the SEA
// materialized-deps cache, providers, the extracted-bundle cache, and the watch
// state — for BOTH execution shapes. Pure Node stdlib (runs before any ext-deps are
// ensured); env is injected for testability.
//
// Precedence (high→low): specific override (CLODE_DEPS/CLODE_CACHE/CLODE_PROVIDERS/
// CLODE_WATCH_DIR) > CLODE_STATE_ROOT > XDG_* > HOME.
const os = require('os');
const path = require('path');

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

// The cache dir (~/.cache/clode equiv). CLODE_CACHE IS today's cache override.
function clodeCacheDir(env = process.env) {
  if (env.CLODE_CACHE) return env.CLODE_CACHE;
  if (env.CLODE_STATE_ROOT) return path.join(env.CLODE_STATE_ROOT, 'cache', 'clode');
  const xdg = env.XDG_CACHE_HOME || path.join(homeDir(env), '.cache');
  return path.join(xdg, 'clode');
}

function depsStore(env = process.env) {
  return env.CLODE_DEPS || clodeDataDir(env);
}
function providersDir(env = process.env) {
  return env.CLODE_PROVIDERS || path.join(clodeDataDir(env), 'providers');
}
function watchDir(env = process.env) {
  return env.CLODE_WATCH_DIR || clodeCacheDir(env);
}

module.exports = { clodeDataDir, clodeCacheDir, depsStore, providersDir, watchDir };
