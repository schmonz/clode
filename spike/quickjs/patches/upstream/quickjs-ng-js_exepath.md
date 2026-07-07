# `qjs -c` standalone executables silently fall back to the REPL on NetBSD (and every other unported BSD)

## Problem

`js_exepath()` in `cutils.h` (v0.15.1) is implemented only for `_WIN32`,
`__APPLE__`, and `__linux__`/`__GNU__`; every other platform falls through to
the trailing `#else` branch, which just `return -1;`. `qjs.c`'s startup logic
is:

```c
if (!js_exepath(...) && is_standalone(...)) standalone = 1;
```

so on any platform without a `js_exepath()` port, that check is never
satisfied, and a binary produced by `qjs -c script.js -o exe` — normally a
self-contained executable that runs its appended bytecode — silently
degrades into a plain interactive `qjs` REPL instead. There is no error, no
warning: the binary just starts a REPL. If that REPL's stdin happens to be
closed or redirected from `/dev/null` (e.g. a CI job or any non-interactive
invocation), the process then hits a second, independent bug (see the
companion report `quickjs-ng-repl-eof-spin.md`) and spins at 100% CPU
instead of exiting.

We hit this while testing quickjs-ng's standalone-executable feature on
NetBSD/evbarm-aarch64 10.1 as part of a portability survey for a CLI tool
built on quickjs-ng/txiki.js. Full root-cause narrative, including a ktrace
of the spin and the diagnosis of both stacked bugs, is in our evidence file
`spike/quickjs/results/gate3-netbsd-aarch64.md`, sections "qjs -c standalone
spin — root cause (ktrace)" (~line 164) and "Diagnosis (two stacked upstream
bugs)", finding 1 (~line 236). ("Standalone" here is quickjs-ng's own term
for the `qjs -c`-produced executable that has interpreter bytecode appended
to it and runs it directly, without needing the source file or a separate
`qjs` invocation — that's the feature this bug silently disables.)

## Minimal repro

On any BSD lacking a `js_exepath()` port (verified on NetBSD/aarch64 10.1,
stock base gcc 10.5):

```
$ echo 'console.log("standalone-ok " + 6*7);' > tiny.js
$ qjs -c tiny.js -o tiny-exe
$ ./tiny-exe
QuickJS-ng - Type ".help" for help
qjs >
```

Instead of printing `standalone-ok 42` and exiting, `tiny-exe` prints the
interactive REPL banner and waits for terminal input — the standalone
bytecode is never executed. (If stdin is `/dev/null` at this point, the
process then spins; see the companion report.)

A ktrace of this repro (`spike/quickjs/results/gate3-netbsd-aarch64.md`,
same section) shows exactly zero `NAMI` (path-open) records against the
binary's own executable image — proof the trailer-bytecode check never even
attempts to open/re-read the binary on this platform.

## The fix

