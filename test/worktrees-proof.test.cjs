'use strict';
// worktrees-proof.test.cjs — the proof behind run.mjs's .claude/worktrees exclusion
// (test/worktrees-proof.cjs). The exclusion hides a directory from the whole-checkout tree
// gate, so the proof is what stands between "another agent's worktree" and "something this
// suite wrote into the checkout".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { proveWorktrees, proveWorktreesOnDisk, compareRuns } = require('./worktrees-proof.cjs');

// POSIX-shaped rows spell paths with path.posix, Windows-shaped rows with path.win32, whatever the host. Before CI
// 44460009323 the rows used node:path, so on windows-latest path.join made the POSIX fixtures' entry paths
// backslashed, the fake had no such entry, and every row read "gone between readdir and lstat": a fixture fault.
const P = path.posix;
const W = path.win32;
const ROOT = '/repo';
const DIR = '/repo/.claude/worktrees';
const dirStat = { isSymbolicLink: () => false, isDirectory: () => true };
const linkStat = { isSymbolicLink: () => true, isDirectory: () => false };
// A fake filesystem: path -> { stat, real } (absent paths throw, as fs does).
function fake(entries, porcelain) {
  const get = (p) => { if (!entries[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return entries[p]; };
  return {
    dir: DIR, root: ROOT, porcelain, pathApi: P,
    names: Object.keys(entries).filter((p) => P.dirname(p) === DIR).map((p) => P.basename(p)),
    lstat: (p) => get(p).stat,
    realpath: (p) => (p === ROOT ? ROOT : get(p).real),
  };
}
const PORCELAIN = `worktree ${ROOT}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${DIR}/a\nHEAD 2\nbranch refs/heads/x\n\n`;
const GOOD = { [`${DIR}/a`]: { stat: dirStat, real: `${DIR}/a` }, [`${DIR}/._a`]: { stat: dirStat, real: `${DIR}/._a` } };

test('registered worktrees and their AppleDouble sidecars prove the exclusion', () => {
  const r = proveWorktrees(fake(GOOD, PORCELAIN));
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.proven, true);
  assert.deepStrictEqual(r.names, ['._a', 'a']);
});

test('CONTROL: a directory git does not register (what a test would create) is not proven', () => {
  const r = proveWorktrees(fake({ ...GOOD, [`${DIR}/stray`]: { stat: dirStat, real: `${DIR}/stray` } }, PORCELAIN));
  assert.strictEqual(r.proven, false);
  assert.deepStrictEqual(r.findings, ['stray: not a worktree git registers for this repository']);
});

test('a symlink, even one to a registered worktree or to the checkout, is not proven', () => {
  const toRoot = proveWorktrees(fake({ ...GOOD, [`${DIR}/up`]: { stat: linkStat, real: ROOT } }, PORCELAIN));
  assert.strictEqual(toRoot.proven, false);
  assert.match(toRoot.findings[0], /^up: a symlink/);
  const toA = proveWorktrees(fake({ ...GOOD, [`${DIR}/alias`]: { stat: linkStat, real: `${DIR}/a` } }, PORCELAIN));
  assert.strictEqual(toA.proven, false);
});

test('the checkout itself is never a proof: a directory that resolves to ROOT fails', () => {
  // ROOT is always the first `worktree` line of the porcelain; it must not count.
  const r = proveWorktrees(fake({ ...GOOD, [`${DIR}/bind`]: { stat: dirStat, real: ROOT } }, PORCELAIN));
  assert.strictEqual(r.proven, false);
  assert.deepStrictEqual(r.findings, ['bind: resolves to the checkout itself']);
});

test('a prunable worktree whose directory is gone is named, proves nothing, and does not throw', () => {
  const porcelain = `${PORCELAIN}worktree /elsewhere/gone\nHEAD 3\nbranch refs/heads/y\nprunable gitdir file points to non-existent location\n\n`;
  const r = proveWorktrees(fake(GOOD, porcelain));
  assert.strictEqual(r.proven, true, 'the other entries still prove themselves');
  assert.deepStrictEqual(r.notes, ['registered worktree /elsewhere/gone has no directory (prunable); it proves nothing']);
  // ... and an entry that NEEDED it fails, for that entry only.
  const gone = `worktree ${ROOT}\n\nworktree ${DIR}/a\nprunable gitdir file points to non-existent location\n\n`;
  const r2 = proveWorktrees(fake({ [`${DIR}/b`]: { stat: dirStat, real: `${DIR}/b` } }, gone));
  assert.deepStrictEqual(r2.findings, ['b: not a worktree git registers for this repository']);
});

// WINDOWS-SHAPED ROWS. What windows-latest really hands the proof: the checkout reached through an 8.3 short name
// (os.tmpdir() is C:\Users\RUNNER~1\AppData\Local\Temp on a GitHub runner), and `git worktree list --porcelain`
// printing the LONG name, with forward slashes and git's drive-letter case. `nativeRealpath` models
// fs.realpathSync.native there (GetFinalPathNameByHandle): one canonical spelling for every spelling of a directory.
// `jsRealpath` models fs.realpathSync, which resolves links but keeps the name it was given: the CONTROL.
const WROOT_SHORT = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wt-proof-x';
const WROOT = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\wt-proof-x';
const WDIR = W.join(WROOT_SHORT, '.claude', 'worktrees');
function winFake(realpathImpl) {
  const canonical = new Map([WROOT, W.join(WROOT, '.claude', 'worktrees', 'agent-1')].map((p) => [p.toLowerCase(), p]));
  const spell = (p) => W.normalize(p).replace(/RUNNER~1/i, 'runneradmin').toLowerCase();
  const nativeRealpath = (p) => { const c = canonical.get(spell(p)); if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return c; };
  const jsRealpath = (p) => { nativeRealpath(p); return W.normalize(p); };
  const realpath = realpathImpl === 'js' ? jsRealpath : nativeRealpath;
  return {
    dir: WDIR, names: ['agent-1'], pathApi: W,
    lstat: (p) => { nativeRealpath(p); return dirStat; },
    realpath,
    root: realpath(WROOT_SHORT),
    porcelain: 'worktree C:/Users/runneradmin/AppData/Local/Temp/wt-proof-x\r\nHEAD 1\r\nbranch refs/heads/main\r\n\r\n'
      + 'worktree c:/Users/runneradmin/AppData/Local/Temp/wt-proof-x/.claude/worktrees/agent-1\r\nHEAD 2\r\n\r\n',
  };
}
test('Windows-shaped: an 8.3-named checkout and git\'s long, forward-slashed porcelain prove through a canonical realpath', () => {
  const r = proveWorktrees(winFake('native'));
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.proven, true);
});
test('CONTROL, Windows-shaped: a realpath that keeps the 8.3 name (fs.realpathSync) cannot match git\'s spelling', () => {
  assert.deepStrictEqual(proveWorktrees(winFake('js')).findings,
    ['agent-1: not a worktree git registers for this repository']);
});
test('the on-disk proof canonicalizes with fs.realpathSync.native, never the JS walk', () => {
  const src = fs.readFileSync(path.join(__dirname, 'worktrees-proof.cjs'), 'utf8');
  const onDisk = src.slice(src.indexOf('function proveWorktreesOnDisk'), src.indexOf('function compareRuns'));
  assert.match(onDisk, /fs\.realpathSync\.native\(/);
  assert.doesNotMatch(onDisk, /fs\.realpathSync\(/);
});

test('an empty directory proves nothing (no blanket exclusion of an empty dir)', () => {
  assert.strictEqual(proveWorktrees(fake({}, PORCELAIN)).proven, false);
});

test('compareRuns: a name created or deleted during the suite, or a proof lost after it, is a finding', () => {
  const before = { names: ['._a', 'a'], findings: [] };
  assert.deepStrictEqual(compareRuns(before, { names: ['._a', 'a'], findings: [] }), []);
  // CONTROL for the after-check: EnterWorktree run by a test makes .claude/worktrees/<name>.
  assert.deepStrictEqual(compareRuns(before, { names: ['._a', 'a', 'made-by-test'], findings: [] }),
    ['created during the suite: .claude/worktrees/made-by-test']);
  assert.deepStrictEqual(compareRuns(before, { names: ['a'], findings: [] }),
    ['deleted during the suite: .claude/worktrees/._a']);
  assert.deepStrictEqual(compareRuns(before, { names: ['._a', 'a'], findings: ['x: a symlink, not a worktree directory'] }),
    ['after the suite: x: a symlink, not a worktree directory']);
});

test('on disk: a real `git worktree add` proves; a symlink to the checkout and a stray dir do not', (t) => {
  let git;
  try { git = execFileSync('git', ['--version'], { encoding: 'utf8' }); } catch { git = null; }
  if (!git) { t.skip('no git on PATH'); return; }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-proof-')));
  try {
    const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, stdio: 'pipe' });
    g('init', '-q'); fs.writeFileSync(path.join(root, 'f'), 'x'); g('add', 'f'); g('commit', '-q', '-m', 'x');
    g('worktree', 'add', '-q', path.join('.claude', 'worktrees', 'agent-1'));
    assert.deepStrictEqual(proveWorktreesOnDisk(root).findings, []);
    const wt = path.join(root, '.claude', 'worktrees');
    // 'junction': on Windows the directory link any unprivileged process can make (a 'dir' symlink needs
    // SeCreateSymbolicLinkPrivilege or Developer Mode), so the link a stray test would really leave there; node's
    // lstat reports a junction as a symbolic link. Off Windows the type argument is ignored: a plain symlink.
    fs.symlinkSync(root, path.join(wt, 'up'), 'junction');
    assert.deepStrictEqual(proveWorktreesOnDisk(root).findings, ['up: a symlink, not a worktree directory']);
    fs.unlinkSync(path.join(wt, 'up'));
    // A registered worktree outside the dir whose directory is then deleted: prunable, named, not fatal.
    g('worktree', 'add', '-q', path.join(root, '..', `${path.basename(root)}-gone`));
    fs.rmSync(path.join(root, '..', `${path.basename(root)}-gone`), { recursive: true, force: true });
    const r = proveWorktreesOnDisk(root);
    assert.strictEqual(r.proven, true);
    assert.match(r.notes.join('\n'), /-gone has no directory \(prunable\)/);
    fs.mkdirSync(path.join(wt, 'stray'));
    assert.deepStrictEqual(proveWorktreesOnDisk(root).findings, ['stray: not a worktree git registers for this repository']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
