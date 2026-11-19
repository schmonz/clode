'use strict';
// node-shim's exclusive create and create mode, raced on purpose (observability Task 3, fix round 1).
//
// The engine's sync open has no O_EXCL, no O_NOFOLLOW and no mode (spike/quickjs/patches/
// txiki-sync-fs.patch js_fss_open), so node-shim builds node's exclusive create out of primitives that
// are each atomic: a private 0700 directory, the file made and chmodded inside it, the path CLAIMED
// with symlink(2) (never follows, EEXIST if anything is there), then renamed over its own claim
// (libexec/node-shim/modules/fs.cjs createExclusive). Until then (46bd197) it was lstat-then-open: two
// creators could both "win" one `wx` path, the loser's open truncating the winner's file through
// FSS.open(p, 'w'), and a 0600 file existed at 0644 until a chmod after the open. The 2.1.283 carve
// creates with O_EXCL / "wx" for its config writer, launcher settings, the MCP config and the seed
// reads' batch files, so both windows are security items (BACKLOG: "node-shim's exclusive create").
//
// These rows race real processes on the real engine and count what node never allows:
//   1. RACE: K workers try openSync(lock-i, 'wx') for the same i, together; each i has ONE winner, and
//      the file holds that winner's bytes (a second "winner" truncates and overwrites it).
//   2. MODE WINDOW: while a worker creates files with fs.promises.open(O_WRONLY|O_CREAT|O_EXCL, 0o600),
//      a node watcher lstat()s every name in the directory as fast as it can; no regular file is ever
//      seen at any mode but 0600 (under umask 022, where the engine's own create is 0644).
//   3. A planted link: `wx` over a symlink to a victim is EEXIST and the victim is untouched; O_NOFOLLOW
//      over it is ELOOP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const helper = require('./node-shim-helper.cjs');

// LOADER may name another node-shim (the pre-fix one) to measure it: CLODE_SHIM_LOADER.
const LOADER = process.env.CLODE_SHIM_LOADER || helper.LOADER;

