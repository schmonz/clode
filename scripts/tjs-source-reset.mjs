import { execFileSync } from 'node:child_process';

// Reset a git checkout (and its submodules) to a pristine copy of its pinned
// HEAD: revert every tracked edit and remove untracked files, but PRESERVE the
// given keep-paths.
//
// Why this exists: build-tjs applies its patch stack (applyPatches) by mutating
// the working tree in place, with no rollback and — by deliberate design — no
// reverse-check (a patch that doesn't apply is a real error, so it must meet
// pristine source). A killed or failed prior build therefore leaves the tree
// PARTIALLY patched: tracked files edited, new patch-created files present
// (src/mod_*.c, deps/wurl/*). The next build's applyPatches then dies on
// "patch does not apply" / "already exists in working directory", and the
// shared vendored checkout stays poisoned for every later build. Running this
// before applyPatches makes each build — and each retry after a failure —
// start from clean source: the reentrancy guarantee.
//
// keep defaults to ['node_modules'] because upstream txiki.js does NOT gitignore
// the esbuild install the build drops there for the JS-bundle regen; a blanket
// clean would nuke it and force a reinstall every build. Everything else
// untracked (patch-created deps/wurl, new src/ modules, ._ AppleDouble turds on
// NFS) is swept. Submodules carry their own working-tree patches (the
// libuv/quickjs-ng fixups) and no keep-paths of their own, so they reset with a
// plain clean.
export function resetCheckoutToPristine(dir, { run, keep = ['node_modules'], platform = process.platform } = {}) {
  const exec = run || ((cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' }));
  exec('git', ['-C', dir, 'checkout', '--', '.']);
  // Sweep macOS AppleDouble ._* sidecars BEFORE the clean. On the NFS dev mount
  // these accumulate and go stale, and `git clean` exits non-zero mid-sweep when
  // it can't lstat one ("could not lstat deps/.../._x") — poisoning the reset.
  // find+rm tolerates the broken entries (rm -f unlinks, never lstat-fails); a
  // single find at the root covers the parent tree, every submodule working
  // tree, and .git. Best-effort and Unix-only: Windows never grows these turds
  // and lacks this find/rm, and on a clean filesystem (CI) it's a fast no-op.
  if (platform !== 'win32') {
    try { exec('find', [dir, '-name', '._*', '-exec', 'rm', '-f', '{}', '+']); }
    catch { /* the git clean below is the real gate; don't fail on the sweep */ }
  }
  const keepArgs = keep.flatMap((p) => ['-e', p]);
  exec('git', ['-C', dir, 'clean', '-fd', ...keepArgs]);
  exec('git', ['-C', dir, 'submodule', 'foreach', '--recursive',
    'git checkout -- . && git clean -fd']);
}
