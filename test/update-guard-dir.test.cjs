'use strict';
// The guard's private directory (controller ruling 2026-11-19, option (a)): `<clode cache>/guard`, one per user on
// every platform, 0700, reused, the merged settings pruned after a week. A directory that is not private is REFUSED:
// quaude and naude refuse to start, and never fall back to another directory. It replaced `<tmp>/clode-guard-<uid>` plus
// a fresh-mkdtemp fallback whose ownership check could never pass on Windows, where libuv reports uid -1, st_uid 0 and
// a synthesized mode: every Windows session made a new directory, and nothing removed it, or the copy of the user's
// settings inside.
//
// The shared rule is update-guard.cjs's guardDirPath, guardDirRefusal and guardSettingsToPrune, inlined byte-identical
// into quaude-bootstrap.mjs (test/update-guard-drift.test.cjs). quaude's own I/O around them, the quaudeGuardDir block,
// is extracted from the bootstrap and run here on a fake tjs over the real filesystem. naude's is in
// test/naude-entry.test.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guardDirPath, guardDirRefusal, guardSettingsToPrune, GUARD_SETTINGS_MAX_AGE_MS } = require('../libexec/update-guard.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');

test('guardDirPath is clodeCacheDir/guard, for each way the clode cache is named', () => {
  const home = path.join(os.tmpdir(), 'h');
  for (const env of [{ HOME: home }, { HOME: home, XDG_CACHE_HOME: path.join(home, 'xdg') },
    { HOME: home, CLODE_STATE_ROOT: path.join(home, 'state') }, { HOME: home, CLODE_CACHE: path.join(home, 'cc') },
    { HOME: home, CLODE_CACHE: path.join(home, 'cc') + path.sep }]) {
    assert.strictEqual(guardDirPath(env, env.HOME, path.sep), path.join(clodeCacheDir(env), 'guard'), JSON.stringify(env));
  }
});

test('guardDirPath, Windows-shaped: the user\'s profile, never the shared temp directory', () => {
  assert.strictEqual(guardDirPath({}, 'C:\\Users\\u', '\\'), 'C:\\Users\\u\\.cache\\clode\\guard');
  assert.strictEqual(guardDirPath({ CLODE_CACHE: 'D:\\c\\' }, 'C:\\Users\\u', '\\'), 'D:\\c\\guard');
});

test('guardDirRefusal: the type everywhere; ownership, mode and the parent where the platform reports an owner', () => {
  const dir = { type: 'dir', uid: 501, mode: 0o40700 };
  const parent = { type: 'dir', uid: 501, mode: 0o40755 };
  assert.strictEqual(guardDirRefusal('/g', dir, parent, 501), null);
  assert.strictEqual(guardDirRefusal('/g', dir, { ...parent, uid: 0 }, 501), null, 'a root-owned parent is fine');
  assert.match(guardDirRefusal('/g', null, parent, 501), /could not be created/);
  assert.match(guardDirRefusal('/g', { ...dir, type: 'link' }, parent, 501), /symbolic link/);
  assert.match(guardDirRefusal('/g', { ...dir, type: 'other' }, parent, 501), /not a directory/);
  assert.match(guardDirRefusal('/g', { ...dir, uid: 502 }, parent, 501), /owned by uid 502/);
  assert.match(guardDirRefusal('/g', { ...dir, mode: 0o40750 }, parent, 501), /open to other users \(mode 750/);
  assert.match(guardDirRefusal('/g', dir, { ...parent, uid: 502 }, 501), /parent is owned by uid 502/);
  assert.match(guardDirRefusal('/g', dir, { ...parent, mode: 0o40777 }, 501), /parent is writable by every user/);
  // Windows: uid -1 (libuv) or none (node): no owner to judge, so only the type is. A symlink is still refused.
  assert.strictEqual(guardDirRefusal('C:\\g', { type: 'dir', uid: 0, mode: 0o40666 }, null, -1), null);
  assert.strictEqual(guardDirRefusal('C:\\g', { type: 'dir', uid: 0, mode: 0o40666 }, null, undefined), null);
  assert.match(guardDirRefusal('C:\\g', { type: 'link', uid: 0, mode: 0o120666 }, null, -1), /symbolic link/);
});

test('guardSettingsToPrune: only settings-<hex>.json, only older than a week', () => {
  const now = 10 * GUARD_SETTINGS_MAX_AGE_MS;
  const old = now - GUARD_SETTINGS_MAX_AGE_MS - 1;
  assert.deepStrictEqual(guardSettingsToPrune([
    { name: 'settings-abc123.json', mtimeMs: old }, { name: 'settings-def456.json', mtimeMs: now - 1000 },
    { name: 'plugin-abc123', mtimeMs: old }, { name: 'settings-x.json', mtimeMs: old },
  ], now), ['settings-abc123.json']);
});

// quaude's block, from the bootstrap itself, on a fake tjs over the real filesystem.
function loadQuaudeGuardDir() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs'), 'utf8');
  const block = (name) => {
    const s = new RegExp(`\\/\\/ >>> ${name}.*>>>\\s*\\n`).exec(src);
    const e = new RegExp(`\\/\\/ <<< ${name} <<<`).exec(src);
    assert.ok(s && e, `quaude-bootstrap.mjs: the ${name} markers`);
    return src.slice(s.index + s[0].length, e.index);
  };
  // eslint-disable-next-line no-new-func
  return new Function(`${block('guardGating')}\n${block('quaudeGuardDir')}\nreturn { privateGuardDir, pruneGuardSettings };`)();
}
function fakeTjs({ home, uid }) {
  return {
    homeDir: home,
    system: { userInfo: { userId: uid } },
    makeDir: async (p, o = {}) => { fs.mkdirSync(p, { recursive: !!o.recursive, mode: o.mode }); },
    lstat: async (p) => { const s = fs.lstatSync(p); return { mode: s.mode, uid: s.uid, mtim: s.mtime }; },
    readDir: async (d) => (async function* entries() { for (const name of fs.readdirSync(d)) yield { name }; })(),
    remove: async (p) => { fs.rmSync(p); },
  };
}
const UID = typeof process.getuid === 'function' ? process.getuid() : -1;

