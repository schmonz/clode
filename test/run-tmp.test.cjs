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

test('CONTROL: a dead run\'s root whose pid the kernel reused for a LATER process is swept, never counted as a live run', async (t) => {
  const original = scratch(t);
  const pending = path.join(original, 'pending');
  fs.mkdirSync(pending);
  // the dead run's stamp: its pid's start then, a minute before the process now holding that pid
  const reused = liveChild(t);
  const root = path.join(original, `clode-run-${reused}-Rr00Rr`);
  fs.renameSync(pending, root);
  const now = RR.pidOwner(reused).started;
  assert.ok(typeof now === 'number', 'the process table reads the live child');
  fs.writeFileSync(path.join(root, RR.STAMP), JSON.stringify({ pid: reused, started: now - 60000 }));
  assert.strictEqual(RR.ownsRoot(root, reused), false);
  assert.deepStrictEqual(RR.overlapPids(path.join(original, 'no-log'), [original]), []);
  assert.deepStrictEqual(RR.removeStaleRoots([original]).map((r) => r.pid), [reused]);
  assert.strictEqual(fs.existsSync(root), false);
});

// THE CLOCK SKEW, MEASURED WHERE IT RUNS (every CI job that runs the suite prints this line): how far the process
// table's start time for a child sits from the wall clock at its spawn. 78bd732 said Linux ps can read up to ~2 s early
// (whole-second btime + jiffies, then truncated); this line is the measurement that claim waits on (BACKLOG.md).
test('MEASURE: ps start of a child minus the wall clock at its spawn (a diagnostic line; it judges nothing but that ps read it)', (t) => {
  if (process.platform === 'win32') { t.skip('the line is about ps; Windows reads CIM CreationDate, a FILETIME'); return; }
  const before = Date.now();
  const pid = liveChild(t);
  const after = Date.now();
  const started = RR.pidOwner(pid).started;
  assert.ok(typeof started === 'number', 'ps read the live child');
  const line = `run-tmp clock skew: ${process.platform} ps start - wall clock at spawn = ${started - before} ms (spawn took ${after - before} ms)`;
  t.diagnostic(line);
});

test('a stamped root is its run\'s while the pid\'s owner has the stamped start, whatever the filesystem says of the dir', (t) => {
  const original = scratch(t);
  const pid = liveChild(t);
  const root = path.join(original, `clode-run-${pid}-Ss00Ss`);
  fs.mkdirSync(root);
  RR.stampRoot(root, { pid });
  assert.strictEqual(RR.readStamp(root).pid, pid);
  assert.strictEqual(RR.ownsRoot(root, pid), true, 'the same process: kept');
  // LINUX'S CASE, on any box (CI ubuntu-latest on b3e9aaf): no birth time, and a ctime later than the owner's start
  const linuxStat = () => ({ birthtimeMs: 0, ctimeMs: Date.now() + 3600000 });
  const at = (started) => ({ alive: () => true, owner: () => ({ started, command: 'sleep 60' }), stat: linuxStat });
  assert.strictEqual(RR.ownsRoot(root, pid, at(RR.readStamp(root).started + 60000)), false, 'a later owner of the pid: swept despite the ctime');
  assert.strictEqual(RR.ownsRoot(root, pid, at(RR.readStamp(root).started)), true);
  // unstamped (made, not yet stamped) with no birth time: a doubt, kept; with a birth time, judged by it
  const bare = path.join(original, 'clode-run-1-Bb00Bb');
  fs.mkdirSync(bare);
  assert.strictEqual(RR.ownsRoot(bare, 1, at(Date.now() + 3600000)), true, 'no stamp, no birth time: kept');
  const darwinStat = () => ({ birthtimeMs: 1000, ctimeMs: 1000 });
  assert.strictEqual(RR.ownsRoot(bare, 1, { ...at(5000), stat: darwinStat }), false, 'no stamp, born before the owner started: swept');
  // WINDOWS'S CASE (CI windows-latest on 70469355): the owner's start reads just after the root's coarser birth time
  assert.strictEqual(RR.ownsRoot(bare, 1, { ...at(1000 + RR.SAME_START_MS), stat: darwinStat }), true, 'no stamp, owner start within the clock tolerance of the birth: kept');
  assert.strictEqual(RR.ownsRoot(bare, 1, { ...at(1001 + RR.SAME_START_MS), stat: darwinStat }), false, 'just past the tolerance: swept');
});

test('a pid running node test/run.mjs owns a root whatever its start time; anything else started later does not', (t) => {
  const root = scratch(t);
  const later = Date.now() + 3600000;
  const born = { birthtimeMs: Date.now(), ctimeMs: Date.now() }; // a birth time, so the row holds where the fs keeps none
  const owns = (command, started = later) => RR.ownsRoot(root, 1, { alive: () => true, owner: () => ({ started, command }), stat: () => born });
  assert.strictEqual(owns('/opt/node/bin/node /src/clode/test/run.mjs --offline'), true);
  assert.strictEqual(owns('C:\\node\\node.exe D:\\a\\clode\\test\\run.mjs'), true);
  assert.strictEqual(owns('sleep 60'), false);
  assert.strictEqual(owns('sleep 60', 0), true);
  assert.strictEqual(RR.ownsRoot(root, 1, { alive: () => false, owner: () => ({ started: 0, command: 'node test/run.mjs' }) }), false);
});

