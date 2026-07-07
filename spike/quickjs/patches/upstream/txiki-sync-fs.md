# Feature proposal: synchronous filesystem primitives (`__tjs_fs_sync`)

## Problem / motivation

txiki.js's `tjs.*` filesystem API is entirely Promise-based (`tjs.readFile`,
`tjs.open`, etc.), which is a good default for an async-first runtime. But
it makes txiki.js hard to use as a drop-in engine for existing CommonJS
(CJS) code that expects Node's synchronous `fs` calls — `fs.readFileSync`,
`fs.statSync`, `fs.mkdirSync`, and friends — which many existing Node
scripts, module loaders, and build tools call at module-load time, before
any event loop is running or `await` is available.

We ran into this building a small Node-compatibility shim so that an
existing CJS-based CLI tool could run unmodified on top of txiki.js instead
of Node. Module loading in CJS is inherently synchronous (`require()`
returns a value immediately, it doesn't return a Promise), so a faithful
`fs` shim needs real synchronous syscalls underneath it — there's no way to
build a correct `fs.readFileSync` on top of an async-only `tjs.readFile`
without either blocking the event loop some other way or accepting
incorrect semantics. ("CJS" — CommonJS, Node's synchronous `require()`-based
module system, as opposed to ESM's asynchronous `import`. "Shim" — a
same-named replacement module that mimics Node's `fs` API surface, backed
by different primitives underneath, so unmodified CJS code can run without
changes.)

This patch adds a small set of synchronous, main-thread-blocking POSIX
filesystem primitives, exposed as a new global object `__tjs_fs_sync`. It's
intentionally minimal and low-level (raw `open`/`read`/`write`/`close`,
`stat`/`lstat`/`fstat`, `readdir`, `mkdir`, `rmdir`, `unlink`, `rename`,
`symlink`, `readlink`, `realpath`, `access`, `chmod`) — a thin, direct
wrapper over the corresponding POSIX syscalls, deliberately not
Node-shaped itself. The intent is that a higher-level `fs`-compatibility
shim (Node-shaped or otherwise) can be built in userland JS on top of these
primitives; this patch only adds the missing synchronous foundation, not a
full Node `fs` polyfill.

We're aware synchronous, blocking I/O cuts against txiki.js's async-by-default
design, which is exactly why we scoped this as a new, separately-named
global (`__tjs_fs_sync`) rather than changing anything about the existing
`tjs.*` async API — nothing about this patch affects any existing behavior.
We think it's a reasonable opt-in addition for embedders who need CJS/sync
compatibility, but we recognize maintainers may prefer this live outside
core (e.g. as a native addon/module), and we're open to that outcome — this
report is meant to start that conversation, not presume the answer.

## The fix (feature patch)

New file `src/mod_fs_sync.c` (compiled into both the `tjs` and `vmlib`
targets, mirroring how the existing async `src/mod_fs.c` is wired in),
plus three small integration edits: one line in `CMakeLists.txt` to add the
new source file, one prototype in `src/private.h`, and one init call in
`src/vm.c`'s `tjs__bootstrap_core()` (the same function that already
initializes every other built-in module, `tjs__mod_fs_init` included).

Patch (`spike/quickjs/patches/txiki-sync-fs.patch` in our repo; applies
cleanly with `git apply` from a v26.6.0 checkout):

