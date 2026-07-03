const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const P = require('../libexec/clode-paths.cjs');

const HOME = '/h';
const share = path.join(HOME, '.local', 'share', 'clode');
const cache = path.join(HOME, '.cache', 'clode');

test('clodeDataDir: CLODE_STATE_ROOT > XDG_DATA_HOME > HOME', () => {
  assert.strictEqual(P.clodeDataDir({ HOME }), share);
  assert.strictEqual(P.clodeDataDir({ HOME, XDG_DATA_HOME: '/xdg' }), path.join('/xdg', 'clode'));
  assert.strictEqual(P.clodeDataDir({ HOME, XDG_DATA_HOME: '/xdg', CLODE_STATE_ROOT: '/s' }),
    path.join('/s', 'share', 'clode'));
});

test('clodeCacheDir: CLODE_CACHE > CLODE_STATE_ROOT > XDG_CACHE_HOME > HOME', () => {
  assert.strictEqual(P.clodeCacheDir({ HOME }), cache);
  assert.strictEqual(P.clodeCacheDir({ HOME, XDG_CACHE_HOME: '/xc' }), path.join('/xc', 'clode'));
  assert.strictEqual(P.clodeCacheDir({ HOME, CLODE_STATE_ROOT: '/s' }), path.join('/s', 'cache', 'clode'));
  assert.strictEqual(P.clodeCacheDir({ HOME, CLODE_STATE_ROOT: '/s', CLODE_CACHE: '/c' }), '/c');
});

test('cacheBase (public): CLODE_STATE_ROOT > XDG_CACHE_HOME > HOME, ignores CLODE_CACHE', () => {
  assert.strictEqual(P.cacheBase({ HOME }), cache);
  assert.strictEqual(P.cacheBase({ HOME, XDG_CACHE_HOME: '/xc' }), require('path').join('/xc', 'clode'));
  assert.strictEqual(P.cacheBase({ HOME, CLODE_STATE_ROOT: '/s' }), require('path').join('/s', 'cache', 'clode'));
  assert.strictEqual(P.cacheBase({ HOME, CLODE_CACHE: '/c' }), cache); // ignores CLODE_CACHE
});

test('derived dirs layer their specific override on the base', () => {
  assert.strictEqual(P.depsStore({ HOME }), share);
  assert.strictEqual(P.depsStore({ HOME, CLODE_DEPS: '/d' }), '/d');
  assert.strictEqual(P.providersDir({ HOME }), path.join(share, 'providers'));
  assert.strictEqual(P.providersDir({ HOME, CLODE_PROVIDERS: '/p' }), '/p');
  assert.strictEqual(P.watchDir({ HOME }), cache);
  assert.strictEqual(P.watchDir({ HOME, CLODE_WATCH_DIR: '/w' }), '/w');
});

test('CLODE_STATE_ROOT contains BOTH data and cache (npm + SEA seal)', () => {
  const env = { CLODE_STATE_ROOT: '/sandbox' };
  assert.ok(P.depsStore(env).startsWith('/sandbox/'));
  assert.ok(P.clodeCacheDir(env).startsWith('/sandbox/'));
  assert.ok(P.providersDir(env).startsWith('/sandbox/'));
  assert.ok(P.watchDir(env).startsWith('/sandbox/'));
});

test('falls back to os.homedir() when HOME unset', () => {
  assert.strictEqual(P.clodeDataDir({}), path.join(os.homedir(), '.local', 'share', 'clode'));
});

test('watchDir ignores CLODE_CACHE (uses cache base) while clodeCacheDir honors it', () => {
  const env = { HOME, CLODE_CACHE: '/bundlecache' };
  assert.strictEqual(P.clodeCacheDir(env), '/bundlecache');
  assert.strictEqual(P.watchDir(env), cache);           // HOME-based, NOT /bundlecache
  assert.strictEqual(P.watchDir({ CLODE_STATE_ROOT: '/s' }), require('path').join('/s', 'cache', 'clode'));
});

test('a caller (clode-watch.watchDir) honors CLODE_STATE_ROOT via clode-paths', () => {
  const watch = require('../libexec/clode-watch.cjs');
  const got = watch.watchDir({ CLODE_STATE_ROOT: '/sandbox' });
  assert.strictEqual(got, require('path').join('/sandbox', 'cache', 'clode'));
});
