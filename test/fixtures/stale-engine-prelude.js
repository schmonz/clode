// A STALE ENGINE, simulated: the engine the last release (v0.20260831.1) shipped, as HEAD's code
// sees it. Prepended as TEXT to a program that a real, current tjs then runs (and inserted after
// line 1 of a copy of node-shim's loader by test/stale-build-host.cjs), so it must be plain
// statements with no require and no module syntax.
//
// THE SHAPE IS DATA, MEASURED, AND PINNED: SHAPE, below, is what the pinned release's macos-arm64
// slice answers for Object.getOwnPropertyNames(__tjs_fs_sync) and for the keys of
// __tjs_fs_sync.stat(path) -- e.g. {"size":466,"mode":33188,"uid":0,"gid":0,
// "mtimeMs":1785163703000,"kind":"file"} -- with no dev, ino, nlink, rdev, blksize, blocks, size64
// or seconds+nanoseconds times (it predates txiki-sync-stat-identity.patch) and no strerror (it
// predates txiki-strerror.patch), no globalThis.__tjs_timer_setref (it predates
// txiki-timer-ref-global.patch) and no globalThis.__tjs_uname (it predates txiki-uname-global.patch). It is NOT derived from the running engine, which grows a binding
// every time a patch lands. test/bootstrap-engine-online.test.cjs asserts on every push that the
// REAL published slice still answers exactly SHAPE (it parses that line, so keep it one line of JSON).
//
// What a gate hears is node-shim's own CLODE_ENGINE_FLOOR_LOG (libexec/node-shim/internal/
// engine-floor-log.cjs): every refusal of a field this engine cannot report, caught or not, and
// rg-native's strerror fallback. The stand-in adds no reporting of its own.
(() => {
  const SHAPE = {"bindings":["open","read","write","close","stat","lstat","fstat","realpath","readlink","readdir","mkdir","rmdir","unlink","rename","access","symlink","chmod"],"stat":["size","mode","uid","gid","mtimeMs","kind"]};
  const real = globalThis.__tjs_fs_sync;
  const oldStat = (f) => (...a) => {
    const r = f.apply(real, a);
    const full = { size: Number(r.size64 !== undefined ? r.size64 : r.size), mode: r.mode, uid: r.uid, gid: r.gid,
      mtimeMs: Number(r.mtimeSec) * 1000, kind: r.kind };
    const o = {};
    for (const k of SHAPE.stat) o[k] = full[k];
    return o;
  };
  const stale = {};
  for (const k of SHAPE.bindings) {
    if (typeof real[k] !== 'function') throw new Error(`stale-engine-prelude: this engine lacks ${k}, which the stale one HAS`);
    stale[k] = real[k];
  }
  stale.stat = oldStat(real.stat);
  stale.lstat = oldStat(real.lstat);
  stale.fstat = oldStat(real.fstat);
  globalThis.__tjs_fs_sync = stale;
  // It predates txiki-timer-ref-global.patch too, so node-shim's Timeout#unref takes the old
  // stop-the-timer route there, and says so in CLODE_ENGINE_FLOOR_LOG.
  delete globalThis.__tjs_timer_setref;
  // And txiki-uname-global.patch: node-shim's os.machine() refuses it, and says so in CLODE_ENGINE_FLOOR_LOG.
  delete globalThis.__tjs_uname;
})();
