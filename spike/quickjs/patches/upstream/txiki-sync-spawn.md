# Feature proposal: a synchronous spawn primitive (`__tjs_spawn_sync`)

## Problem / motivation

txiki.js's process API (`tjs.spawn`) is Promise-based, which is the right
default for an async-first runtime. But it makes txiki.js hard to use as a
drop-in engine for existing CommonJS (CJS) code that expects Node's
*synchronous* child-process calls — `child_process.spawnSync`, `execSync`,
`execFileSync` — which many Node programs, module loaders, and credential/
config probes call from synchronous code paths where there is no `await`.

We hit this building a small Node-compatibility shim so an existing CJS-based
CLI (Claude Code) could run unmodified on txiki.js instead of Node. The program
reads an OS-keychain credential through a *synchronous* `execSync("security …")`
in a code path that cannot be made async, then decides whether the user is
logged in. With no synchronous spawn underneath, that read cannot complete and
the program concludes it has no credentials.

The obvious userland workaround — run the child in a Worker and block the main
thread on the result with `Atomics.wait` over a `SharedArrayBuffer` — does
**not** work in txiki.js: `Atomics.wait` throws `"cannot block in this thread"`
on the main thread (txiki follows the browser rule that only worker threads may
block). Since the app runs on the main thread, it cannot block on a worker's
result. `Worker`, `SharedArrayBuffer`, and `Atomics.wait` are all present; the
main-thread block is the specific thing that is disallowed. So a correct
synchronous spawn needs a real blocking primitive underneath, the same way a
correct `fs.readFileSync` needs real synchronous syscalls (see the companion
`__tjs_fs_sync` proposal).

This patch adds one small synchronous, main-thread-blocking spawn primitive,
exposed as a new global function `__tjs_spawn_sync`. It is intentionally
low-level — a thin `posix_spawn` + `poll()`-drain + `waitpid` wrapper — and
deliberately *not* Node-shaped itself. The intent is that a higher-level
`child_process`-compatibility shim (Node-shaped or otherwise) is built in
userland JS on top of it: PATH resolution, `shell:true`, encoding/`toString`,
signal-number→name mapping, and Node's exact result object all live in JS. This
patch adds only the missing synchronous foundation.

As with `__tjs_fs_sync`, we scoped this as a new, separately-named global rather
than touching anything about the existing `tjs.spawn` async API — nothing here
changes existing behavior. We recognize maintainers may prefer this live outside
core (a native addon/module) and are open to that; this report is meant to start
the conversation.

## The fix (feature patch)

New file `src/mod_spawn_sync.c` (compiled into the `tjs` target, mirroring how
the existing `src/mod_fs_sync.c` is wired in), plus three small integration
edits: one line in `CMakeLists.txt` to add the source, one prototype in
`src/private.h`, and one init call in `src/vm.c`'s `tjs__bootstrap_core()` (the
same function that initializes every other built-in module).

Patch (`spike/quickjs/patches/txiki-sync-spawn.patch` in our repo; applies
cleanly with `git apply` on a v26.6.0 checkout, after `txiki-sync-fs.patch`):

