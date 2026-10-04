'use strict';
// node-shim refuses an engine whose sync stat carries no identity (ERR_CLODE_ENGINE_FLOOR, from
// txiki-sync-stat-identity.patch's absence) rather than reporting dev and ino 0. A refusal only
// helps if it is SEEN: a catch-all caller turns it into something ordinary. watchFile's poller was
// one, inside node-shim itself: every stat failure there reads as "the file is gone", so on a stale
// engine every watched file looked deleted and nothing said why. And because the bundle has its own
// catch-alls, the first refusal is also written to stderr, once.
//
// A stale engine is simulated, not built: the program swaps in a __tjs_fs_sync whose stat, lstat
// and fstat drop `ino`, then loads a FRESH copy of node-shim's fs module by path, which binds to it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const PROG = `
const real = globalThis.__tjs_fs_sync;
const strip = (f) => (...a) => { const r = f.apply(real, a); delete r.ino; return r; };
globalThis.__tjs_fs_sync = Object.create(real, { stat: { value: strip(real.stat), writable: true }, lstat: { value: strip(real.lstat), writable: true },
  fstat: { value: strip(real.fstat), writable: true } });
const fsx = require(process.argv[2]);
const file = process.argv[3];
const out = {};
const finish = () => { fsx.unwatchFile(file); console.log(JSON.stringify(out)); process.exit(0); };
const first = {};
try { fsx.statSync(file); first.statSync = 'returned'; } catch (e) { first.statSync = e.code; }
try { fsx.lstatSync(file); first.lstatSync = 'returned'; } catch (e) { first.lstatSync = e.code; }
console.log(JSON.stringify(first));
process.on('uncaughtException', (e) => { out.watchFile = e.code || String(e); finish(); });
fsx.watchFile(file, { interval: 20 }, (curr) => { out.listener = 'called, mtimeMs ' + curr.mtimeMs; });
setTimeout(() => { out.watchFile = out.watchFile || 'silent'; finish(); }, 2000);
`;

test('a stale engine is refused out loud: by stat, by watchFile\'s poller, and once on stderr', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-engine-floor-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const file = path.join(base, 'watched.txt');
    fs.writeFileSync(file, 'x\n');
    const r = runLoader(prog, [path.join(REPO, 'libexec/node-shim/modules/fs.cjs'), file], { timeout: 30000 });
    const [first, second] = r.stdout.trim().split('\n');
    assert.ok(first, `printed nothing: ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(first), { statSync: 'ERR_CLODE_ENGINE_FLOOR', lstatSync: 'ERR_CLODE_ENGINE_FLOOR' });
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