function runTjs(script, args) {
  const [cmd, argv] = helper.engineSpawn(['run', LOADER, script, ...args]);
  return new Promise((resolve) => {
    const c = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}
function runNode(script, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

async function withUmask(m, fn) {
  const old = process.umask(m);
  try { return await fn(); } finally { process.umask(old); }
}

const RACER = `
const fs = require('fs'), path = require('path');
const [dir, n, tag, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* every worker starts together */ }
const wins = [];
for (let i = 0; i < Number(n); i++) {
  const p = path.join(dir, 'lock-' + i);
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, tag);
    fs.closeSync(fd);
    wins.push(i);
  } catch (e) { if (e.code !== 'EEXIST') { console.log('ERR', e.code, e.message); process.exit(3); } }
}
fs.writeFileSync(path.join(dir, 'wins-' + tag), wins.join(','));
`;

const CREATOR = `
const fs = require('fs'), path = require('path');
const [dir, n] = process.argv.slice(2);
(async () => {
  const c = fs.constants;
  for (let i = 0; i < Number(n); i++) {
    const fh = await fs.promises.open(path.join(dir, 'f-' + i), c.O_WRONLY | c.O_CREAT | c.O_EXCL, 0o600);
    await fh.close();
  }
  fs.writeFileSync(path.join(dir, '.done'), '');
})();
`;

const WATCHER = `
const fs = require('fs'), path = require('path');
const [dir] = process.argv.slice(2);
const bad = new Map();
let looks = 0;
while (!fs.existsSync(path.join(dir, '.done'))) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const n of names) {
    if (!n.startsWith('f-')) continue;
    let st;
    try { st = fs.lstatSync(path.join(dir, n)); } catch { continue; }
    looks++;
    if (st.isFile() && (st.mode & 0o777) !== 0o600) bad.set(n, (st.mode & 0o777).toString(8));
  }
}
console.log(JSON.stringify({ looks, bad: [...bad].slice(0, 20), badCount: bad.size }));
`;

test('RACE: one winner per wx path, and the winner keeps its bytes', { timeout: 120000 }, async (t) => {
  if (helper.skipUnlessTjs(t)) return;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'excl-race-')));
  try {
    const script = path.join(dir, 'racer.cjs');
    fs.writeFileSync(script, RACER);
    const work = path.join(dir, 'w');
    fs.mkdirSync(work);
    const K = 4;
    const N = 400;
    const startAt = Date.now() + 2500;
    const rs = await Promise.all(Array.from({ length: K }, (_, k) => runTjs(script, [work, String(N), `w${k}`, String(startAt)])));
    rs.forEach((r, k) => assert.strictEqual(r.code, 0, `worker ${k}: ${r.out}`));
    const winners = new Map();
    for (let k = 0; k < K; k++) {
      const w = fs.readFileSync(path.join(work, `wins-w${k}`), 'utf8');
      for (const i of w ? w.split(',').map(Number) : []) (winners.get(i) || winners.set(i, []).get(i)).push(`w${k}`);
    }
    const double = [...winners].filter(([, ws]) => ws.length > 1);
    const none = Array.from({ length: N }, (_, i) => i).filter((i) => !winners.has(i));
    const lost = [...winners].filter(([i, ws]) => ws.length === 1 && fs.readFileSync(path.join(work, `lock-${i}`), 'utf8') !== ws[0]);
    t.diagnostic(`${K} workers x ${N} paths: ${double.length} paths with two winners, ${none.length} with none, ${lost.length} whose winner lost its bytes`);
    assert.deepStrictEqual({ double: double.length, none: none.length, lost: lost.length }, { double: 0, none: 0, lost: 0 },
      `an exclusive create was not exclusive: ${JSON.stringify(double.slice(0, 5))}`);
    const strays = fs.readdirSync(work).filter((n) => n.startsWith('.clode-'));
    assert.deepStrictEqual(strays, [], 'the private directories are tidied');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MODE WINDOW: an O_EXCL 0600 create is never seen at another mode', { timeout: 120000 }, async (t) => {
  if (helper.skipUnlessTjs(t)) return;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'excl-mode-')));
  try {
    const creator = path.join(dir, 'creator.cjs');
    const watcher = path.join(dir, 'watcher.cjs');
    fs.writeFileSync(creator, CREATOR);
    fs.writeFileSync(watcher, WATCHER);
    const work = path.join(dir, 'w');
    fs.mkdirSync(work);
    const M = 1500;
    const [c, w] = await withUmask(0o022, () => Promise.all([runTjs(creator, [work, String(M)]), runNode(watcher, [work])]));
    assert.strictEqual(c.code, 0, c.out);
    assert.strictEqual(w.code, 0, w.out);
    const seen = JSON.parse(w.out.trim().split('\n').pop());
    t.diagnostic(`${M} creates, ${seen.looks} looks by the watcher, ${seen.badCount} files seen at a mode other than 600: ${JSON.stringify(seen.bad)}`);
    assert.ok(seen.looks > 0, 'the watcher saw files (it raced the creator)');
    assert.strictEqual(seen.badCount, 0, `a 0600 file was visible at another mode: ${JSON.stringify(seen.bad)}`);
    const modes = new Set(fs.readdirSync(work).filter((n) => n.startsWith('f-')).map((n) => (fs.statSync(path.join(work, n)).mode & 0o777).toString(8)));
    assert.deepStrictEqual([...modes], ['600']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a planted link: wx is EEXIST and O_NOFOLLOW is ELOOP, and the victim is untouched', async (t) => {
  if (helper.skipUnlessTjs(t)) return;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'excl-link-')));
  try {
    const victim = path.join(dir, 'victim');
    fs.writeFileSync(victim, 'precious\n');
    fs.symlinkSync(victim, path.join(dir, 'planted'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'));
    const script = path.join(dir, 'planted.cjs');
    fs.writeFileSync(script, `
const fs = require('fs'), path = require('path'); const d = process.argv[2]; const c = fs.constants; const out = {};
const t = (k, f) => { try { const fd = f(); fs.closeSync(fd); out[k] = 'opened'; } catch (e) { out[k] = e.code; } };
t('wx', () => fs.openSync(path.join(d, 'planted'), 'wx'));
t('excl', () => fs.openSync(path.join(d, 'planted'), c.O_WRONLY | c.O_CREAT | c.O_EXCL, 0o600));
t('nofollow', () => fs.openSync(path.join(d, 'planted'), c.O_WRONLY | c.O_CREAT | c.O_APPEND | c.O_NOFOLLOW));
t('danglingwx', () => fs.openSync(path.join(d, 'dangling'), 'wx'));
console.log(JSON.stringify(out));`);
    const r = await runTjs(script, [dir]);
    const n = await runNode(script, [dir]);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(JSON.parse(r.out.trim()), JSON.parse(n.out.trim()), 'quaude answers as node');
    assert.deepStrictEqual(JSON.parse(r.out.trim()), { wx: 'EEXIST', excl: 'EEXIST', nofollow: 'ELOOP', danglingwx: 'EEXIST' });
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious\n');
    assert.ok(!fs.existsSync(path.join(dir, 'nowhere')), 'a dangling link was not created through');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
