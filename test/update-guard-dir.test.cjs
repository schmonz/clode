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
const { defineGuard, guardTests } = require('./guard.cjs');

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
  // A POSIX caller that could not learn its uid is refused, never waved through.
  assert.match(guardDirRefusal('/g', dir, parent, undefined), /uid is unknown/);
  assert.match(guardDirRefusal('/g', dir, parent, -1), /uid is unknown/);
});

// WHAT REAL WINDOWS REPORTS (windows-latest, CI 44572930594): node's stat gives st_uid 0 and mode 0o40666 for a
// directory, whatever its ACL; process.getuid does not exist; libuv's uv_os_get_passwd (tjs.system.userInfo) gives uid
// -1. The rows before that run synthesized uid -1 on the STAT side, which real Windows never reports: an instrument that
// could not see the bug. These facts are the real ones, and the platform, not the uid, decides.
const WIN_DIR = { type: 'dir', uid: 0, mode: 0o40666 };
test('guardDirRefusal, real Windows facts: only the type is judged on win32; the same numbers on POSIX are refused', () => {
  for (const uid of [undefined, -1, 0]) {
    assert.strictEqual(guardDirRefusal('C:\\g', WIN_DIR, WIN_DIR, uid, 'win32'), null, `uid ${uid}`);
  }
  assert.match(guardDirRefusal('C:\\g', { ...WIN_DIR, type: 'link', mode: 0o120666 }, WIN_DIR, undefined, 'win32'), /symbolic link/);
  assert.match(guardDirRefusal('/g', WIN_DIR, WIN_DIR, 0, 'linux'), /open to other users \(mode 666/, 'POSIX judges these numbers');
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
    // The real platform and its real facts: on windows-latest this is the real-Windows row (an ordinary start succeeds
    // and reuses the directory).
    const a = await privateGuardDir(fakeTjs({ home: root, uid: UID }), env, path.sep, process.platform);
    const b = await privateGuardDir(fakeTjs({ home: root, uid: UID }), env, path.sep, process.platform);
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
    const { dir } = await privateGuardDir(fakeTjs({ home: root, uid: UID }), { CLODE_CACHE: root }, path.sep, process.platform);
    const stale = path.join(dir, 'settings-00000000deadbeef.json');
    const fresh = path.join(dir, 'settings-1111111111111111.json');
    fs.writeFileSync(stale, '{"secret":1}'); fs.writeFileSync(fresh, '{}'); fs.mkdirSync(path.join(dir, 'plugin-abc'));
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
    await pruneGuardSettings(fakeTjs({ home: root, uid: UID }), dir, path.sep, Date.now());
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['plugin-abc', 'settings-1111111111111111.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude: a symlinked guard (a junction on Windows) is REFUSED on every platform', async () => {
  const { privateGuardDir } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const cache = path.join(root, 'cache');
    fs.mkdirSync(cache);
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(cache, 'guard'), 'junction');
    const linked = await privateGuardDir(fakeTjs({ home: root, uid: UID }), { CLODE_CACHE: cache }, path.sep, process.platform);
    assert.match(linked.refusal || '', /guard is a symbolic link/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude, POSIX: a parent every user can write is REFUSED, and nothing else is made', { skip: process.platform === 'win32' && 'POSIX only: Windows has no POSIX owner or mode (node reports st_uid 0 and a mode synthesized from the read-only bit, and chmod cannot grant other users anything), so there is no hostile parent to plant; the Windows rule is the Windows-facts rows' }, async () => {
  const { privateGuardDir } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const cache = path.join(root, 'cache');
    fs.mkdirSync(cache);
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.chmodSync(cache, 0o777);
    const hostile = await privateGuardDir(fakeTjs({ home: root, uid: UID }), { CLODE_CACHE: cache }, path.sep, process.platform);
    assert.match(hostile.refusal || '', /parent is writable by every user/);
    assert.strictEqual(hostile.dir, undefined, 'no directory is handed back');
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cache', 'elsewhere'], 'no fallback directory anywhere');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quaude, real Windows facts: tjs uid -1, st_uid 0, mode 0o40666 are not a refusal on win32 (the profile ACL is the privacy)', async () => {
  const { privateGuardDir } = loadQuaudeGuardDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qguard-'));
  try {
    const tjs = fakeTjs({ home: root, uid: -1 });
    const realLstat = tjs.lstat;
    tjs.lstat = async (p) => ({ ...(await realLstat(p)), uid: 0, mode: 0o40666 });   // what windows-latest reports
    assert.deepStrictEqual(await privateGuardDir(tjs, { CLODE_CACHE: path.join(root, 'c') }, path.sep, 'win32'), { dir: path.join(root, 'c', 'guard') });
    // The SAME numbers on a POSIX platform are refused: the platform, not the uid, decides.
    assert.match((await privateGuardDir(tjs, { CLODE_CACHE: path.join(root, 'c') }, path.sep, 'linux')).refusal || '', /uid is unknown/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// quaude refuses to start on a refusal and never falls back to a fresh temp directory: read from the bootstrap's
// source, so a guard. The control is the shape this replaced (bd68250): a makeTempDir clode-guard fallback, no die.
const REFUSES = /if \(got\.refusal\) die\(`refusing to start: the update guard's private directory is unsafe: \$\{got\.refusal\}`, 1\);/;
const TMP_FALLBACK = /makeTempDir\([^)]*clode-guard/;
guardTests(defineGuard({
  name: 'quaude-guard-dir-fails-closed',
  read: () => [{ rel: 'libexec/quaude-bootstrap.mjs', src: fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs'), 'utf8') }],
  scan: (srcs) => {
    const findings = [];
    for (const { rel, src } of srcs) {
      if (!REFUSES.test(src)) findings.push(`${rel}: no die() on the guard directory's refusal: quaude would start with an unsafe guard`);
      if (TMP_FALLBACK.test(src)) findings.push(`${rel}: a fresh-temp clode-guard fallback survives`);
    }
    return { findings, examined: srcs.length };
  },
  control: () => [{ rel: 'planted', src: "const dir = await tjs.makeTempDir(tmpBase + sep + 'clode-guard-XXXXXX');" }],
}));
