'use strict';
// test/run-tmp.cjs: the per-run temp root, its removal, and the judged check on the original temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const RT = require('./run-tmp.cjs');
const RR = require('./run-tmp-runs.cjs');

const REPO = path.resolve(__dirname, '..');

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tmp-'));
  t.after(() => { RT.openUp(d); fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}

// a live pid that is not this process (a sleeping child), and a dead one (a child that has exited)
function liveChild(t) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } });
  return c.pid;
}
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}
const PLANT_PREFIXES = ['clode-', 'clode-planted-leak-'];

test('CONTROL: a leak planted with no other run live is a named not ok, with its prefix and count, and fails', (t) => {
  const original = scratch(t);
  fs.writeFileSync(path.join(original, 'clode-planted-leak-old123'), '');
  const before = RT.snapshot(original);
  fs.writeFileSync(path.join(original, 'clode-planted-leak-Ab12Cd'), '');
  fs.mkdirSync(path.join(original, 'clode-planted-leak-Ef34Gh'));
  const found = RT.leaks(before, RT.snapshot(original), { prefixes: PLANT_PREFIXES });
  assert.deepStrictEqual(found.map((g) => [g.prefix, g.count]), [['clode-planted-leak-', 2]]);
  const overlaps = RR.overlapPids(path.join(original, 'no-log'), [original]);
  assert.deepStrictEqual(overlaps, []);
  const v = RT.leakVerdict(found, original, overlaps);
  assert.strictEqual(v.fail, true);
  assert.strictEqual(v.lines.length, 1);
  assert.match(v.lines[0], /^not ok - the suite left 2 entries named clode-planted-leak-\* in /);
});

test('CONTROL: the same leak while another LIVE run\'s root is present is an UNATTRIBUTABLE warning naming its pid, not a failure', (t) => {
  const original = scratch(t);
  const before = RT.snapshot(original);
  const other = liveChild(t);
  fs.mkdirSync(path.join(original, `clode-run-${other}-Zz99Yy`));
  fs.writeFileSync(path.join(original, 'clode-planted-leak-Ab12Cd'), '');
  const found = RT.leaks(before, RT.snapshot(original), { prefixes: PLANT_PREFIXES });
  const overlaps = RR.overlapPids(path.join(original, 'no-log'), [original]);
  assert.deepStrictEqual(overlaps, [other]);
  const v = RT.leakVerdict(found, original, overlaps);
  assert.strictEqual(v.fail, false);
  assert.deepStrictEqual(v.lines.length, 1);
  assert.match(v.lines[0], new RegExp(`^warning - UNATTRIBUTABLE: 1 entry named clode-planted-leak-\\* .*\\(pid ${other}\\)`));
});

test('the overlap watcher records a live run that came and went, which a last sample alone would miss', async (t) => {
  const original = scratch(t);
  const log = path.join(original, 'overlaps');
  const other = liveChild(t);
  const w = RR.startOverlapWatch(log, [original]);
  t.after(() => { try { w.kill(); } catch { /* gone */ } });
  const root = path.join(original, `clode-run-${other}-Qq11Ww`);
  fs.mkdirSync(root);
  for (let i = 0; i < 50 && !(fs.existsSync(log) && fs.statSync(log).size > 0); i++) await new Promise((r) => setTimeout(r, 100));
  fs.rmdirSync(root);
  assert.deepStrictEqual(RR.overlapPids(log, [original]), [other]);
});

test('a killed run\'s root (dead pid) is removed, chmod 0 inside and all; a live run\'s and this run\'s are left', { skip: process.platform === 'win32' ? 'mode 0 does not stop removal on Windows' : false }, (t) => {
  const original = scratch(t);
  const dead = path.join(original, `clode-run-${deadPid()}-Dd00Dd`);
  fs.mkdirSync(path.join(dead, 'shut'), { recursive: true });
  fs.chmodSync(path.join(dead, 'shut'), 0);
  const live = path.join(original, `clode-run-${liveChild(t)}-Ll00Ll`);
  const mine = path.join(original, `clode-run-${process.pid}-Mm00Mm`);
  fs.mkdirSync(live);
  fs.mkdirSync(mine);
  const removed = RR.removeStaleRoots([original]);
  assert.deepStrictEqual(removed.map((r) => [path.basename(r.path), !!r.error]), [[path.basename(dead), false]]);
  assert.deepStrictEqual([fs.existsSync(dead), fs.existsSync(live), fs.existsSync(mine)], [false, true, true]);
});

test('only <prefix of 5+ characters><generated suffix> is judged: short generic prefixes and other shapes are anyone\'s', (t) => {
  const original = scratch(t);
  const before = RT.snapshot(original);
  for (const name of ['work-Ab12Cd', 'cfg-123456', 'clode-planted-leak-not-generated', 'clode-planted-leak-', 'com.apple.someone-else',
    'clode-planted-leak-4242.tap']) fs.writeFileSync(path.join(original, name), '');
  const found = RT.leaks(before, RT.snapshot(original), { prefixes: [...PLANT_PREFIXES, 'work-', 'cfg-'] });
  assert.deepStrictEqual(found.map((g) => [g.prefix, g.count, g.example]), [['clode-planted-leak-', 1, 'clode-planted-leak-4242.tap']]);
});

