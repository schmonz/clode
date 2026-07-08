quickjs-ng v0.15.1 fd0a0210b7be00957751871e7e01b8291268fc29 2026-07-05
# QuickJS-ng Compiler version 0.15.1
txiki.js v26.6.0 1a230d31183f062fae7a6c4fd2cff466cecc1787 2026-07-06
# txiki.js build: git clone --recurse-submodules --depth 1 --branch v26.6.0; then
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(getconf _NPROCESSORS_ONLN)
# caveat: on AppleDouble-writing mounts, delete `._*` sidecars first (find . -name '._*' -delete)
#   or wamr's source globs pick up `._foo.c` files and the build fails.
anita 2.18 gson.org-tarball 2026-07-06
# anita: PyPI "anita" is an unrelated proof-assistant; install http://www.gson.org/netbsd/anita/download/anita-2.18.tar.gz
netbsd 10.1 cdn 2026-07-06
# netbsd: https://cdn.netbsd.org/pub/NetBSD/NetBSD-10.1/amd64/ ; guest PKG_PATH redirects to .../NetBSD/x86_64/10.0_2026Q1/All
netbsd-evbarm-aarch64 10.1 cdn 2026-07-06
# evbarm-aarch64: pre-installed image binary/gzimg/arm64.img.gz + netbsd-GENERIC64 kernel, HVF accel;
#   guest PKG_PATH .../NetBSD/aarch64/10.1/All redirects to .../aarch64/10.0_2026Q1/All
simde v0.8.2 wamr-fetchcontent 2026-07-06
# simde: header-only, wamr simde.cmake FetchContent git-clones it at configure time;
#   guests get it pre-seeded via vendor/dist/simde-v0.8.2.tar.gz + FETCHCONTENT_SOURCE_DIR_SIMDE
netbsd-mac68k 10.1 cdn 2026-07-06
# mac68k: North-Star BE32 rung; anita has ZERO mac68k support -> manual qemu-system-m68k
#   -M q800 (max RAM 1024 MiB) bring-up. Install kernel netbsd-INSTALL.gz (embedded sysinst
#   ramdisk) at installation/instkernel/; work kernel netbsd-GENERIC.gz at binary/kernel/;
#   sets base+comp+etc+text at binary/sets/. sysinst driver never written — rung blocked at qemu boot (no NetBSD-capable q800 -kernel path); see results/gate3-netbsd-mac68k.md
#   No m68k pkgsrc binary packages assumed; build with base comp.tgz gcc + quickjs-ng cmake.
quickjs-ng-js_exepath-netbsd patch 2026-07-06
# patch: patches/quickjs-ng-js_exepath-netbsd.patch adds a NetBSD js_exepath() (sysctl
#   KERN_PROC_PATHNAME) to cutils.h. Without it a `qjs -c` standalone silently falls back to
#   the REPL on any BSD and busy-spins on EOF stdin (root cause: results/gate3-netbsd-aarch64.md).
#   Applied to the guest's extracted quickjs-ng source (patch -p1) before cmake; upstream fix
#   candidate. Enables the run-from-bytecode memory measurement the North Star turns on.
# txiki-sync-fs.patch: adds __tjs_fs_sync global (sync POSIX fs for CJS interop), 2026-07-07
# txiki-sync-spawn.patch: adds __tjs_spawn_sync global (sync posix_spawn + poll()-drain
#   for CJS spawnSync interop), 2026-07-07. Main-thread blocking by design (like sync-fs);
#   does NOT touch the JS stack size or run on a worker, so the worker C-stack caveat does
#   NOT apply. cwd via posix_spawn_file_actions_addchdir_np (macOS 10.15+/glibc 2.29+),
#   guarded #if __APPLE__||__GLIBC__; on a build without it, requesting cwd throws EINVAL.
#   NOTE: addchdir_np is DEPRECATED on macOS 26 (superseded by the POSIX addchdir) and the
#   build is -Werror, so the call is wrapped in a local -Wdeprecated-declarations pragma
#   push/ignore/pop (clang+gcc) rather than forking the name per OS version — still
#   functional on 26. NetBSD (M4) MUST re-check addchdir_np availability before the guest
#   build; if absent, add a fallback there. Characterized by
#   test/node-shim-child-process.test.cjs (sync rows).
#   UPDATE 2026-07-08: patch now also closes a native fd-inheritance LEAK. The
#   original posix_spawn() passed attrp=NULL (no POSIX_SPAWN_CLOEXEC_DEFAULT) and
#   created its stdio pipes without O_CLOEXEC, so EVERY non-cloexec parent fd
#   leaked into each sync child — notably libwebsockets' in-flight outbound
#   TCP/TLS socket for a live fetch(). When a burst of __tjs_spawn_sync children
#   (keychain `security`, git, `ps aux|grep`) overlapped the fetch connect/TLS
#   window, the inherited-then-closed socket corrupted the connection ("closed
#   before established", rapid retries, never connects) — the M3b "Wall #1" fd-race
#   and the TUI's hung `fetch HEAD api.anthropic.com`. FIX: set
#   POSIX_SPAWN_CLOEXEC_DEFAULT on Apple (mirrors libuv's uv_spawn, whose async
#   path never leaked precisely because it sets this flag) + create the pipes
#   O_CLOEXEC (portable pipe()+fcntl; the dup2 file_actions clear cloexec on the
#   child's 0/1/2 copies so stdio still works). PROVEN empirically: a sync child
#   probing /dev/fd saw the fetch socket (fds 8,9) BEFORE the patch and only its
#   own stdio AFTER; an async child never saw them either way. On non-Apple the
#   flag is absent — the O_CLOEXEC pipes + already-cloexec runtime fds carry it.
# txiki-no-origin-header.patch: httpclient.c tjs_httpclient_connect() no longer sets
#   cci.origin (was = uri->host), 2026-07-07. libwebsockets turned that into a real
#   `Origin:` header on EVERY fetch(), which CORS-guarded APIs reject (api.anthropic.com
#   -> 401 "CORS requests are not allowed for this Organization"); host node sends no
#   Origin. Not suppressible from JS (lws adds it beneath the fetch/Headers surface).
#   Only the generic HTTP client path; WebSocket handshakes use a different path and
#   still send Origin. Verified: httpbin.org/headers shows no Origin after the patch.
#   Upstream candidate.
# txiki-default-stack-size.patch: raises TJS__DEFAULT_STACK_SIZE from txiki's stock 1MB
#   release default to 4MB, 2026-07-07. The real extracted Claude Code bundle (cli.cjs,
#   ~22MB minified) recurses deeper at startup than 1MB admits and overflows before the
#   CJS entry finishes evaluating — the SOLE wall on the M2 `--version` boot. 4MB clears
#   it with headroom (measured recursion depth 1034 -> 4155) and stays well under the 8MB
#   main-thread C stack on macOS/Linux. Characterized by test/node-shim-stack.test.cjs.
#   CAVEAT (worker threads): this 4MB JS stack ceiling applies to whichever thread runs
#   the engine, but libuv worker threads default to only a ~512KB C stack on macOS — a
#   4MB JS limit there could SEGFAULT (native stack overrun) rather than throw a catchable
#   RangeError like the main thread does. Safe today because --version is main-thread-only
#   (8MB C stack) and worker_threads is not shimmed. Whoever bumps this stack size again
#   (or adds worker_threads support) in M3+ MUST re-check the worker C-stack size first.
# upstream: js_exepath + repl-eof-spin (quickjs-ng), sync-fs (txiki) — prepared 2026-07-07, awaiting user go-ahead to post
# before-posting: DONE 2026-07-07 — txiki-sync-fs.patch is submission-ready (header de-jargoned; C hardened: read errno-capture around js_free, write resolves pos before JS_GetArrayBuffer to avoid detach-dangling)
# txiki-netbsd-portability.patch: two NetBSD compile walls found by the M4
#   in-guest build 2026-07-07, one upstream-PR candidate: (a) mod_dns.c used
#   AI_V4MAPPED, an RFC 3493 flag NetBSD never implemented -> shimmed to 0 when
#   undefined (OR becomes a no-op); (b) mod_posix-socket.c's non-Apple branch
#   getsockopt()s SO_DOMAIN/SO_PROTOCOL (Linux/FreeBSD extensions, absent on
#   NetBSD) -> #ifdef-guarded like the file's own constants table; (c) mod_ffi.c's
#   LIBC_NAME/LIBM_NAME OS switch had no NetBSD branch (#error 'unknown os') ->
#   added sonames libc.so.12/libm.so.0 (unversioned .so symlinks are comp.tgz-only).
#   Full-tree sweeps: no other unguarded socket/dns consts vs NetBSD 10 headers,
#   and mod_ffi.c:1260 was the only OS-switch #error in src/. The other M4 build walls
#   need no patch: ada needs pkgsrc gcc12 (base g++ 10.5 lacks C++20 constexpr
#   string); mimalloc 3.2.7 is broken on NetBSD upstream (its #if __NetBSD__
#   options-table entry names the pre-rename mi_option_eager_commit_delay) ->
#   guest builds -DBUILD_WITH_MIMALLOC=OFF; txiki src #pragma region (clang/MSVC
#   -ism) trips gcc -Wunknown-pragmas -> guest strips -Werror (upstream candidate).
# txiki-spawn-fail-uaf.patch: mod_process.c tjs_spawn() fixed a heap-use-after-free
#   on the spawn LAUNCH-FAILURE path (2026-07-08, ASAN-confirmed; upstream candidate).
#   On uv_spawn() error (e.g. child_process ENOENT) it did tjs__free(p) synchronously,
#   but libuv deliberately leaves the uv__handle_init'd process handle owned by the
#   loop even on exec failure (the "expects initialized streams, even if the exec
#   failed" note in uv_spawn) — so a later uv_run/uv__run_closing_handles WRITEs into
#   the freed handle. Manifested as a nondeterministic teardown SIGSEGV/SIGBUS (exit
#   139/138) after correct output, layout-sensitive (the "codegen fragility" the
#   phase-2 notes chased). Fix: release the handle via the async uv_close path the
#   exit/finalizer paths already use (p->finalized=true; maybe_close(p)) instead of
#   the direct free; the pre-uv_spawn goto-fail cases keep the direct free (handle
#   never handed to the loop). Root cause found with an ASAN tjs build
#   (-DBUILD_WITH_ASAN=ON -DBUILD_WITH_MIMALLOC=OFF). Locked by the
#   node-shim-child-process.test.cjs "ENOENT surfaces as an async error event" row.
# BUILD CAVEATS re-confirmed 2026-07-08 (bit the rebuild): (1) the ~42k AppleDouble
#   ._* sidecars on this NFS mount must be deleted before building (poison CMake/wamr
#   globs). (2) sync-fs/sync-spawn have overlapping context in vm.c/private.h/
#   CMakeLists — strict `git apply` (build-tjs.mjs) fails to re-apply/sequence them on
#   an already-patched tree; GNU `patch -p1 --forward` (fuzzy) applies all 6 cleanly
#   from pristine. (3) the linker-adhoc signature can be invalidated by copying the
#   binary off the build dir on this mount (exec dies "Terminated due to code signing
#   error", SIGKILL/137, even though `codesign -v` passes) — re-sign after copy:
#   `codesign -s - --force build/tjs/tjs`.
# txiki-stream-write-sync-number.patch: mod_streams.c tjs_stream_write() returned
#   JS_TRUE (a boolean) when uv_try_write completed the write synchronously, but the
#   JS writable sinks (core/process.js ProcessWritableStream, core/direct-sockets/
#   udp.js) treat a NUMBER as "write done, don't wait" and anything else as "async —
#   await the onwrite callback". A boolean is not a number, so small synchronous
#   writes waited forever for an onwrite that never fires. Symptom (2026-07-08):
#   Claude Code's Bash tool feeds short commands to a PERSISTENT shell via the
#   shell's stdin; every such write hung → the interactive tool call never returned.
#   Data was physically delivered (uv_try_write succeeded) but the write-ack didn't.
#   Fix: return JS_NewInt32(ctx, r) (the byte count) on the sync-complete path. Also
#   fixes udp.js's identical latent hang. Upstream-txiki candidate. Locked by
#   node-shim-child-process.test.cjs "persistent shell via child.stdin" row.