```diff
diff --git a/CMakeLists.txt b/CMakeLists.txt
--- a/CMakeLists.txt
+++ b/CMakeLists.txt
@@ -144,6 +144,7 @@ add_library(tjs STATIC
     src/mod_engine.c
     src/mod_fs.c
     src/mod_fs_sync.c
+    src/mod_spawn_sync.c
     src/mod_fswatch.c
     src/mod_hashing.c
     src/mod_os.c
diff --git a/src/private.h b/src/private.h
--- a/src/private.h
+++ b/src/private.h
@@ -127,6 +127,7 @@ void tjs__mod_error_init(JSContext *ctx, JSValue ns);
 void tjs__mod_ffi_init(JSContext *ctx, JSValue ns);
 void tjs__mod_fs_init(JSContext *ctx, JSValue ns);
 void tjs__mod_fs_sync_init(JSContext *ctx, JSValue ns);
+void tjs__mod_spawn_sync_init(JSContext *ctx, JSValue ns);
 void tjs__mod_fswatch_init(JSContext *ctx, JSValue ns);
 void tjs__mod_hashing_init(JSContext *ctx, JSValue ns);
 void tjs__mod_httpclient_init(JSContext *ctx, JSValue ns);
diff --git a/src/vm.c b/src/vm.c
--- a/src/vm.c
+++ b/src/vm.c
@@ -244,6 +244,7 @@ static void tjs__bootstrap_core(JSContext *ctx, JSValue ns) {
 #endif
     tjs__mod_fs_init(ctx, ns);
     tjs__mod_fs_sync_init(ctx, ns);
+    tjs__mod_spawn_sync_init(ctx, ns);
     tjs__mod_fswatch_init(ctx, ns);
     tjs__mod_os_init(ctx, ns);
     tjs__mod_process_init(ctx, ns);
diff --git a/src/mod_spawn_sync.c b/src/mod_spawn_sync.c
new file mode 100644
index 0000000000000000000000000000000000000000..5613b9c5cd89ccb9a28f4da733d553ec618103b0
--- /dev/null
+++ b/src/mod_spawn_sync.c
@@ -0,0 +1,293 @@
+/* Synchronous spawn primitive for CommonJS interop (node-shim).
+ * posix_spawn + poll()-drain, main-thread blocking by design. Exposed as
+ * the global `__tjs_spawn_sync`. Mirrors mod_fs_sync.c; upstream candidate. */
+#include "private.h"
+#include "utils.h"
+#include <errno.h>
+#include <fcntl.h>
+#include <poll.h>
+#include <signal.h>
+#include <spawn.h>
+#include <stdlib.h>
+#include <string.h>
+#include <sys/wait.h>
+#include <time.h>
+#include <unistd.h>
+
+extern char **environ;
+
+static const char *errno_code(int e) {
+    switch (e) {
+    case ENOENT:  return "ENOENT";
+    case EACCES:  return "EACCES";
+    case EPERM:   return "EPERM";
+    case ENOEXEC: return "ENOEXEC";
+    case E2BIG:   return "E2BIG";
+    case EINVAL:  return "EINVAL";
+    default:      return "EUNKNOWN";
+    }
+}
+
+static JSValue throw_errno(JSContext *ctx, int e, const char *op, const char *path) {
+    JSValue err = JS_NewError(ctx);
+    char buf[1152];
+    snprintf(buf, sizeof(buf), "%s, %s '%s'", errno_code(e), op, path ? path : "");
+    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, buf), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, err, "errno", JS_NewInt32(ctx, e), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, err, "code", JS_NewString(ctx, errno_code(e)), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, err, "syscall", JS_NewString(ctx, op), JS_PROP_C_W_E);
+    return JS_Throw(ctx, err);
+}
+
+/* growable byte buffer */
+typedef struct { uint8_t *data; size_t len, cap; } buf_t;
+static int buf_append(buf_t *b, const uint8_t *p, size_t n, size_t max) {
+    if (b->len >= max) return 0;
+    if (b->len + n > max) n = max - b->len;
+    if (n == 0) return 0;
+    if (b->len + n > b->cap) {
+        size_t nc = b->cap ? b->cap : 4096;
+        while (nc < b->len + n) nc *= 2;
+        uint8_t *nd = realloc(b->data, nc);
+        if (!nd) return -1;
+        b->data = nd; b->cap = nc;
+    }
+    memcpy(b->data + b->len, p, n);
+    b->len += n;
+    return 0;
+}
+
+static long now_ms(void) {
+    struct timespec ts;
+    clock_gettime(CLOCK_MONOTONIC, &ts);
+    return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
+}
+
+static char **js_string_array(JSContext *ctx, JSValueConst arr, int prepend_argc, const char *prepend) {
+    /* Build a NULL-terminated char** from a JS string[]; if prepend != NULL it
+     * becomes element 0 (argv[0]). Caller frees with free_string_array. */
+    JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
+    uint32_t n = 0; JS_ToUint32(ctx, &n, lenv); JS_FreeValue(ctx, lenv);
+    char **out = calloc((size_t)n + prepend_argc + 1, sizeof(char *));
+    if (!out) return NULL;
+    size_t i = 0;
+    if (prepend) out[i++] = strdup(prepend);
+    for (uint32_t k = 0; k < n; k++) {
+        JSValue e = JS_GetPropertyUint32(ctx, arr, k);
+        const char *s = JS_ToCString(ctx, e);
+        out[i++] = strdup(s ? s : "");
+        if (s) JS_FreeCString(ctx, s);
+        JS_FreeValue(ctx, e);
+    }
+    out[i] = NULL;
+    return out;
+}
+static void free_string_array(char **a) {
+    if (!a) return;
+    for (char **p = a; *p; p++) free(*p);
+    free(a);
+}
+
+static JSValue js_spawn_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
+    const char *file = JS_ToCString(ctx, argv[0]);
+    if (!file) return JS_EXCEPTION;
+    JSValue opts = argv[2];
+
+    char **cargv = js_string_array(ctx, argv[1], 1, file);
+    if (!cargv) { JS_FreeCString(ctx, file); return JS_ThrowOutOfMemory(ctx); }
+    JSValue envv = JS_GetPropertyStr(ctx, opts, "env");
+    char **cenv = JS_IsArray(envv) ? js_string_array(ctx, envv, 0, NULL) : NULL;
+    JS_FreeValue(ctx, envv);
+
+    JSValue cwdv = JS_GetPropertyStr(ctx, opts, "cwd");
+    const char *cwd = JS_IsString(cwdv) ? JS_ToCString(ctx, cwdv) : NULL;
+
+    JSValue inv = JS_GetPropertyStr(ctx, opts, "input");
+    size_t input_len = 0;
+    uint8_t *input = (!JS_IsUndefined(inv) && !JS_IsNull(inv)) ? JS_GetArrayBuffer(ctx, &input_len, inv) : NULL;
+
+    int64_t timeout_ms = 0, max_buffer = 1 << 24;
+    JSValue tv = JS_GetPropertyStr(ctx, opts, "timeoutMs");
+    if (JS_IsNumber(tv)) JS_ToInt64(ctx, &timeout_ms, tv);
+    JS_FreeValue(ctx, tv);
+    JSValue mv = JS_GetPropertyStr(ctx, opts, "maxBuffer");
+    if (JS_IsNumber(mv)) JS_ToInt64(ctx, &max_buffer, mv);
+    JS_FreeValue(ctx, mv);
+    if (timeout_ms < 0) timeout_ms = 0;          /* negative timeout => no timeout */
+    if (max_buffer <= 0) max_buffer = 1 << 24;   /* nonpositive cap => default 16MB */
+
+#if !defined(__APPLE__) && !defined(__GLIBC__)
+    if (cwd) {
+        /* build the error before freeing file (throw_errno copies the message) */
+        JSValue e = throw_errno(ctx, EINVAL, "spawn_sync_cwd_unsupported", file);
+        free_string_array(cargv); free_string_array(cenv);
+        JS_FreeCString(ctx, cwd); JS_FreeValue(ctx, cwdv); JS_FreeValue(ctx, inv); JS_FreeCString(ctx, file);
+        return e;
+    }
+#endif
+
+    int outp[2] = {-1, -1}, errp[2] = {-1, -1}, inp[2] = {-1, -1}, devnull = -1;
+    int use_stdin = (input != NULL);
+    if (pipe(outp) < 0 || pipe(errp) < 0 ||
+        (use_stdin ? (pipe(inp) < 0) : ((devnull = open("/dev/null", O_RDONLY)) < 0))) {
+        JSValue e = throw_errno(ctx, errno, "pipe", file);
+        for (int i = 0; i < 2; i++) {
+            if (outp[i] >= 0) close(outp[i]);
+            if (errp[i] >= 0) close(errp[i]);
+            if (inp[i] >= 0) close(inp[i]);
+        }
+        if (devnull >= 0) close(devnull);
+        free_string_array(cargv); free_string_array(cenv);
+        if (cwd) JS_FreeCString(ctx, cwd);
+        JS_FreeValue(ctx, cwdv); JS_FreeValue(ctx, inv); JS_FreeCString(ctx, file);
+        return e;
+    }
+
+    posix_spawn_file_actions_t fa;
+    posix_spawn_file_actions_init(&fa);
+    if (use_stdin) {
+        posix_spawn_file_actions_adddup2(&fa, inp[0], 0);
+        posix_spawn_file_actions_addclose(&fa, inp[0]);
+        posix_spawn_file_actions_addclose(&fa, inp[1]);
+    } else {
+        posix_spawn_file_actions_adddup2(&fa, devnull, 0);
+        posix_spawn_file_actions_addclose(&fa, devnull);
+    }
+    posix_spawn_file_actions_adddup2(&fa, outp[1], 1);
+    posix_spawn_file_actions_addclose(&fa, outp[0]);
+    posix_spawn_file_actions_addclose(&fa, outp[1]);
+    posix_spawn_file_actions_adddup2(&fa, errp[1], 2);
+    posix_spawn_file_actions_addclose(&fa, errp[0]);
+    posix_spawn_file_actions_addclose(&fa, errp[1]);
+#if defined(__APPLE__) || defined(__GLIBC__)
+    /* addchdir_np: since macOS 10.15 / glibc 2.29. Deprecated on macOS 26 for
+     * the POSIX posix_spawn_file_actions_addchdir, but still functional; the
+     * build is -Werror, so suppress the deprecation locally rather than fork
+     * the name per OS version. M4 (NetBSD) re-checks availability. */
+    if (cwd) {
+#if defined(__clang__)
+#pragma clang diagnostic push
+#pragma clang diagnostic ignored "-Wdeprecated-declarations"
+#elif defined(__GNUC__)
+#pragma GCC diagnostic push
+#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
+#endif
+        posix_spawn_file_actions_addchdir_np(&fa, cwd);
+#if defined(__clang__)
+#pragma clang diagnostic pop
+#elif defined(__GNUC__)
+#pragma GCC diagnostic pop
+#endif
+    }
+#endif
+
+    pid_t pid = 0;
+    int rc = posix_spawn(&pid, file, &fa, NULL, cargv, cenv ? cenv : environ);
+    posix_spawn_file_actions_destroy(&fa);
+    close(outp[1]); close(errp[1]);
+    if (use_stdin) close(inp[0]); else close(devnull);
+
+    JSValue result;
+    if (rc != 0) {
+        close(outp[0]); close(errp[0]);
+        if (use_stdin) close(inp[1]);
+        result = throw_errno(ctx, rc, "spawn", file);
+        goto cleanup;
+    }
+
+    if (use_stdin) {
+        void (*old)(int) = signal(SIGPIPE, SIG_IGN);
+        size_t off = 0;
+        while (off < input_len) {
+            ssize_t w = write(inp[1], input + off, input_len - off);
+            if (w < 0) { if (errno == EINTR) continue; break; }
+            off += (size_t)w;
+        }
+        close(inp[1]);
+        signal(SIGPIPE, old);
+    }
+
+    buf_t ob = {0}, eb = {0};
+    struct pollfd pfds[2] = { { outp[0], POLLIN, 0 }, { errp[0], POLLIN, 0 } };
+    int open_count = 2, timed_out = 0;
+    long start = now_ms();
+    uint8_t rbuf[65536];
+    while (open_count > 0) {
+        int to = -1;
+        if (timeout_ms > 0) {
+            long rem = timeout_ms - (now_ms() - start);
+            if (rem <= 0) { timed_out = 1; break; }
+            to = (int)rem;
+        }
+        int pr = poll(pfds, 2, to);
+        if (pr < 0) { if (errno == EINTR) continue; break; }
+        if (pr == 0) { timed_out = 1; break; }
+        for (int k = 0; k < 2; k++) {
+            if (pfds[k].fd < 0) continue;
+            if (pfds[k].revents & (POLLIN | POLLHUP | POLLERR)) {
+                ssize_t n = read(pfds[k].fd, rbuf, sizeof(rbuf));
+                if (n > 0) {
+                    buf_append(k == 0 ? &ob : &eb, rbuf, (size_t)n, (size_t)max_buffer);
+                    /* DIVERGENCE: a maxBuffer overrun is reported via the SAME
+                     * `timedOut` flag as a real timeout (both kill with SIGKILL).
+                     * Node distinguishes them (a RangeError
+                     * ERR_CHILD_PROCESS_STDIO_MAXBUFFER vs signal=killSignal). The
+                     * shim (Task 2) surfaces the conflated case as an error;
+                     * characterized in test/node-shim-child-process.test.cjs. */
+                    if ((int64_t)(ob.len + eb.len) >= max_buffer) { timed_out = 1; break; }
+                } else if (n < 0 && errno == EINTR) {
+                    continue;  /* interrupted read — retry via the next poll, not EOF */
+                } else {
+                    close(pfds[k].fd); pfds[k].fd = -1; open_count--;
+                }
+            }
+        }
+        if (timed_out) break;
+    }
+    if (pfds[0].fd >= 0) close(pfds[0].fd);
+    if (pfds[1].fd >= 0) close(pfds[1].fd);
+    if (timed_out) kill(pid, SIGKILL);
+
+    int wstatus = 0;
+    while (waitpid(pid, &wstatus, 0) < 0 && errno == EINTR) {}
+    int has_status = WIFEXITED(wstatus), has_sig = WIFSIGNALED(wstatus);
+
+    result = JS_NewObject(ctx);
+    JS_DefinePropertyValueStr(ctx, result, "pid", JS_NewInt32(ctx, pid), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, result, "status",
+        (has_status && !timed_out) ? JS_NewInt32(ctx, WEXITSTATUS(wstatus)) : JS_NULL, JS_PROP_C_W_E);
+    /* DIVERGENCE: on timeout/maxBuffer the child is always killed with SIGKILL
+     * (reported here as the signal); Node defaults to SIGTERM then escalates. */
+    JS_DefinePropertyValueStr(ctx, result, "signal",
+        has_sig ? JS_NewInt32(ctx, WTERMSIG(wstatus)) : (timed_out ? JS_NewInt32(ctx, SIGKILL) : JS_NULL), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, result, "stdout",
+        JS_NewArrayBufferCopy(ctx, ob.data ? ob.data : (const uint8_t *)"", ob.len), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, result, "stderr",
+        JS_NewArrayBufferCopy(ctx, eb.data ? eb.data : (const uint8_t *)"", eb.len), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, result, "timedOut", JS_NewBool(ctx, timed_out), JS_PROP_C_W_E);
+    free(ob.data); free(eb.data);
+
+cleanup:
+    free_string_array(cargv); free_string_array(cenv);
+    if (cwd) JS_FreeCString(ctx, cwd);
+    JS_FreeValue(ctx, cwdv); JS_FreeValue(ctx, inv);
+    JS_FreeCString(ctx, file);
+    return result;
+}
+
+static const JSCFunctionListEntry spawn_sync_funcs[] = {
+    JS_CFUNC_DEF("spawn", 3, js_spawn_sync),
+};
+
+void tjs__mod_spawn_sync_init(JSContext *ctx, JSValue ns) {
+    (void)ns;
+    JSValue global = JS_GetGlobalObject(ctx);
+    JSValue obj = JS_NewObject(ctx);
+    JS_SetPropertyFunctionList(ctx, obj, spawn_sync_funcs, countof(spawn_sync_funcs));
+    /* Expose the single entry directly as the callable global for ergonomics:
+     * __tjs_spawn_sync(file, args, opts). */
+    JSValue fn = JS_GetPropertyStr(ctx, obj, "spawn");
+    JS_DefinePropertyValueStr(ctx, global, "__tjs_spawn_sync", fn, JS_PROP_C_W_E);
+    JS_FreeValue(ctx, obj);
+    JS_FreeValue(ctx, global);
+}
```

