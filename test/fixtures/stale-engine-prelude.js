// A STALE ENGINE, simulated: the engine the last release (v0.20260831.1) shipped, as HEAD's code
// sees it. Prepended as TEXT to a program that a real, current tjs then runs (and inserted after
// line 1 of a copy of node-shim's loader by test/stale-build-host.cjs), so it must be plain
// statements with no require and no module syntax.
//
// The shape is MEASURED, not imagined: on the pinned release's macos-arm64 slice,
// `__tjs_fs_sync.stat("/etc/hosts")` answers exactly
//   {"size":466,"mode":33188,"uid":0,"gid":0,"mtimeMs":1785163703000,"kind":"file"}
// -- no dev, ino, nlink, rdev, blksize, blocks, size64 or seconds+nanoseconds times (that engine
// predates txiki-sync-stat-identity.patch), and `__tjs_fs_sync.strerror` is absent (it predates
// txiki-strerror.patch). Everything else the floor names (spawn_sync, moduleMeta) it HAS.
//
// THE TRIPWIRE. node-shim's refusal of a field this engine cannot report is an exception, and an
// exception can be CAUGHT: `try { m = fs.statSync(p).mtimeMs } catch {}` takes the wrong branch in
// silence. node-shim also writes its first refusal to stderr, but stderr can be captured and
// dropped by a parent. So when CLODE_STALE_ENGINE_TRIPWIRE names a file, every such stderr line is
// ALSO appended to it, with the stack that produced it -- from every process in the tree, since
// the variable is inherited. A gate then asserts the file stayed empty.
//
// strerror has no refusal of its own to catch: its one caller (libexec/rg-native.cjs) tests for it
// and falls back. So a READ of it is recorded on the tripwire too -- the build never runs rg, and
// a build path that reached for strerror is exactly what the build-host floor says cannot happen.
(() => {
  const real = globalThis.__tjs_fs_sync;
  const wire = globalThis.tjs && globalThis.tjs.env && globalThis.tjs.env.CLODE_STALE_ENGINE_TRIPWIRE;
  const record = (line) => {
    if (!wire) return;
    try {
      const fd = real.open(wire, 'a');
      try { real.write(fd, new TextEncoder().encode(`${line}\n${new Error('tripwire').stack}\n`).buffer, -1); }
      finally { real.close(fd); }
    } catch { /* best effort: the node-shim stderr line still says it */ }
  };
  const old = (f) => (...a) => {
    const r = f.apply(real, a);
    return { size: Number(r.size64 !== undefined ? r.size64 : r.size), mode: r.mode, uid: r.uid, gid: r.gid,
      mtimeMs: Number(r.mtimeSec) * 1000, kind: r.kind };
  };
  // As that engine has it: the same own functions, the three stats in the old shape, and NO
  // strerror key at all (code that enumerates the binding -- node-shim's nodeErrorsFss -- must
  // not see one). A direct read of the name is what gets recorded.
  const target = {};
  for (const k of Object.getOwnPropertyNames(real)) if (k !== 'strerror') target[k] = real[k];
  target.stat = old(real.stat);
  target.lstat = old(real.lstat);
  target.fstat = old(real.fstat);
  globalThis.__tjs_fs_sync = new Proxy(target, {
    get(t, k, r) {
      if (k === 'strerror') { record('stale engine: __tjs_fs_sync.strerror was read (this engine has none)'); return undefined; }
      return Reflect.get(t, k, r);
    },
  });
  if (wire && globalThis.console && typeof globalThis.console.error === 'function') {
    const err = globalThis.console.error.bind(globalThis.console);
    globalThis.console.error = (...a) => {
      const line = a.map(String).join(' ');
      if (line.startsWith('node-shim: this engine')) record(line);
      return err(...a);
    };
  }
})();
