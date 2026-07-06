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
