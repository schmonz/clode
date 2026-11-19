'use strict';
// node-shim on an engine whose sync stat carries no identity (txiki-sync-stat-identity.patch's
// absence -- the engine the last release shipped, measured: test/fixtures/stale-engine-prelude.js).
//
// THE RULE: never an invented answer. Such an engine reports a file's mode and size exactly and
// nothing else node's Stats has (no dev, ino, nlink, rdev, blksize or blocks; a whole-second
// mtime and no other time; uid/gid unverified as unsigned). So a Stats from it carries exactly
// those two fields, and READING ANY OTHER ONE refuses with ERR_CLODE_ENGINE_FLOOR -- rather than
// reporting dev and ino 0, which is what node-shim did before 6d43ee6 and what made two files one.
//
// WHY PER FIELD AND NOT AT THE STAT CALL. Refusing at the stat call (6d43ee6's first shape) also
// refused programs that never look at identity, and one of them is the builder: the bootstrap
// engine -- the LAST release's -- hosts scripts/build-tjs.cjs under HEAD's node-shim, and
// node-shim's own copyFileSync reads `.mode` to carry the executable bit. That made CI run
// 44443821699 red on every leg, with "cut a release" as its only remedy, while release.yml
// builds through the very same refusal. Measured on the real v0.20260831.1 slice, the WHOLE
// engine build reads `mode` and nothing else. The refusal now sits exactly where a wrong answer
// would have been read, so a program that needs identity still cannot get a false one.
//
// A refusal only helps if it is SEEN: a catch-all caller turns it into something ordinary.
// watchFile's poller was one, inside node-shim itself (every stat failure reads as "the file is
// gone"); it needs mtimeMs, so it still refuses at its stat. And because the bundle has its own
// catch-alls, the first refusal is also written to stderr, once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const PRELUDE = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js'), 'utf8');

