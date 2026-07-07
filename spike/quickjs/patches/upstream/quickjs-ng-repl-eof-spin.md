# The REPL busy-spins at 100% CPU when stdin is already at EOF

## Problem

When `qjs` enters its interactive REPL (`repl.js`) with stdin already
closed/EOF — for example because it was redirected from `/dev/null`, or
because a pipe's writer end has already exited — the process does not
detect end-of-input and exit. Instead it spins indefinitely at 100% CPU.

`repl.js` registers a read handler on the terminal fd via
`os.setReadHandler(term_fd, term_read_handler)`. On an fd that is already at
EOF, the event loop's poll reports the fd as readable immediately, and
`os.read()` on it returns 0 (the normal, correct EOF signal). But the read
handler doesn't check for that 0-length return and unregister/exit — it
just gets re-armed and the loop repeats: poll says readable, read returns 0,
repeat. We measured roughly 860,000 iterations of this poll+read loop per
CPU-second in our environment.

We found this while investigating an unrelated bug on NetBSD (a `qjs -c`
standalone executable silently falling back to this same REPL instead of
running its embedded bytecode — see our companion report,
`quickjs-ng-js_exepath.md`, in this same patch set). That investigation is
what surfaced this bug, but this bug is independent of platform and
independent of the standalone-executable machinery: it's purely
"interactive REPL entered with EOF'd stdin spins forever." Root-cause
narrative (including a ktrace-derived syscall histogram of the spin) is in
our evidence file `spike/quickjs/results/gate3-netbsd-aarch64.md`, the
"qjs -c standalone spin — root cause (ktrace)" section (~line 184–204) and
the "Diagnosis" section's finding 2 (~line 245).

## Minimal repro

On any platform (we observed it on NetBSD/aarch64, but the code path is not
platform-specific):

```
$ qjs </dev/null
```

Expected: process exits immediately (there is no input to read, so there's
nothing for the REPL to do).

Actual: process hangs, consuming 100% of one CPU core, until killed
externally (SIGKILL/timeout). No output is produced during the spin.

A ktrace of the equivalent standalone-fallback case (functionally identical
loop; see the companion report for why a standalone binary can end up here)
shows a strict two-syscall repeating pattern — one event-loop `poll`-family
call plus one `read` call, back to back, forever, with the `read` always
returning 0:

```
13744575 RET
13744575 CALL
6872195 GIO
6872194
```

(`GIO` here is ktrace's I/O-size record; the counts show exactly two CALL/
RET pairs per GIO pair, i.e. a tight two-syscall loop — 13.74M syscalls
measured in an 8-CPU-second bounded trace.)

## Suggested fix (no patch attached — diagnosis only)

This report is a diagnosis, not a patch — we don't have a proposed fix to
attach. Based on the symptom, the read handler in `repl.js` (or the
underlying C read-handler dispatch, if the check belongs there instead)
needs to treat a 0-length `read()` on the REPL's fd as EOF: unregister the
read handler and either exit the process or fall through to whatever `qjs`
normally does when it has no more input to process. We'd guess the fix is a
small, localized change to that one read callback, but we haven't attempted
it ourselves and don't want to guess at the right place to put it without
maintainer input on the intended REPL-exit-on-EOF behavior (e.g. should it
print anything, what exit code, etc.).

## Validation

We haven't fixed this bug (see above — diagnosis only), so there's no
before/after validation to report for the fix itself. The repro's failure
mode is independently confirmed twice in our evidence: once against a
1.2MB standalone built from the one-line `console.log(1);` script, and once
against an 18MB real application bundle compiled the same way — both spin
identically (11.97M CALL/RET and 5.99M GIO on the bundle trace, same 2:1
ratio as the tiny repro), which is what tells us the spin is in the shared
REPL code path and not something specific to bundle size or content. Full
transcripts and the syscall histograms for both are in
`spike/quickjs/results/gate3-netbsd-aarch64.md`.