```diff
diff --git a/CMakeLists.txt b/CMakeLists.txt
index 60150c3..1d1a1e8 100644
--- a/CMakeLists.txt
+++ b/CMakeLists.txt
@@ -143,6 +143,7 @@ add_library(tjs STATIC
     src/mod_dns.c
     src/mod_engine.c
     src/mod_fs.c
+    src/mod_fs_sync.c
     src/mod_fswatch.c
     src/mod_hashing.c
     src/mod_os.c
diff --git a/src/mod_fs_sync.c b/src/mod_fs_sync.c
new file mode 100644
index 0000000..162dafa
--- /dev/null
+++ b/src/mod_fs_sync.c
@@ -0,0 +1,229 @@
+/* Synchronous fs primitives for CommonJS interop (node-shim).
+ * POSIX-direct, main-thread blocking by design. Exposed as the
+ * global `__tjs_fs_sync`. Upstream candidate: see
+ * the accompanying feature-proposal writeup. */
+#include "private.h"
+#include "utils.h"
+#include <dirent.h>
+#include <errno.h>
+#include <fcntl.h>
+#include <limits.h>
+#include <stdlib.h>
+#include <string.h>
+#include <sys/stat.h>
+#include <unistd.h>
+
+static const char *errno_code(int e) {
+    switch (e) {
+    case ENOENT:  return "ENOENT";
+    case EACCES:  return "EACCES";
+    case EEXIST:  return "EEXIST";
+    case EISDIR:  return "EISDIR";
+    case ENOTDIR: return "ENOTDIR";
+    case EINVAL:  return "EINVAL";
+    case EBADF:   return "EBADF";
+    case ELOOP:   return "ELOOP";
+    case ENOSPC:  return "ENOSPC";
+    case EPERM:   return "EPERM";
+    default:      return "EUNKNOWN";
+    }
+}
+
+static JSValue throw_errno(JSContext *ctx, const char *op, const char *path) {
+    int e = errno;
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
+static JSValue js_fss_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
+    const char *path = JS_ToCString(ctx, argv[0]);
+    const char *flags = JS_ToCString(ctx, argv[1]);
+    if (!path || !flags) return JS_EXCEPTION;
+    int oflags;
+    if (!strcmp(flags, "r")) oflags = O_RDONLY;
+    else if (!strcmp(flags, "w")) oflags = O_WRONLY | O_CREAT | O_TRUNC;
+    else if (!strcmp(flags, "a")) oflags = O_WRONLY | O_CREAT | O_APPEND;
+    else if (!strcmp(flags, "r+")) oflags = O_RDWR;
+    else if (!strcmp(flags, "w+")) oflags = O_RDWR | O_CREAT | O_TRUNC;
+    else { JS_FreeCString(ctx, path); JS_FreeCString(ctx, flags);
+           return JS_ThrowTypeError(ctx, "fs_sync.open: bad flags"); }
+    int fd = open(path, oflags, 0666);
+    JSValue ret = (fd < 0) ? throw_errno(ctx, "open", path) : JS_NewInt32(ctx, fd);
+    JS_FreeCString(ctx, path); JS_FreeCString(ctx, flags);
+    return ret;
+}
+
+static JSValue js_fss_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
+    int fd; int64_t len, pos;
+    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt64(ctx, &len, argv[1]) || JS_ToInt64(ctx, &pos, argv[2]))
+        return JS_EXCEPTION;
+    if (len < 0 || len > 1 << 28) return JS_ThrowRangeError(ctx, "fs_sync.read: bad length");
+    uint8_t *buf = js_malloc(ctx, len ? len : 1);
+    if (!buf) return JS_EXCEPTION;
+    ssize_t n = (pos >= 0) ? pread(fd, buf, len, (off_t)pos) : read(fd, buf, len);
+    if (n < 0) { js_free(ctx, buf); return throw_errno(ctx, "read", NULL); }
+    JSValue ab = JS_NewArrayBufferCopy(ctx, buf, n);
+    js_free(ctx, buf);
+    return ab;
+}
+
+static JSValue js_fss_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
+    int fd; int64_t pos; size_t len; uint8_t *buf;
+    if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
+    buf = JS_GetArrayBuffer(ctx, &len, argv[1]);
+    if (!buf) return JS_EXCEPTION;
+    if (JS_ToInt64(ctx, &pos, argv[2])) return JS_EXCEPTION;
+    ssize_t n = (pos >= 0) ? pwrite(fd, buf, len, (off_t)pos) : write(fd, buf, len);
+    if (n < 0) return throw_errno(ctx, "write", NULL);
+    return JS_NewInt64(ctx, n);
+}
+
+static JSValue js_fss_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
+    int fd;
+    if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
+    if (close(fd) < 0) return throw_errno(ctx, "close", NULL);
+    return JS_UNDEFINED;
+}
+
+static JSValue stat_to_js(JSContext *ctx, struct stat *st) {
+    JSValue o = JS_NewObject(ctx);
+    JS_DefinePropertyValueStr(ctx, o, "size", JS_NewInt64(ctx, st->st_size), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, o, "mode", JS_NewInt32(ctx, st->st_mode), JS_PROP_C_W_E);
+    JS_DefinePropertyValueStr(ctx, o, "mtimeMs", JS_NewFloat64(ctx, (double)st->st_mtime * 1000.0), JS_PROP_C_W_E);
+    const char *kind = S_ISREG(st->st_mode) ? "file" : S_ISDIR(st->st_mode) ? "dir"
+                     : S_ISLNK(st->st_mode) ? "symlink" : "other";
+    JS_DefinePropertyValueStr(ctx, o, "kind", JS_NewString(ctx, kind), JS_PROP_C_W_E);
+    return o;
+}
+
+#define FSS_PATH_STAT(NAME, CALL)                                                        \
+static JSValue js_fss_##NAME(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
+    const char *path = JS_ToCString(ctx, argv[0]);                                       \
+    if (!path) return JS_EXCEPTION;                                                      \
+    struct stat st;                                                                      \
+    int r = CALL(path, &st);                                                             \
+    JSValue ret = (r < 0) ? throw_errno(ctx, #NAME, path) : stat_to_js(ctx, &st);        \
+    JS_FreeCString(ctx, path);                                                           \
+    return ret;                                                                          \
+}
+FSS_PATH_STAT(stat, stat)
+FSS_PATH_STAT(lstat, lstat)
+
+static JSValue js_fss_fstat(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
+    int fd;
+    if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
+    struct stat st;
+    if (fstat(fd, &st) < 0) return throw_errno(ctx, "fstat", NULL);
+    return stat_to_js(ctx, &st);
+}
+
+static JSValue js_fss_realpath(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
+    const char *path = JS_ToCString(ctx, argv[0]);
+    if (!path) return JS_EXCEPTION;
+    char buf[PATH_MAX];
+    char *r = realpath(path, buf);
+    JSValue ret = r ? JS_NewString(ctx, buf) : throw_errno(ctx, "realpath", path);
+    JS_FreeCString(ctx, path);
+    return ret;
+}
+
+static JSValue js_fss_readlink(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
+    const char *path = JS_ToCString(ctx, argv[0]);
+    if (!path) return JS_EXCEPTION;
+    char buf[PATH_MAX];
+    ssize_t n = readlink(path, buf, sizeof(buf) - 1);
+    JSValue ret;
+    if (n < 0) ret = throw_errno(ctx, "readlink", path);
+    else { buf[n] = 0; ret = JS_NewString(ctx, buf); }
+    JS_FreeCString(ctx, path);
+    return ret;
+}
+
+static JSValue js_fss_readdir(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
+    const char *path = JS_ToCString(ctx, argv[0]);
+    if (!path) return JS_EXCEPTION;
+    DIR *d = opendir(path);
+    if (!d) { JSValue e = throw_errno(ctx, "readdir", path); JS_FreeCString(ctx, path); return e; }
+    JSValue arr = JS_NewArray(ctx);
+    uint32_t i = 0;
+    struct dirent *de;
+    while ((de = readdir(d))) {
+        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
+        JS_DefinePropertyValueUint32(ctx, arr, i++, JS_NewString(ctx, de->d_name), JS_PROP_C_W_E);
+    }
+    closedir(d);
+    JS_FreeCString(ctx, path);
+    return arr;
+}
+
+/* one-path / two-path / path+int syscall wrappers */
+#define FSS_1PATH(NAME, EXPR)                                                            \
+static JSValue js_fss_##NAME(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
+    const char *p = JS_ToCString(ctx, argv[0]);                                          \
+    if (!p) return JS_EXCEPTION;                                                         \
+    JSValue ret = ((EXPR) < 0) ? throw_errno(ctx, #NAME, p) : JS_UNDEFINED;              \
+    JS_FreeCString(ctx, p);                                                              \
+    return ret;                                                                          \
+}
+FSS_1PATH(rmdir, rmdir(p))
+FSS_1PATH(unlink, unlink(p))
+
+#define FSS_PATH_INT(NAME, EXPR)                                                         \
+static JSValue js_fss_##NAME(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
+    const char *p = JS_ToCString(ctx, argv[0]); int m;                                   \
+    if (!p) return JS_EXCEPTION;                                                         \
+    if (JS_ToInt32(ctx, &m, argv[1])) { JS_FreeCString(ctx, p); return JS_EXCEPTION; }   \
+    JSValue ret = ((EXPR) < 0) ? throw_errno(ctx, #NAME, p) : JS_UNDEFINED;              \
+    JS_FreeCString(ctx, p);                                                              \
+    return ret;                                                                          \
+}
+FSS_PATH_INT(mkdir, mkdir(p, (mode_t)m))
+FSS_PATH_INT(access, access(p, m))
+FSS_PATH_INT(chmod, chmod(p, (mode_t)m))
+
+#define FSS_2PATH(NAME, EXPR)                                                            \
+static JSValue js_fss_##NAME(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
+    const char *a = JS_ToCString(ctx, argv[0]);                                          \
+    const char *b = JS_ToCString(ctx, argv[1]);                                          \
+    if (!a || !b) return JS_EXCEPTION;                                                   \
+    JSValue ret = ((EXPR) < 0) ? throw_errno(ctx, #NAME, a) : JS_UNDEFINED;              \
+    JS_FreeCString(ctx, a); JS_FreeCString(ctx, b);                                      \
+    return ret;                                                                          \
+}
+FSS_2PATH(rename, rename(a, b))
+FSS_2PATH(symlink, symlink(a, b))
+
+static const JSCFunctionListEntry fss_funcs[] = {
+    JS_CFUNC_DEF("open", 2, js_fss_open),
+    JS_CFUNC_DEF("read", 3, js_fss_read),
+    JS_CFUNC_DEF("write", 3, js_fss_write),
+    JS_CFUNC_DEF("close", 1, js_fss_close),
+    JS_CFUNC_DEF("stat", 1, js_fss_stat),
+    JS_CFUNC_DEF("lstat", 1, js_fss_lstat),
+    JS_CFUNC_DEF("fstat", 1, js_fss_fstat),
+    JS_CFUNC_DEF("realpath", 1, js_fss_realpath),
+    JS_CFUNC_DEF("readlink", 1, js_fss_readlink),
+    JS_CFUNC_DEF("readdir", 1, js_fss_readdir),
+    JS_CFUNC_DEF("mkdir", 2, js_fss_mkdir),
+    JS_CFUNC_DEF("rmdir", 1, js_fss_rmdir),
+    JS_CFUNC_DEF("unlink", 1, js_fss_unlink),
+    JS_CFUNC_DEF("rename", 2, js_fss_rename),
+    JS_CFUNC_DEF("access", 2, js_fss_access),
+    JS_CFUNC_DEF("symlink", 2, js_fss_symlink),
+    JS_CFUNC_DEF("chmod", 2, js_fss_chmod),
+};
+
+void tjs__mod_fs_sync_init(JSContext *ctx, JSValue ns) {
+    (void)ns;
+    JSValue global = JS_GetGlobalObject(ctx);
+    JSValue obj = JS_NewObject(ctx);
+    JS_SetPropertyFunctionList(ctx, obj, fss_funcs, countof(fss_funcs));
+    JS_DefinePropertyValueStr(ctx, global, "__tjs_fs_sync", obj, JS_PROP_C_W_E);
+    JS_FreeValue(ctx, global);
+}
diff --git a/src/private.h b/src/private.h
index e27ecf5..fd7afe5 100644
--- a/src/private.h
+++ b/src/private.h
@@ -126,6 +126,7 @@ void tjs__mod_engine_init(JSContext *ctx, JSValue ns);
 void tjs__mod_error_init(JSContext *ctx, JSValue ns);
 void tjs__mod_ffi_init(JSContext *ctx, JSValue ns);
 void tjs__mod_fs_init(JSContext *ctx, JSValue ns);
+void tjs__mod_fs_sync_init(JSContext *ctx, JSValue ns);
 void tjs__mod_fswatch_init(JSContext *ctx, JSValue ns);
 void tjs__mod_hashing_init(JSContext *ctx, JSValue ns);
 void tjs__mod_httpclient_init(JSContext *ctx, JSValue ns);
diff --git a/src/vm.c b/src/vm.c
index 673f63f..2d08f25 100644
--- a/src/vm.c
+++ b/src/vm.c
@@ -240,6 +240,7 @@ static void tjs__bootstrap_core(JSContext *ctx, JSValue ns) {
     tjs__mod_ffi_init(ctx, ns);
 #endif
     tjs__mod_fs_init(ctx, ns);
+    tjs__mod_fs_sync_init(ctx, ns);
     tjs__mod_fswatch_init(ctx, ns);
     tjs__mod_os_init(ctx, ns);
     tjs__mod_process_init(ctx, ns);
```