test('an ignored name and the STABLE dirs are not leaks; their sizes make one verdict line', (t) => {
  const original = scratch(t);
  const before = RT.snapshot(original);
  for (const name of ['clode-planted-leak-Ab12Cd', ...Object.keys(RT.STABLE)]) fs.mkdirSync(path.join(original, name));
  fs.writeFileSync(path.join(original, 'harness', 'f'), Buffer.alloc(3 * 1048576));
  assert.deepStrictEqual(RT.leaks(before, RT.snapshot(original), { prefixes: PLANT_PREFIXES, ignore: ['clode-planted-leak-Ab12Cd'] }), []);
  const line = RT.stableLine(RT.stableSizes(original), original);
  assert.match(line, /^run: durable scratch kept in .*: .*harness 3 MB.* \(total 3 MB; kept on purpose/);
});

test('repoPrefixes derives the temp-name prefixes this repo spells, and nothing it does not', () => {
  const p = RT.repoPrefixes(REPO);
  for (const known of ['clode-bootstrap-', 'shim-diff-', 'clode-test-state-', 'depscan-fx-', 'clode-test-run-', 'run-tmp-']) {
    assert.ok(p.includes(known), `${known} missing from ${p.length} derived prefixes`);
  }
  assert.ok(!p.some((x) => x.startsWith('com.apple')), 'a macOS daemon name is not ours');
});

test('makeRunRoot points TMPDIR, TMP and TEMP at a clode-run- dir, and the durable-scratch variables at the original', (t) => {
  const original = scratch(t);
  const env = { CLODE_BUILD_SCRATCH: '/operator/set/this' };
  const root = RT.makeRunRoot(original, env, { candidates: [original] });
  assert.strictEqual(path.dirname(root), fs.realpathSync.native(original));
  assert.match(path.basename(root), new RegExp(`^clode-run-${process.pid}-[A-Za-z0-9]{6}$`));
  assert.deepStrictEqual([env.TMPDIR, env.TMP, env.TEMP, env[RT.ROOT_ENV]], [root, root, root, root]);
  assert.deepStrictEqual([env[RT.ORIGINAL_ENV], env.CLODE_TJS_LOCAL_ROOT, env.CLODE_BUILD_SCRATCH],
    [original, original, '/operator/set/this']);
});

test('Windows offers only the original temp dir: node would resolve /tmp to <drive>:\\tmp, which nothing there provides', () => {
  assert.deepStrictEqual(RT.rootCandidates('C:\\T', 'win32'), ['C:\\T']);
  assert.deepStrictEqual(RT.rootCandidates('/var/T', 'darwin'), ['/var/T', '/tmp']);
});

test('the root goes under the shorter writable candidate, never a missing one', (t) => {
  const long = path.join(scratch(t), 'a-rather-long-directory-name');
  fs.mkdirSync(long);
  const short = scratch(t);
  assert.strictEqual(RT.rootParent(long, { candidates: [long, short] }), fs.realpathSync.native(short));
  assert.strictEqual(RT.rootParent(long, { candidates: [long, path.join(short, 'absent')] }), fs.realpathSync.native(long));
});

test('removeRunRoot removes a root holding a chmod 0 directory, which a plain recursive rm cannot', { skip: process.platform === 'win32' || process.getuid() === 0 ? 'mode 0 does not stop this user (Windows, or root)' : false }, (t) => {
  const make = () => {
    const original = scratch(t);
    const root = RT.makeRunRoot(original, {}, { candidates: [original] });
    const shut = path.join(RT.makeFileDir(root, 'x/shim-diff.test.cjs'), 'case');
    fs.mkdirSync(shut);
    fs.writeFileSync(path.join(shut, 'f'), '');
    fs.chmodSync(shut, 0);
    return root;
  };
  // control: the plain removal refuses (macOS says ENOTEMPTY, Linux EACCES)
  const plain = make();
  assert.throws(() => fs.rmSync(plain, { recursive: true, force: true }), /EACCES|EPERM|ENOTEMPTY/);
  const root = make();
  RT.removeRunRoot(root);
  assert.strictEqual(fs.existsSync(root), false);
});

test('under test/run.mjs this file\'s os.tmpdir() is its own dir under the per-run root', {
  skip: process.env[RT.ROOT_ENV] ? false : `not run by test/run.mjs (no ${RT.ROOT_ENV})`,
}, () => {
  const mine = os.tmpdir();
  assert.strictEqual(path.dirname(mine), process.env[RT.ROOT_ENV]);
  assert.ok(path.basename(mine).startsWith('run-tmp-'), mine);
  assert.deepStrictEqual([process.env.TMP, process.env.TEMP], [mine, mine]);
});
