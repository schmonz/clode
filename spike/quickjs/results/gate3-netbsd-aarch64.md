# Gate 3 — NetBSD/evbarm-aarch64 10.1 guest (qemu + HVF)

Distilled by hand from `vendor/aarch64-console.log` (final run; two earlier
runs' failures are quoted where they are the evidence). Guest driven by
`qemu/run-in-guest.py` + `qemu/guest-build.sh` per `qemu/RUNBOOK.md`.
This target replaced the planned NetBSD/amd64 rung (user decision
2026-07-06): same OS evidence, near-native speed under HVF; ISA diversity
is carried by the mac68k rung.

## HOSTINFO (verbatim)

```
NetBSD arm64 10.1 NetBSD 10.1 (GENERIC64) #0: Mon Dec 16 13:08:11 UTC 2024  mkrepro@mkrepro.NetBSD.org:/usr/src/sys/arch/evbarm/compile/GENERIC64 evbarm
cc (nb3 20231008) 10.5.0
cmake version 4.2.3
```

(cmake 4.2.3, gmake 4.4.1, libffi 3.5.2 from pkgsrc `aarch64/10.1` →
`10.0_2026Q1`; everything else stock NetBSD 10.1 base.)

## Build results

- `qjs-build-exit=0` — quickjs-ng v0.15.1 builds clean on stock NetBSD 10.1
  (base gcc 10.5, pkgsrc cmake). qjs + qjsc both produced.
- `tjs-build-exit=2` — **txiki.js v26.6.0 does NOT build on stock
  NetBSD 10.1.** Three independent walls, hit in sequence:
  1. (configure) wamr's `simde.cmake` FetchContent git-clones at configure
     time; no git in the guest:
     `error: could not find git for clone of simde-populate`
     — worked around by pre-seeding `FETCHCONTENT_SOURCE_DIR_SIMDE`.
  2. (compile, run 2) txiki maps all non-Darwin/Windows/Android systems to
     wamr's "linux" platform; wamr has no netbsd port:
     `posix_memmap.c:254:17: error: too few arguments to function 'mremap'`
     (Linux mremap has 4 args; NetBSD's has 5)
     — worked around with `-DBUILD_WITH_WASM=OFF`.
  3. (compile, final run) `deps/ada` requires C++20 constexpr
     `std::string`, beyond NetBSD 10.1's base g++ 10.5:
     ```
     /root/qjswork/txiki.js/deps/ada/ada.h: In member function 'constexpr std::string_view ada::url::get_pathname() const':
     /root/qjswork/txiki.js/deps/ada/ada.h:7043:10: error: call to non-'constexpr' function 'std::__cxx11::basic_string<_CharT, _Traits, _Alloc>::operator std::__cxx11::basic_string<_CharT, _Traits, _Alloc>::__sv_type() const [with _CharT = char; _Traits = std::char_traits<char>; _Alloc = std::allocator<char>; std::__cxx11::basic_string<_CharT, _Traits, _Alloc>::__sv_type = std::basic_string_view<char>]' [line truncated]
     - 7043 |   return path;
     ```
     — not worked around (would need a pkgsrc gcc 12+ toolchain; out of
     scope for this gate, and itself the finding: txiki's toolchain floor
     is above the NetBSD 10.1 base system).

## PROBE-QJS (verbatim; exit 0)

```
PROBE global.fetch ABSENT
PROBE global.crypto ABSENT
PROBE global.TextEncoder ABSENT
PROBE global.TextDecoder ABSENT
PROBE global.URL ABSENT
PROBE global.URLSearchParams ABSENT
PROBE global.AbortController ABSENT
PROBE global.WebSocket ABSENT
PROBE global.Worker ABSENT
PROBE global.queueMicrotask OK
PROBE global.structuredClone ABSENT
PROBE global.performance OK
PROBE global.setTimeout ABSENT
PROBE global.ReadableStream ABSENT
PROBE global.Blob ABSENT
PROBE runtime.tjs ABSENT
PROBE runtime.node ABSENT
PROBE runtime.qjs-std ABSENT
PROBE exercise.endianness OK le=true be=true f64=true
PROBE exercise.sha256-kat ABSENT no crypto.subtle
PROBE exercise.fileread ABSENT no fs API found
PROBE exercise.spawn ABSENT no spawn API found
PROBE exercise.fetch-tls ABSENT no fetch
PROBE exercise.tty-raw ABSENT no tty API found
PROBE-SUMMARY ok=3 fail=0 absent=21
```

## PROBE-TJS

```
/tmp/gb.sh: ./txiki.js/build/tjs: not found
probe-tjs-exit=127
```

No tjs binary (build failed above); no tjs capability rows for this target.

## MEMORY (verbatim; NetBSD time(1) reports KB, darwin reports bytes)

```
# Gate 3 — memory axis (guest-evbarm)

Bundle: /root/qjswork/cli.cjs (18441695 bytes).

## qjsc parse+compile (source -> bytecode, discarded)
```
$ /root/qjswork/qjs-src/build/qjsc -o /dev/null /root/qjswork/cli.cjs
exit=0
       17.71 real        17.63 user         0.07 sys
    248420  maximum resident set size
```

## qjs run-from-source (crash at first missing API is expected evidence)
```
$ /root/qjswork/qjs-src/build/qjs /root/qjswork/cli.cjs
exit=1
       11.57 real        11.50 user         0.07 sys
    178676  maximum resident set size
```

## control: qjs empty script
```
$ /root/qjswork/qjs-src/build/qjs -e 1
exit=0
        0.00 real         0.00 user         0.00 sys
      2608  maximum resident set size
```

## standalone run-from-bytecode via qjs -c (crash expected)
```
$ /tmp/qjsmem.6356/bundle-exe
exit=1
      300.82 real       112.80 user       187.97 sys
      2772  maximum resident set size
```
```

The standalone row above was bounded by `ulimit -t 300` (see RUNBOOK):
**the `qjs -c` standalone executable SPINS on NetBSD/aarch64** — an
unbounded first run burned >=14 minutes at 100% host CPU before being
killed; darwin exits the same case in ~0.4s. Its RSS (2772 KB) is
essentially the empty-script control (2608 KB) and the burn is 62% system
time — a syscall loop at startup, before any bundle bytecode allocates.
Hypothesis: the self-reading exe-plus-appended-bytecode mechanism of
`qjs -c` misbehaves on NetBSD (read/seek loop), i.e. the run-from-bytecode
SHIP MECHANISM is broken on this platform, not merely slow — a Gate-3
finding in its own right. The run-from-source row (178676 KB) is the
usable NetBSD memory ceiling datum for the parse+run path.

## Wall clock

Full final run — boot, dhcpcd, pkg_add (13-pkg mirror), qjs build+probe,
txiki configure+build attempt, memory axis incl. the 300s bounded spin —
took ~15 minutes under HVF (`-accel hvf -cpu host -smp 2`, 4G). The
abandoned amd64/TCG rung needed ~25 minutes just to install and never got
through pkg_add.

## Divergences vs darwin control (`gate2-probe-darwin-arm64.md`)

- **qjs probe rows: ZERO divergence.** All 24 rows and the summary
  (`ok=3 fail=0 absent=21`) are line-for-line identical to darwin's qjs
  column: same 3 OKs (queueMicrotask, performance, endianness with
  le/be/f64 all true), same 21 ABSENTs with identical detail strings.
- Cross-engine comparisons that don't apply on this target: no node
  control in the guest (not built), and no tjs column (build failed, see
  above) vs darwin's tjs `ok=22 fail=0 absent=2`. The missing tjs column
  IS the divergence: txiki, buildable on darwin with defaults, is not
  buildable on stock NetBSD 10.1.
- Memory axis vs darwin (`gate3-mem-darwin-arm64.md`; units differ,
  KB vs bytes): qjsc compile 248420 KB (~243 MB) vs ~268 MB darwin;
  run-from-source 178676 KB (~174 MB) vs ~208 MB darwin; empty control
  ~2.5 MB both. Same order of magnitude — memory behavior ports.
  Standalone run-from-bytecode: darwin measured at ~80.4 MB (84,344,832 B),
  spins at ~2.7 MB RSS on NetBSD (not a comparable bytecode-memory figure; see above).

## qjs -c standalone spin — root cause (ktrace)

Follow-up run 2026-07-06 (`qemu/run-repro.py` + `qemu/repro-ktrace.sh`,
console log `vendor/repro-console.log`): fresh guest, qjs-ng v0.15.1
rebuilt from the pinned tarball, then two bounded (`ulimit -t 8`) ktraced
runs with stdin at `</dev/null`.

**Minimal repro: YES.** A standalone compiled from `console.log(1);`
(`qjs -c tiny.js -o tiny-exe`, 1,205,026 bytes) spins identically to the
18MB bundle-exe. The bug is in quickjs-ng's standalone bootstrap on
NetBSD, not anything in our bundle.

**Smoking gun — it isn't running the standalone at all.** Both tiny-exe
and bundle-exe printed, before spinning:

```
QuickJS-ng - Type ".help" for help
qjs >
```

That is the interactive REPL banner. The "standalone" fell back to plain
`qjs` argv handling, got no arguments, and entered interactive mode with
stdin already at EOF.

Syscall histogram from the 8-CPU-second tiny-exe trace (verbatim; kdump
record-type field — 41,233,553 kdump lines total):

```
13744575 RET
13744575 CALL
6872195 GIO
6872194
  10 NAMI
   2 EMUL
   1 \".help\"
   1 PSIG
```

13.74M syscalls in 8 CPU seconds, exactly 2 CALLs per GIO — a two-syscall
loop (event-loop poll + `read`) where every `read` on the EOF'd stdin
returns 0 and the REPL's read handler is re-armed forever. The bundle-exe
trace is the same shape (11.97M CALL/RET, 5.99M GIO). Only 10 NAMI
records — all ld.elf_so library opens; the binary never re-opens its own
image to check for the bytecode trailer.

First 20 kdump lines of the tiny-exe trace (verbatim):

```
  2642   2642 ktrace   EMUL  "netbsd"
  2642   2642 ktrace   CALL  execve(0xffffffef9536,0xffffffef8fb0,0xffffffef8fc0)
  2642   2642 ktrace   NAMI  "/root/qjswork/./tiny-exe"
  2642   2642 ktrace   NAMI  "/usr/libexec/ld.elf_so"
  2642   2642 tiny-exe EMUL  "netbsd"
  2642   2642 tiny-exe RET   execve JUSTRETURN
  2642   2642 tiny-exe CALL  mmap(0,0x8000,PROT_READ|PROT_WRITE,0x1002<PRIVATE,ANONYMOUS,ALIGN=NONE>,0xffffffff,0,0)
  2642   2642 tiny-exe RET   mmap 278507956072448/0xfd4d2fc9f000
  2642   2642 tiny-exe CALL  open(0xfffff326c738,0,0xfffff3281590)
  2642   2642 tiny-exe NAMI  "/etc/ld.so.conf"
  2642   2642 tiny-exe RET   open -1 errno 2 No such file or directory
  2642   2642 tiny-exe CALL  open(0xfffffff05cb8,0,0xf)
  2642   2642 tiny-exe NAMI  "/usr/lib/libpthread.so.1"
  2642   2642 tiny-exe RET   open 3
  2642   2642 tiny-exe CALL  __fstat50(3,0xfffffff05ba8)
  2642   2642 tiny-exe RET   __fstat50 0
  2642   2642 tiny-exe CALL  mmap(0,0x1000,PROT_READ,0x1<SHARED,FILE,ALIGN=NONE>,3,0,0)
  2642   2642 tiny-exe RET   mmap 278507956068352/0xfd4d2fc9e000
  2642   2642 tiny-exe CALL  munmap(0xfd4d2fc9e000,0x1000)
  2642   2642 tiny-exe RET   munmap 0
```

### Diagnosis (two stacked upstream bugs)

1. **`js_exepath()` has no NetBSD implementation.** In v0.15.1's
   `cutils.h` the function is implemented for `_WIN32`, `__APPLE__`, and
   `__linux__ || __GNU__`; the trailing `#else` branch is
   `return -1;` — NetBSD (and every other BSD) lands there. `qjs.c`'s
   startup does `if (!js_exepath(...) && is_standalone(...)) standalone = 1;`
   so on NetBSD the trailer check is never reached (consistent with zero
   self-open NAMI records) and the binary behaves as a vanilla `qjs`:
   no argv → interactive REPL. The standalone mechanism silently degrades
   to a REPL on any platform without a `js_exepath` port.
2. **The REPL busy-spins when stdin is at EOF.** `repl.js` registers
   `os.setReadHandler(term_fd, term_read_handler)`; on an EOF'd fd the
   event loop's poll reports readable immediately, `os.read` returns 0,
   and the handler never detects EOF/unregisters — a 100% CPU
   poll+read(→0) loop, ~860K iterations per CPU-second. This is what the
   Gate-3 memory phase measured for 300 CPU seconds (62% sys time,
   ~2.7MB RSS: REPL-sized, bytecode heap never loaded).

The earlier hypothesis (self-read/seek loop in the appended-bytecode
loader) is refuted: the loader never runs.

**Upstream-reportable: YES, both.** (1) is a straightforward portability
gap — NetBSD/FreeBSD/OpenBSD can implement it via
`sysctl(KERN_PROC_PATHNAME)` / `/proc/curproc/exe`, and failing that the
standalone check should probably fall back to `argv[0]` resolution rather
than silently becoming a REPL. (2) is a quality-of-implementation bug
reproducible on any platform with `qjs </dev/null`. For Gate 3 the
practical consequence stands: the `qjs -c` ship mechanism does not work
on NetBSD 10.1 as shipped in v0.15.1, but the fix is small and mechanical
rather than architectural.

## Patch validation (2026-07-06)

Confirms `patches/quickjs-ng-js_exepath-netbsd.patch` fixes the spin
diagnosed above. Fresh evbarm-aarch64 boot (guest disk boots
`snapshot=on`, so the earlier repro run's `/root/qjswork` did not
persist — the driver rebuilt from the pinned tarball fresh), patch
applied with `patch -p1` (both hunks succeeded, exit 0), `cmake --build
build --target qjs -j2` rebuilt cleanly (exit 0). Driver: adapted copy
of `qemu/run-repro.py`, guest script `vendor/validate-patch.sh`
(uncommitted scratch), console log `vendor/validate-console.log`.

**hello-exe** (`console.log("standalone-ok " + 6*7);` compiled via
`qjs -c hello.js -o hello-exe`, then `./hello-exe </dev/null`) —
verbatim:

```
standalone-ok 42
```
Exit 0, no REPL banner, no spin — this previously printed the
`QuickJS-ng - Type ".help" for help` banner and spun at 100% CPU.

**bundle-exe** (the real `cli.cjs`, 18,441,695 bytes, compiled via
`qjs -c cli.cjs -o bundle-exe`, then `/usr/bin/time -l ./bundle-exe
</dev/null`) — verbatim:

```
Possibly unhandled promise rejection: ReferenceError: require is not defined
    at <anonymous> (<evalScript>:2:1)
    at evalScript (native)
    at runStandalone (<null>:0:1)

Possibly unhandled promise rejection: ReferenceError: require is not defined
    at <anonymous> (<evalScript>:2:1)
    at evalScript (native)
    at runStandalone (<null>:0:1)

        0.10 real         0.09 user         0.01 sys
     81296  maximum resident set size
```

Exit 1. This is the North-Star run-from-bytecode measurement Gate 3
couldn't get: the standalone now actually executes its embedded
bytecode (`runStandalone` in the stack trace — proof the trailer path
ran, not the REPL) and fails fast at the first missing Node API
(`require`), matching the darwin/arm64 control's failure mode
(`results/gate2-probe-darwin-arm64.md`) instead of spinning. Peak RSS:
**81,296 KB**, in 0.10s real — a real number, not a spin ceiling.

**Verdict: yes.** The patch converts the spin into correct standalone
execution — `qjs -c` standalones now run their embedded bytecode on
NetBSD/evbarm-aarch64 instead of silently degrading to a busy-spinning
REPL.