Add a NetBSD implementation of `js_exepath()` alongside the existing
`_WIN32`/`__APPLE__`/`__linux__` ports in `cutils.h`, using the
`KERN_PROC_ARGS`/`KERN_PROC_PATHNAME` sysctl for the current process (the
same mechanism libuv's `uv_exepath()` uses for NetBSD), with a
`/proc/curproc/exe` readlink as a fallback for systems that happen to have
`/proc` mounted. This is a self-contained, mechanical portability addition —
no behavior changes on any currently-supported platform.

Patch (`spike/quickjs/patches/quickjs-ng-js_exepath-netbsd.patch` in our
repo; applies cleanly with `patch -p1` from a v0.15.1 checkout):

```diff
--- a/cutils.h
+++ b/cutils.h
@@ -35,6 +35,10 @@
 #if defined(__APPLE__)
 #include <mach-o/dyld.h>
 #endif
+#if defined(__NetBSD__)
+#include <sys/param.h>
+#include <sys/sysctl.h>
+#endif
 #include <stdbool.h>
 #include <stdlib.h>
 #include <string.h>
@@ -1705,6 +1709,42 @@
     *size = n;
 
     return 0;
+}
+#elif defined(__NetBSD__)
+static inline int js_exepath(char *buffer, size_t *size) {
+    /* NetBSD has no /proc by default; the executable path of the current
+       process is exposed via the KERN_PROC_ARGS/KERN_PROC_PATHNAME sysctl
+       (pid -1 == self). Mirrors libuv's uv_exepath() for NetBSD, and is the
+       upstream fix candidate for the portability gap this patch closes. */
+    int mib[4];
+    size_t n;
+
+    if (buffer == NULL || size == NULL || *size == 0)
+        return -1;
+
+    mib[0] = CTL_KERN;
+    mib[1] = KERN_PROC_ARGS;
+    mib[2] = -1;
+    mib[3] = KERN_PROC_PATHNAME;
+
+    n = *size;
+    if (sysctl(mib, 4, buffer, &n, NULL, 0) == 0 && n > 0) {
+        if (n >= *size)
+            n = *size - 1;
+        buffer[n] = '\0';
+        *size = strlen(buffer);
+        return 0;
+    }
+
+    /* fallback: procfs symlink, present only if /proc is mounted */
+    {
+        ssize_t r = readlink("/proc/curproc/exe", buffer, *size - 1);
+        if (r == -1)
+            return -1;
+        buffer[r] = '\0';
+        *size = (size_t)r;
+        return 0;
+    }
 }
 #else
 static inline int js_exepath(char* buffer, size_t* size_ptr) {
```

We'd suggest the same fix, or a `#if defined(BSD)`-style umbrella, likely
also unblocks FreeBSD and OpenBSD, which have the identical
`sysctl(KERN_PROC_PATHNAME)` mechanism and would otherwise hit the same
silent-REPL-fallback behavior. We haven't tested those platforms ourselves,
so we're only submitting the NetBSD-verified port here, but the same
sysctl-based approach should carry over directly if maintainers want it
extended.

We'd also gently suggest that, independent of adding more platform ports,
the standalone-detection failure mode itself might be worth hardening: today
`js_exepath()` returning -1 causes a silent fallback to interactive-REPL
behavior with no diagnostic. A future-proofing option (e.g. falling back to
resolving `argv[0]`, or at minimum emitting a warning to stderr before
entering the REPL) would keep any *future* unported platform from hitting
the same "silently becomes a REPL" surprise this report describes. That's a
separate, smaller suggestion from the sysctl patch above; happy to split it
into its own issue if useful.

## Validation

Runtime-validated on a fresh NetBSD/evbarm-aarch64 10.1 qemu (HVF) guest,
2026-07-06 (see `spike/quickjs/results/gate3-netbsd-aarch64.md`, section
"Patch validation (2026-07-06)"): applied the patch (`patch -p1`, both hunks
applied cleanly), rebuilt `qjs` from the pinned v0.15.1 source
(`cmake --build build --target qjs`, exit 0).

Before the patch, `./hello-exe </dev/null` (built via
`qjs -c hello.js -o hello-exe` from `console.log("standalone-ok " + 6*7);`)
printed the REPL banner and spun. After the patch, same binary:

```
$ ./hello-exe </dev/null
standalone-ok 42
```

Exit 0, no REPL banner, no spin.

We also re-ran this against a real 18MB application bundle compiled the same
way (`qjs -c cli.cjs -o bundle-exe`). After the patch it now actually
executes its embedded bytecode instead of falling back to the REPL — it
fails fast at the first API the bundle uses that isn't present in stock
quickjs-ng (`ReferenceError: require is not defined`, with `runStandalone`
in the stack trace, proving the trailer-bytecode path ran), exiting in
0.10s with peak RSS 81,296 KB, matching the same bundle's failure mode on
Darwin/arm64 instead of spinning for the timeout duration. Full transcript
in the same results file.