**Before posting:** the header comment at the top of `mod_fs_sync.c` above
already reads "see the accompanying feature-proposal writeup"; the copy of
this patch kept in our own repo still carries an internal repo-path
reference in that same comment line, which must be genericized to match the
version above before this PR is opened.

## API summary

`__tjs_fs_sync` is a global object with these methods (all synchronous,
all throwing a real `Error` with `.code`/`.errno`/`.syscall` set on
failure, mirroring the shape of Node's `fs` errors):

- `open(path, flags)` → fd (`flags` one of `'r'|'w'|'a'|'r+'|'w+'`)
- `read(fd, len, pos)` → `ArrayBuffer` (`pos >= 0` uses `pread`, `pos < 0`
  uses `read` and advances the fd's own offset)
- `write(fd, arrayBuffer, pos)` → bytes written (same `pos` convention,
  `pwrite`/`write`); the second argument must be a real `ArrayBuffer`, not a
  typed-array view
- `close(fd)`
- `stat(path)` / `lstat(path)` / `fstat(fd)` → `{size, mode, mtimeMs, kind}`
  (`kind` is `'file'|'dir'|'symlink'|'other'`; `mtimeMs` is
  `st_mtime * 1000`, whole-second resolution)
- `realpath(path)`, `readlink(path)`, `readdir(path)` (returns an array of
  entry-name strings, `.`/`..` excluded)
- `mkdir(path, mode)`, `rmdir(path)`, `unlink(path)`
- `rename(oldPath, newPath)`, `symlink(target, linkPath)` (POSIX argument
  order)
- `access(path, mode)`, `chmod(path, mode)`

## Validation

We use this patch to back a `node:fs`-compatible CJS shim
(`libexec/node-shim/modules/fs.cjs` in our repo) that layers Node's
familiar `fs.readFileSync`/`fs.writeFileSync`/`fs.statSync`/
`fs.mkdirSync`/etc. surface on top of these primitives in plain JS. Before
this patch, synchronous filesystem access was impossible under tjs (the only
fs API is Promise-based); the smokes below show it now works. Two levels of
validation, both against the patched `tjs` binary:

**Smoke tests** (from our initial smoke tests, run directly against
`__tjs_fs_sync` with no shim layer in between):

```
$ tjs eval 'const f=__tjs_fs_sync; const fd=f.open("/etc/hosts","r"); const ab=f.read(fd,64,-1); f.close(fd); console.log("sync-ok", ab.byteLength>0, f.stat("/etc/hosts").kind, f.realpath("/tmp").length>0)'
sync-ok true file true
```

```
$ tjs eval 'try { __tjs_fs_sync.stat("/nonexistent-xyz") } catch (e) { console.log("err-ok", e.code === "ENOENT", typeof e.errno === "number") }'
err-ok true true
```

**Characterization tests** (from our later fs characterization test suite):
a scripted round-trip
exercising `open`/`read`/`write`/`close`/`stat`/`lstat`/`fstat`/`readdir`/
`mkdir` (including recursive)/`rmdir`/`unlink`/`rename`/`symlink`/`readlink`/
`realpath`/`access`/`chmod` — run once under host Node (`node:fs`) and once
under our shim on the patched `tjs` binary, then diffed byte-for-byte. All
rows matched with zero divergence on the first run once the shim's argument
shapes were checked against the C source (no C-side changes needed after
that check — the primitives' behavior already matched what a Node-shaped
`fs` needs):

```
$ node --test test/node-shim-fs.test.cjs
✔ fs characterization vs host node (588.771666ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

We're happy to discuss scope/placement (core vs. a separate module/addon)
or API shape changes if maintainers are interested in taking this upstream
in some form.