## API summary

`__tjs_spawn_sync(file, args, opts)` — synchronous, blocking; returns a result
object, or throws a real `Error` (with `.code`/`.errno`/`.syscall`, same shape
as `__tjs_fs_sync`'s errors) on a launch failure (ENOENT/EACCES).

- `file` — string; an absolute/explicit path. PATH resolution of a bare command
  is left to the userland shim (so the C uses `posix_spawn`, not
  `posix_spawnp`, and carries no PATH logic).
- `args` — array of strings; the argv tail (`file` is prepended as argv[0]).
- `opts`:
  - `cwd` — string; applied via `posix_spawn_file_actions_addchdir_np` (present
    on macOS 10.15+ / glibc 2.29+). Deprecated on macOS 26 in favor of the
    POSIX `posix_spawn_file_actions_addchdir`; still functional, wrapped in a
    local `-Wdeprecated-declarations` pragma under the build's `-Werror`. On a
    platform lacking `addchdir_np`, requesting `cwd` throws `EINVAL`.
  - `env` — array of `"KEY=VALUE"` strings (the shim flattens an env object);
    absent → the child inherits the parent env.
  - `input` — `ArrayBuffer` written to the child's stdin, then closed (SIGPIPE
    ignored around the write). Absent → the child's stdin is `/dev/null` (a
    synchronous child must never inherit and steal the parent's stdin).
  - `timeoutMs` — number; enforced by the `poll()` deadline (child SIGKILLed on
    expiry). Non-positive → no timeout.
  - `maxBuffer` — number; a cap on total captured stdout+stderr bytes
    (child killed on exceed). Non-positive → a 16 MiB default.