test('a live pid whose owner cannot be read (ps empty, PowerShell failing or timing out) counts as live: its root is never swept', (t) => {
  const original = scratch(t);
  const root = path.join(original, 'clode-run-424242-Dd00Dd');
  fs.mkdirSync(root);
  const unread = () => ({ started: null, command: null });
  assert.strictEqual(RR.ownsRoot(root, 424242, { alive: () => true, owner: unread }), true);
  assert.deepStrictEqual(RR.removeStaleRoots([original], { alive: () => true, owner: unread }), []);
  assert.ok(fs.existsSync(root), 'the live run keeps its root');
  // CONTROL: the same root with its pid dead is swept
  assert.deepStrictEqual(RR.removeStaleRoots([original], { alive: () => false, owner: unread }).map((r) => r.pid), [424242]);
});

test('the watcher reads each pid\'s owner once (on Windows that is a PowerShell per root per second otherwise)', () => {
  let calls = 0;
  const owner = RR.cachedOwner((pid) => { calls++; return { started: pid, command: null }; });
  for (let i = 0; i < 5; i++) { owner(7); owner(8); }
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(owner(7), { started: 7, command: null });
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

test('Windows never offers /tmp (node would resolve it to <drive>:\\tmp, which nothing there provides); a runner\'s RUNNER_TEMP is offered everywhere', () => {
  assert.deepStrictEqual(RT.rootCandidates('C:\\T', 'win32', {}), ['C:\\T']);
  assert.deepStrictEqual(RT.rootCandidates('C:\\T', 'win32', { RUNNER_TEMP: 'D:\\a\\_temp' }), ['C:\\T', 'D:\\a\\_temp']);
  assert.deepStrictEqual(RT.rootCandidates('C:\\T', 'win32', { RUNNER_TEMP: 'D:\\a\\_temp', CLODE_TEST_TMP_PARENT: 'E:\\t' }),
    ['C:\\T', 'E:\\t', 'D:\\a\\_temp'], 'the operator\'s parent comes before the runner\'s');
  assert.deepStrictEqual(RT.rootCandidates('/var/T', 'darwin', {}), ['/var/T', '/tmp']);
});

// THE 8.3 ALIAS (CI windows-latest on 26149c8): the runner's TEMP is C:\Users\RUNNER~1\AppData\Local\Temp, the real
// home C:\Users\runneradmin. A textual prefix test called the suite home made there NOT inside the home; by native real
// path, which is what GetFinalPathNameByHandle gives on Windows (here a fake that knows the one alias), it is.
const WIN_REAL = (p) => p.replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, 'C:\\Users\\runneradmin');
const WIN_HOME = 'C:\\Users\\runneradmin';
const WIN_SUITE_HOME = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clode-run-1-abcdef\\clode-test-home-ghijkl';
test('an 8.3 short name and the long name it aliases compare as contained, both sides by native real path', () => {
  assert.ok(!WIN_SUITE_HOME.startsWith(WIN_HOME + '\\'), 'CONTROL: the textual prefix test the check used misses it');
  assert.ok(RT.isInside(WIN_SUITE_HOME, WIN_HOME, { platform: 'win32', real: WIN_REAL }));
  assert.ok(RT.isInside(WIN_HOME.toUpperCase() + '\\x', WIN_HOME, { platform: 'win32', real: WIN_REAL }), 'Windows compares without case');
  assert.ok(!RT.isInside('D:\\a\\_temp\\clode-run-1-abcdef', WIN_HOME, { platform: 'win32', real: WIN_REAL }));
  assert.ok(!RT.isInside('C:\\Users\\runneradminX', WIN_HOME, { platform: 'win32', real: WIN_REAL }), 'a sibling sharing the prefix');
  assert.ok(!RT.isInside('/Users/A/x', '/Users/a', { platform: 'darwin', real: (p) => p }), 'POSIX keeps case');
});

test('the root goes outside the real home when a candidate is: a Windows TEMP is inside it, RUNNER_TEMP is not', (t) => {
  const home = scratch(t);
  const inHome = path.join(home, 'AppData', 'Local', 'Temp');
  fs.mkdirSync(inHome, { recursive: true });
  const outside = path.join(scratch(t), 'a-longer-runner-temp-directory');
  fs.mkdirSync(outside);
  assert.strictEqual(RT.rootParent(inHome, { candidates: [inHome, outside], home }), fs.realpathSync.native(outside));
  assert.strictEqual(RT.rootParent(inHome, { candidates: [inHome, outside] }), fs.realpathSync.native(inHome), 'CONTROL: with no home, the shorter');
  assert.strictEqual(RT.rootParent(inHome, { candidates: [inHome], home }), fs.realpathSync.native(inHome), 'with nothing outside, still a root');
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
