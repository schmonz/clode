'use strict';
// The gate on test/posix-host.cjs — the module that owns the two POSIX facts a Windows
// checkout cannot answer.
//
// A shared skip predicate is the kind of thing that quietly grows: one more platform in
// the condition, one more file that uses it, and eighteen real tests become eighteen
// silent skips on a box where they would have run. So the predicate is pinned from BOTH
// ends here. Off win32 it must be FALSE — and the reason it is false must be true, which
// means actually spawning both of the spellings the skipped tests use. On win32 it must
// be a non-empty REASON, because a bare `true` in the TAP output tells the next reader
// nothing about whether the skip was honest.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { NO_POSIX_SH, committedExecBit, REPO } = require('./posix-host.cjs');

const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clode-posix-host-'));

test('off win32 the skip does NOT apply, and both spellings it excuses really work',
  { skip: process.platform === 'win32' && 'on Windows the skip IS the behaviour under test' },
  () => {
    assert.strictEqual(NO_POSIX_SH, false,
      'sh-driving tests are being skipped on a platform that is not win32. That is not a '
      + 'porting accommodation, it is the resolver and the build-tjs wrapper going '
      + 'untested — widen the RUNNER, never this condition.');
    // Spelling 1: `spawnSync('/bin/sh', [script, ...])` — test/bootstrap-engine.test.cjs.
    const viaShell = spawnSync('/bin/sh', ['-c', 'exit 7'], { encoding: 'utf8' });
    assert.strictEqual(viaShell.status, 7,
      'this box has no working /bin/sh, so every sh() call in the resolver tests compared '
      + 'against null rather than against an exit status');
    // Spelling 2: spawning an executable `#!/bin/sh` script BY ITS OWN PATH —
    // test/build-tjs-boot.test.cjs, which does it that way on purpose so the exec bit and
    // the shebang are exercised the way CI invokes them.
    const d = mkdtemp();
    const s = path.join(d, 'direct.sh');
    fs.writeFileSync(s, '#!/bin/sh\nexit 7\n');
    fs.chmodSync(s, 0o755);
    const direct = spawnSync(s, [], { encoding: 'utf8' });
    fs.rmSync(d, { recursive: true, force: true });
    assert.strictEqual(direct.status, 7,
      'this box cannot spawn an executable #!/bin/sh script by its own path, so the '
      + 'build-tjs wrapper tests compared against null rather than against an exit status');
  });

test('on win32 the skip STATES why, rather than being a bare true',
  { skip: process.platform !== 'win32' && 'there is no win32 predicate to read off a POSIX box' },
  () => {
    assert.strictEqual(typeof NO_POSIX_SH, 'string');
    assert.ok(NO_POSIX_SH.length > 40, 'a skip must say what it is giving up and why');
  });

// ---------------------------------------------------------------------------
// committedExecBit — the SHIPPED mode, not the checkout's.
// ---------------------------------------------------------------------------

// THE WINDOWS CONDITION, CONSTRUCTED. NTFS has no POSIX mode, so on win32 a checkout's
// `fs.statSync(f).mode & 0o111` is 0 for every file — including the two 100755 wrappers.
// That is reproduced EXACTLY here by clearing the worktree bit on a file that git records
// as 100755: a mode read answers "not executable", the index still answers "executable",
// and only the second one is a fact about what ships.
test('it reads the INDEX mode, so a checkout that cannot carry the bit still answers', () => {
  const d = fs.realpathSync(mkdtemp());
  const git = (args) => execFileSync('git', ['-C', d, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'user.name', 'test']);
  const exe = path.join(d, 'runme.sh');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(d, 'plain.txt'), 'x\n');
  git(['add', '-A']);
  // Belt and braces: on a core.fileMode=false checkout `git add` would have recorded
  // 100644 for both, which would make the assertions below pass for the wrong reason.
  git(['update-index', '--chmod=+x', 'runme.sh']);

  // Now do to the worktree exactly what a Windows checkout does: lose the bit.
  fs.chmodSync(exe, 0o644);
  assert.strictEqual(fs.statSync(exe).mode & 0o111, 0, 'precondition: the worktree bit is gone');

  // The index still says 100755, so committedExecBit still says true — which is the whole
  // claim. A `fs.statSync().mode` implementation answers false here, and answers false for
  // every file on a real Windows checkout for exactly the same reason.
  assert.strictEqual(committedExecBit('runme.sh', d), true);
  assert.strictEqual(committedExecBit('plain.txt', d), false);

  // And the same question asked of THIS repo, whose wrappers are the real subjects.
  assert.strictEqual(committedExecBit('scripts/bootstrap-engine.sh'), true);
  assert.strictEqual(committedExecBit('scripts/build-tjs-boot.sh'), true);
  assert.strictEqual(committedExecBit('package.json'), false,
    'a plain file must answer false, or the function is a constant dressed as a check');
  fs.rmSync(d, { recursive: true, force: true });
});

test('an untracked path is an ERROR, not a quiet false', () => {
  // A guard that asks about a path git does not know is asking about this box. Answering
  // `false` would turn a moved or renamed file into a plausible-looking VIOLATION about
  // the exec bit instead of naming the real problem.
  assert.throws(() => committedExecBit('scripts/this-file-does-not-exist.sh'),
    /not tracked by git/);
  assert.ok(fs.existsSync(path.join(REPO, 'scripts')), 'sanity: REPO points at the checkout');
});