// Every field node's Stats has besides mode and size, and the bigint form's *Ns.
const REFUSED = ['dev', 'ino', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'blocks',
  'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'atime', 'mtime', 'ctime', 'birthtime'];
const REFUSED_BIGINT = REFUSED.concat(['atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs']);

const PROG = `${PRELUDE}
const fsx = require(process.argv[2]);
const file = process.argv[3];
const exe = process.argv[4];
const copy = process.argv[5];
const code = (f) => { try { const v = f(); return typeof v === 'bigint' ? 'bigint ' + v : v; } catch (e) { return e.code || String(e); } };
const out = {};
const s = fsx.statSync(file);
const b = fsx.statSync(file, { bigint: true });
const l = fsx.lstatSync(file);
out.kept = { mode: s.mode, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), dirIsDirectory: fsx.statSync(process.argv[6]).isDirectory(),
  bigMode: code(() => b.mode), bigSize: code(() => b.size), lstatMode: l.mode };
out.refused = {};
for (const f of ${JSON.stringify(REFUSED)}) out.refused[f] = code(() => s[f]);
out.refusedBig = {};
for (const f of ${JSON.stringify(REFUSED_BIGINT)}) out.refusedBig[f] = code(() => b[f]);
out.json = code(() => JSON.stringify(s));
fsx.copyFileSync(exe, copy);
out.copyMode = fsx.statSync(copy).mode & 0o777;
console.log(JSON.stringify(out));
const fin = {};
const finish = () => { fsx.unwatchFile(file); console.log(JSON.stringify(fin)); process.exit(0); };
process.on('uncaughtException', (e) => { fin.watchFile = e.code || String(e); finish(); });
fsx.watchFile(file, { interval: 20 }, (curr) => { fin.listener = 'called, mtimeMs ' + curr.mtimeMs; });
setTimeout(() => { fin.watchFile = fin.watchFile || 'silent'; finish(); }, 2000);
`;

test('a stale engine: mode and size are exact, every other Stats field is refused out loud, and watchFile refuses', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-engine-floor-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const file = path.join(base, 'watched.txt');
    fs.writeFileSync(file, 'hello\n');
    const exe = path.join(base, 'tool.sh');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);
    const r = runLoader(prog, [path.join(REPO, 'libexec/node-shim/modules/fs.cjs'), file, exe,
      path.join(base, 'copy.sh'), base], { timeout: 30000 });
    const [first, second] = r.stdout.trim().split('\n');
    assert.ok(first, `printed nothing: ${r.stderr}`);
    const got = JSON.parse(first);
    const st = fs.statSync(file);
    assert.deepStrictEqual(got.kept, { mode: st.mode, size: 6, isFile: true, isDirectory: false, dirIsDirectory: true,
      bigMode: `bigint ${st.mode}`, bigSize: 'bigint 6', lstatMode: st.mode },
      'mode and size are what that engine reports exactly; the predicates read mode');
    for (const f of REFUSED) assert.strictEqual(got.refused[f], 'ERR_CLODE_ENGINE_FLOOR', `Stats.${f} must refuse, never invent: ${got.refused[f]}`);
    for (const f of REFUSED_BIGINT) assert.strictEqual(got.refusedBig[f], 'ERR_CLODE_ENGINE_FLOOR', `BigIntStats.${f} must refuse, never invent: ${got.refusedBig[f]}`);
    assert.strictEqual(got.json, 'ERR_CLODE_ENGINE_FLOOR', 'serializing a Stats reads every field, so it refuses too');
    // node-shim's own copyFileSync -- the read that killed every CI leg -- carries the mode.
    assert.strictEqual(got.copyMode, 0o755);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(base, 'copy.sh')).mode & 0o777, 0o755);
    // The poller runs on the engine's own timer (see _pollerSchedule), so its throw ends the process
    // there rather than reaching 'uncaughtException'. Either is loud; "silent" (every watched file
    // reading as deleted) is the failure.
    if (second !== undefined) assert.deepStrictEqual(JSON.parse(second).watchFile, 'ERR_CLODE_ENGINE_FLOOR', r.stderr);
    else {
      assert.notStrictEqual(r.status, 0, 'the poller\'s refusal ended the process, so it must say so in its status');
      assert.match(r.stderr, /at _statOrZero/, r.stderr);
    }
    const said = r.stderr.split('\n').filter((l) => l.startsWith('node-shim: this engine'));
    assert.strictEqual(said.length, 1, `the refusal goes to stderr exactly once:\n${r.stderr}`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// CLODE_ENGINE_FLOOR_LOG (libexec/node-shim/internal/engine-floor-log.cjs): what build-leg gates the
// engine phases on. A refusal the program SWALLOWED is the case the stderr-once line cannot carry to
// a gate, so the log must hold EVERY refusal, caught or not, each with its stack -- and rg-native's
// strerror fallback, which throws nothing at all, must land there too.
const SWALLOW = `${PRELUDE}
const fsx = require(process.argv[2]);
const rg = require(process.argv[4]);
let m = 'unset';
try { m = fsx.statSync(process.argv[3]).mtimeMs; } catch { /* the wrong branch, taken quietly */ }
try { m = fsx.statSync(process.argv[3]).ino; } catch { /* and again */ }
const e = Object.assign(new Error('x'), { code: 'ENOENT', errno: -2 });
console.log(JSON.stringify({ m, mode: typeof fsx.statSync(process.argv[3]).mode, rgText: rg.osErrorText(e) }));
`;

test('CLODE_ENGINE_FLOOR_LOG records every refusal a program swallowed, and the strerror fallback', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-floor-log-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, SWALLOW);
    const log = path.join(base, 'floor.log');
    const r = runLoader(prog, [path.join(REPO, 'libexec/node-shim/modules/fs.cjs'), prog, path.join(REPO, 'libexec/rg-native.cjs')],
      { timeout: 30000, env: { CLODE_ENGINE_FLOOR_LOG: log } });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual({ m: got.m, mode: got.mode }, { m: 'unset', mode: 'number' }, 'the program carried on, as a catch-all does');
    assert.match(got.rgText, /no such file or directory/i, 'rg still answers, from its fallback');
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const entries = text.split('\n').filter((l) => l.startsWith('node-shim: this engine') || l.startsWith('rg-native:'));
    assert.deepStrictEqual(entries.map((l) => l.replace(/ \(.*$/, '')), [
      "node-shim: this engine's sync stat carries no mtimeMs",
      "node-shim: this engine's sync stat carries no ino",
      'rg-native: this engine has no __tjs_fs_sync.strerror',
    ], `EVERY floor event, in order, not just the first:\n${text}`);
    assert.match(text, /at floorError/, 'each with its stack');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// The floor report needs node-shim's writer. An engine with __tjs_fs_sync but no __nodeShim.engineFloorLog used to
// drop rg-native's report SILENTLY; it now says so once, on stderr, as a finding.
const NO_WRITER = `${PRELUDE}
const rg = require(process.argv[2]);
if (globalThis.__nodeShim) globalThis.__nodeShim = Object.assign({}, globalThis.__nodeShim, { engineFloorLog: undefined });
const e = Object.assign(new Error('x'), { code: 'ENOENT', errno: -2 });
console.log(JSON.stringify([rg.osErrorText(e), rg.osErrorText(e)]));
`;
test('rg-native names a missing floor-log writer once on stderr, instead of dropping the report', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-floor-nowriter-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, NO_WRITER);
    const r = runLoader(prog, [path.join(REPO, 'libexec/rg-native.cjs')], { timeout: 30000 });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const said = r.stderr.split('\n').filter((l) => l.startsWith('rg-native: FINDING: engine floor not logged'));
    assert.strictEqual(said.length, 1, `once, not per call:\n${r.stderr}`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
