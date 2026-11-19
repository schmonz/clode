// A STALE ENGINE, simulated: the engine the last release (v0.20260831.1) shipped, as HEAD's code
// sees it. Prepended as TEXT to a program that a real, current tjs then runs, so it must be plain
// statements with no require and no module syntax.
//
// The shape is MEASURED, not imagined: on the pinned release's macos-arm64 slice,
// `__tjs_fs_sync.stat("/etc/hosts")` answers exactly
//   {"size":466,"mode":33188,"uid":0,"gid":0,"mtimeMs":1785163703000,"kind":"file"}
// -- no dev, ino, nlink, rdev, blksize, blocks, size64 or seconds+nanoseconds times (that engine
// predates txiki-sync-stat-identity.patch), and `__tjs_fs_sync.strerror` is absent (it predates
// txiki-strerror.patch). Everything else the floor names (spawn_sync, moduleMeta) it HAS.
(() => {
  const real = globalThis.__tjs_fs_sync;
  const old = (f) => (...a) => {
    const r = f.apply(real, a);
    return { size: Number(r.size64 !== undefined ? r.size64 : r.size), mode: r.mode, uid: r.uid, gid: r.gid,
      mtimeMs: Number(r.mtimeSec) * 1000, kind: r.kind };
  };
  globalThis.__tjs_fs_sync = Object.create(real, {
    stat: { value: old(real.stat), writable: true },
    lstat: { value: old(real.lstat), writable: true },
    fstat: { value: old(real.fstat), writable: true },
    strerror: { value: undefined, writable: true },
  });
})();