- returns `{ pid, status:number|null, signal:number|null, stdout:ArrayBuffer,
  stderr:ArrayBuffer, timedOut:boolean }`. `status` is the exit code (null if
  the child was signalled or timed out); `signal` is the raw termination signal
  *number* (the shim maps it to Node's string name). `stdout`/`stderr` are the
  drained output. `timedOut` is set on either a timeout or a maxBuffer overrun.

The two output pipes are drained concurrently with a single `poll()` loop, which
avoids the classic deadlock where a child filling its stderr pipe blocks while
the parent is still reading stdout.

## Validation

We use this primitive to back a `node:child_process`-compatible CJS shim
(`libexec/node-shim/modules/child_process.cjs` in our repo) that layers Node's
`spawnSync`/`execSync`/`execFileSync` surface on top of it in plain JS (PATH
resolution, `shell:true`, encoding, the signal-number→name map, and Node's exact
result/`error` shape). Two levels of validation against the patched `tjs`:

**C smoke** (direct against `__tjs_spawn_sync`, no shim):

```
$ tjs eval '
  const d = ab => new TextDecoder().decode(ab);
  let r = __tjs_spawn_sync("/bin/echo",["hi"],{});            console.log("echo", r.status, d(r.stdout).trim());
  r = __tjs_spawn_sync("/bin/sh",["-c","exit 3"],{});         console.log("exit3", r.status);
  r = __tjs_spawn_sync("/bin/cat",[],{input:new TextEncoder().encode("PING").buffer}); console.log("cat", d(r.stdout).trim());
  r = __tjs_spawn_sync("/usr/bin/printenv",["FOO"],{env:["FOO=bar"]});                 console.log("env", d(r.stdout).trim());
  try { __tjs_spawn_sync("/no/such/bin",[],{}); } catch (x) { console.log("enoent", x.code); }'
echo 0 hi
exit3 3
cat PING
env bar
enoent ENOENT
```

**Characterization tests** (`test/node-shim-child-process.test.cjs`): each
fixture runs once under host Node (`node:child_process`) and once under our shim
on the patched `tjs`, then the observable results are diffed — exit status,
stdout, stderr, stdin `input` (via `cat`), `env` passthrough (via `printenv`),
`cwd` (via `pwd`), non-zero exit, the ENOENT `error` object, the signal string
name, and the timeout path. All rows match host Node (with two intentional,
separately-characterized divergences: a maxBuffer overrun surfaces via the same
timeout path rather than Node's `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, and the
kill signal is always `SIGKILL` rather than Node's `SIGTERM`-then-escalate).

We're happy to discuss scope/placement (core vs. a separate module/addon) or API
shape if maintainers are interested in taking this upstream in some form,
alongside the companion `__tjs_fs_sync` proposal.