test('quaude: two sessions get ONE directory, under the clode cache, 0700 where modes exist', async () => {
  const { privateGuardDir } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const env = { CLODE_CACHE: path.join(root, 'cache') };
    const a = await privateGuardDir(fakeTjs({ home: root, uid: UID }), env, path.sep);
    const b = await privateGuardDir(fakeTjs({ home: root, uid: UID }), env, path.sep);
    assert.deepStrictEqual(a, { dir: path.join(root, 'cache', 'guard') });
    assert.deepStrictEqual(b, a, 'reused, not a second directory');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'cache')), ['guard']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(a.dir).mode & 0o777, 0o700);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude: the week-old merged settings are pruned; a fresh one and the plugin stay', async () => {
  const { privateGuardDir, pruneGuardSettings } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const { dir } = await privateGuardDir(fakeTjs({ home: root, uid: UID }), { CLODE_CACHE: root }, path.sep);
    const stale = path.join(dir, 'settings-00000000deadbeef.json');
    const fresh = path.join(dir, 'settings-1111111111111111.json');
    fs.writeFileSync(stale, '{"secret":1}'); fs.writeFileSync(fresh, '{}'); fs.mkdirSync(path.join(dir, 'plugin-abc'));
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
    await pruneGuardSettings(fakeTjs({ home: root, uid: UID }), dir, path.sep, Date.now());
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['plugin-abc', 'settings-1111111111111111.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude: a hostile parent or a symlinked guard is REFUSED, and nothing else is made', async () => {
  const { privateGuardDir } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const cache = path.join(root, 'cache');
    fs.mkdirSync(cache);
    // A symlink (a junction on Windows: no privilege needed) where the guard directory belongs: refused everywhere.
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(cache, 'guard'), 'junction');
    const linked = await privateGuardDir(fakeTjs({ home: root, uid: UID }), { CLODE_CACHE: cache }, path.sep);
    assert.match(linked.refusal || '', /guard is a symbolic link/);
    fs.unlinkSync(path.join(cache, 'guard'));
    // A parent every user can write (POSIX facts; a fixed uid where the platform has none, so the rule runs anyway).
    fs.chmodSync(cache, 0o777);
    if ((fs.statSync(cache).mode & 0o002) === 0) return;   // Windows: chmod cannot grant other users anything
    const hostile = await privateGuardDir(fakeTjs({ home: root, uid: UID < 0 ? fs.statSync(cache).uid : UID }), { CLODE_CACHE: cache }, path.sep);
    assert.match(hostile.refusal || '', /parent is writable by every user/);
    assert.strictEqual(hostile.dir, undefined, 'no directory is handed back');
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cache', 'elsewhere'], 'no fallback directory anywhere');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude, Windows-shaped: uid -1 and a synthesized mode are not a refusal (the profile ACL is the privacy)', async () => {
  const { privateGuardDir } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const tjs = fakeTjs({ home: root, uid: -1 });
    const realLstat = tjs.lstat;
    tjs.lstat = async (p) => ({ ...(await realLstat(p)), uid: 0, mode: 0o40666 });   // what libuv reports there
    assert.deepStrictEqual(await privateGuardDir(tjs, { CLODE_CACHE: path.join(root, 'c') }, path.sep), { dir: path.join(root, 'c', 'guard') });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude refuses to start on a refusal, and prunes on every use of the directory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs'), 'utf8');
  assert.match(src, /if \(got\.refusal\) die\(`refusing to start: the update guard's private directory is unsafe: \$\{got\.refusal\}`, 1\);/);
  assert.doesNotMatch(src, /makeTempDir\([^)]*clode-guard/, 'no fresh-tmp fallback survives');
});
