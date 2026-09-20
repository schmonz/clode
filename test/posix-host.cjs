'use strict';
// posix-host.cjs — the two POSIX facts a Windows checkout CANNOT answer, in ONE place.
//
// WHY THIS MODULE EXISTS. Five consecutive rounds of Windows-only CI reds in this repo
// have been POSIX assumptions in TEST code, and the last two rounds were the SAME two
// assumptions arriving in a second file each time:
//
//   1. "there is a POSIX shell at a path this process can spawn". There is not. libuv
//      hands an absolute path straight to CreateProcess, which resolves `/bin/sh` as
//      `<drive>:\bin\sh` and returns ENOENT; a `#!/bin/sh` script spawned by its own
//      path is not an executable image at all. Either way spawnSync answers
//      `status: null`, and every exit-code comparison in the file fails on `null !== 0`.
//      Round 4 hit test/bootstrap-engine.test.cjs; round 5 hit the nine behavioural
//      cases in test/build-tjs-boot.test.cjs (CI run 35521083887, tests 216-224).
//
//   2. "the exec bit is in the file's mode". It is not: NTFS has no POSIX mode, so
//      `fs.statSync(f).mode & 0o111` is 0 for EVERY file on win32 — already written
//      down at test/clode-templates.test.cjs:60, and still read straight out of the
//      filesystem by two structural guards, which is how `bootstrap-resolver-shape`
//      and `build-tjs-invocation-shape` reported a VIOLATION on Windows (same run,
//      tests 90 and 226) over files that are 100755 in the index.
//
// A second copy of either predicate is how this keeps happening, so there is one copy,
// here, and test/posix-host.test.cjs is the gate that keeps it from spreading.
//
// NOTE FOR THE FORCED-WIN32 PASS (test/forced-win32.cjs): this module names
// child_process, so every test file that requires it is EXCLUDED from that pass's
// derived set. Both current requirers already spawn and were already out; a future
// requirer that does not spawn would be silently dropped from the forced set, which is
// the trade this module's single-copy rule is worth — but it is the reason to keep the
// module small rather than to let it become a general test-helper dumping ground.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

// FALSE on every POSIX box, and a non-empty REASON string on win32 — the shape
// node:test's `{ skip }` wants, so the reason travels into the TAP output instead of a
// bare `true` that says nothing to whoever reads a skipped run.
//
// Skipping is the honest verdict here, not a dodge. scripts/bootstrap-engine.sh and
// scripts/build-tjs-boot.sh are POSIX sh ON PURPOSE — they run in alpine containers and
// in minimal VM guests where bash may be absent — and NO Windows leg goes through
// either one: the msvc legs in .github/actions/build-leg/action.yml run
// `node scripts/build-tjs.cjs --build-only` natively, while the resolver and the
// wrapper serve the alpine and qemu legs. The ubuntu and darwin rows of the suite
// matrix run every one of these for real on every push, and the STRUCTURAL rules — the
// guards, which READ those files rather than execute them — still run on Windows too.
const NO_POSIX_SH = process.platform === 'win32'
  && 'windows: this case drives a POSIX `#!/bin/sh` script by spawning it, and there is '
  + 'no shell this runner can reach by an absolute POSIX path (CreateProcess resolves '
  + '/bin/sh as <drive>:\\bin\\sh, and a shebang script is not an executable image), so '
  + 'every exit status comes back null. No Windows leg runs the resolver or the '
  + 'build-tjs wrapper — the msvc legs build tjs natively; the ubuntu and darwin rows of '
  + 'the suite matrix cover these, and the structural guards still run here.';

// Sugar, so the reason is written ONCE and a NEW sh-driving case gets it by using
// shTest instead of having to remember a per-case skip option.
const shTest = (name, fn) => require('node:test').test(name, { skip: NO_POSIX_SH }, fn);

// The exec bit AS SHIPPED — git's index mode, not the checkout's.
//
// This is the bit that matters and the only one that is answerable everywhere: it is
// what `git checkout` writes onto the alpine container and the VM guest, it survives a
// filesystem that has no mode bits, and it is what a reviewer changes deliberately
// (`git update-index --chmod=+x`). Reading the WORKTREE mode instead was wrong in two
// directions at once: it reported a false VIOLATION on Windows, and on POSIX a stray
// local `chmod +x` that was never committed would have made the guard green over a file
// that ships non-executable.
// `root` exists so the function can be exercised against a FIXTURE repo whose worktree
// bit has been cleared — the Windows condition, constructed. It is not a knob for
// callers: every real caller asks about this checkout.
function committedExecBit(repoRelPath, root = REPO) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-s', '--', repoRelPath],
    { encoding: 'utf8' });
  const line = out.split('\n').filter(Boolean)[0];
  if (!line) {
    throw new Error(`committedExecBit: ${repoRelPath} is not tracked by git, so there is `
      + 'no shipped mode to read. A guard asking about an untracked path is asking about '
      + 'this box, not about what ships.');
  }
  const mode = line.slice(0, line.indexOf(' '));
  if (mode !== '100644' && mode !== '100755') {
    throw new Error(`committedExecBit: ${repoRelPath} has index mode ${mode}, which is `
      + 'neither a plain file nor an executable file');
  }
  return mode === '100755';
}

module.exports = { NO_POSIX_SH, shTest, committedExecBit, REPO };
