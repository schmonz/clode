# Phase 3 — SPARC S2/S4/S5: full tjs (pure-C wurl config) on 32-bit big-endian

**STATUS: ALL GATES GREEN — S2 (tjs builds), S4 (loader boots), S5 (mock
PONG).** The full patched txiki.js v26.6.0 builds on NetBSD 10.1/sparc
(qemu sun4m SS-20, TCG, 512M) with **base gcc 10.5 only** — no pkgsrc
compiler, no NetBSD 11 — because `patches/txiki-wurl-url.patch` (deps/wurl,
plain C11, `-DTJS_USE_ADA=OFF`) removes the tree's only C++20 (deps/ada).
The clode loader + node-shims boot hello.cjs, and bundle 2.1.204 completes a
mock PONG round-trip (`-p 'say PONG'` → real Messages POST → SSE → `PONG` on
the console) on 32-bit big-endian. One NEW wall was found and fixed en route
(txiki ships LE core bytecode in-tree — Walls #4, upstream candidate), plus
three toolchain-bake walls; all four root-caused, none open.

Distilled from `vendor/sparc-s2a-console.log*` (phase A toolchain bake),
`vendor/sparc-s2a-verify.log` (bake verification), `vendor/sparc-s2b-console.log*`
(phase B gates), `vendor/sparc-s2-mock.log` (host-side S5 oracle). Guest
driven by `qemu/run-sparc-bake*.py` + `qemu/guest-sparc-bake*.sh` (phase A),
`qemu/run-sparc-s2.py` + `qemu/guest-sparc-s2.sh` (phase B),
`qemu/run-sparc-verify.py` (bake checks), `qemu/mock-s2.cjs` (PONG mock,
fixed port 8183). Everything below was measured, not assumed.

## Run ledger (all logs under `vendor/`; persist boots ONLY in phase A, after backup)

| Run | Boot | Log | What happened |
|---|---|---|---|
| A1 | persist | `sparc-s2a-console.log.run1` | gmake 4.4.1 built+installed in ~5 min — as `/usr/local/bin/make` (Wall #1); cmake skipped by the correct gmake-path guard. Clean halt. |
| A-v1 | snapshot | `sparc-s2a-verify.log` | GNU Make 4.4.1 PERSISTED (persist mechanics proven); a-bake-verified=127 as expected. |
| A2 | persist | `sparc-s2a-console.log.run2` | gmake symlink OK; cmake bootstrap OK (1h29m); main build FAILED at the final bin/cmake link — `__atomic_*_8` undefined (Wall #2); unconditional cleanup destroyed the tree (Wall #3). Clean halt. |
| A3 | persist | `sparc-s2a-console.log` | cmake take three: `--no-debugger` + atomic-shim in EXE_LINKER_FLAGS + success-only cleanup. ALL GREEN; `cmake version 3.28.6` installed. |
| A-v2 | snapshot | `sparc-s2a-verify.log` (appended) | **a-bake-verified=0** — gmake + cmake both persisted and run. PHASE A DONE. |
| B1 | snapshot | `sparc-s2b-console.log.run1` | tjs BUILT green in ~31 min — but every invocation exit 134: LE-baked core bytecode (Wall #4). All four gate 134s were this one wall's cascade. |
| B2 | snapshot | `sparc-s2b-console.log` | tjsc-first BE bundle regen (18 arrays) + build + gates. **ALL GREEN.** |

## HOSTINFO (verbatim, B2)

```
NetBSD  10.1 NetBSD 10.1 (GENERIC) #0: Mon Dec 16 13:08:11 UTC 2024  mkrepro@mkrepro.NetBSD.org:/usr/src/sys/arch/sparc/compile/GENERIC sparc
cc (nb3 20231008) 10.5.0
[   1.0000000] total memory = 495 MB
GNU Make 4.4.1          (baked, /usr/local/bin/make + gmake symlink)
cmake version 3.28.6    (baked, /usr/local/bin/cmake)
datasize-now=524288 stacksize-now=16384
```

## Phase A — toolchain bake cost (the one-time toll; persist boots, backup first)

`wd0.img.pristine-10.1` (APFS clone of the installed image) was taken BEFORE
any persist boot and never needed. Toolchain choice: gmake 4.4.1 +
**cmake 3.28.6 from source** (no pkgsrc binaries exist for sparc32; cmake
bootstrap needs only C++11 per its README, so base g++ 10.5 suffices;
3.28 satisfies every cmake_minimum_required in the txiki tree — max 3.18,
mimalloc, built OFF anyway — while staying policy-close to the pkgsrc cmake
4.2.3 that proved this tree on aarch64). cmake built `-O1` (its runtime speed
is irrelevant; tjs configure under the baked cmake took 1m48s).

| Step | Guest wall (TCG) | Marker |
|---|---|---|
| gmake 4.4.1 (configure+build.sh+install) | ~5 min | a-gmake-exit=0 (A1) |
| cmake bootstrap phase | 1h30m (A3; 1h29m in A2) | a-cmake-bootstrap-exit=0 |
| cmake gmake build + install | 3h07m (A3) | a-cmake-build-exit=0, a-cmake-exit=0 |
| WASTED in A2 (failed link + lost tree) | ~4h35m | a-cmake-build-exit=2 |
| **Total phase A (incl. waste + verifies)** | **~9h20m** | a-bake-verified=0 |

## Phase B run 2 — the gates (snapshot=on; 28 min guest wall end-to-end)

Configuration (deliberate divergences vs the aarch64 p3 run called out):
`-DTJS_USE_ADA=OFF` (**wurl** — the campaign's point; aarch64 used ada via
pkgsrc gcc12), `-DBUILD_WITH_FFI=OFF` (**divergence**: sparc32 libffi was
recon-flagged moderate risk and FFI is unused by S4/S5; verified
`BUILD_WITH_FFI` gates mod_ffi.c + find_library entirely, CMakeLists:266;
aarch64 was FFI=ON), `-DBUILD_WITH_MIMALLOC=OFF` + `-DBUILD_WITH_WASM=OFF` +
`-Werror` stripped + simde pre-seeded (same as p3), `-j1` (single TCG vcpu),
`-DCMAKE_MAKE_PROGRAM=/usr/local/bin/gmake` (NetBSD `make` is bmake),
`-DCMAKE_EXE_LINKER_FLAGS=$W/atomic-shim.o` (S0 Wall-#3 shim; covers tjs AND
the in-build tjsc). With ADA+WASM+FFI+MIMALLOC all off the tree is pure C.

| Step | Guest wall | Marker |
|---|---|---|
| fetches (140MB payload et al.) + extract + sanity | ~1m20s | s2-fetch-*=0, greps 1/1/1/1, cpool=2, js-bundles=16 |
| cmake configure (baked cmake 3.28.6) | 1m48s | s2-configure-exit=0 |
| tjsc build + 18-array BE bundle regen | 5m37s | s2-tjsc-exit=0, s2-regen-exit=0 |
| full tjs build (`-j1`, base gcc 10.5) | 17m39s | s2-build-exit=0 |
| tjs binary | 6,380,668 B | (aarch64 p3 same family) |
| S2 engine + wurl probes + S4 loader | ~1s | below |
| S5 mock PONG (bundle 2.1.204 boot→POST→SSE→render) | 66s | s5-pong-exit=0 |

### S2 — engine + wurl-on-BE evidence (verbatim)

```
spawn_sync: function fs_sync: object                       s2-engine-exit=0
wurl-basic https: user example.com 8443 /p/q ?x=1&y=2 #frag
wurl-punycode xn--bcher-kva.example
wurl-punycode-snowman xn--n3h.example
wurl-params https://h.example/a?b=c&k=v+v
wurl-idna-reject LOUD: TypeError: Invalid URL
wurl-probe-ok                                              s2-wurl-url-probe-exit=0
```

wurl on 32-bit BE: full component parse, TWO punycode conversions
(bücher→xn--bcher-kva, U+2603→xn--n3h — the snowman was verified ALLOWED in
idna_allow.h on the host first; a U+2603-reject oracle would have been a
false failure), URLSearchParams round-trip with `+` encoding, and the loud
L1' reject on U+200D ZWJ (verified REJECTED in the bitmap) — byte-identical
to the darwin control build (build-s2ctl) run before the guest cycle.

### S4 — loader boots hello.cjs (verbatim)

```
s4-hello-ok linux a/b string                               s4-loader-exit=0
```

require('os')/require('path')/process under node-shim/loader.cjs on BE.
(`os.platform()` reporting `linux` is a known node-shim mapping artifact,
platform-independent, not a gate issue.)

### S5 — mock PONG (guest + host oracles)

Guest console: the bundle booted under
`tjs run node-shim/loader.cjs cli.cjs -p 'say PONG'`
(ANTHROPIC_BASE_URL=http://10.0.2.2:8183, dummy key, TERM=vt100) and printed
**`PONG`** followed by TUI teardown escapes; `s5-pong-exit=0`. 22:57:18 start
→ 22:58:13 HEAD preflight → 22:58:22 POST → 22:58:24 done (66s, TCG).

Host mock log (`vendor/sparc-s2-mock.log`): exactly one guest POST —
`POST /v1/messages?beta=true` with the real request body
(`"model":"claude-opus-4-8"`, user content `say PONG` + system-reminder),
preceded by its `HEAD //` preflight; mock answered the canned SSE
(message_start → text_delta "PONG" → message_stop). No live network:
payloads from 10.0.2.2:8180, API traffic to 10.0.2.2:8183 only.

## Walls ledger (all four root-caused; none open)

1. **GNU make installs as `make`, not `gmake` (A1).** Plain
   `./configure --prefix=/usr/local` → `/usr/local/bin/make`; the cmake
   stage's explicit-path guard `[ -x /usr/local/bin/gmake ]` correctly
   failed. (The same log's `a-gmake-version-exit=0` was pipe masking —
   `cmd | head` reports head's status; later markers avoid pipes.) Fixed
   with a symlink (A2); PINS.md caveat: use `--program-prefix=g`.
2. **cmake 3.28.6 hits the no-libatomic wall itself (A2).** Final
   `bin/cmake` link: undefined `__atomic_fetch_add_8/_sub_8`, every
   referencing object in cmDebugger*/cmcppdap (cmake's DAP debugger, 64-bit
   atomics → libcalls on sparc32; NetBSD base has no libatomic — the S0
   campaign's Wall #3 resurfacing in the toolchain). The bootstrap-phase
   cmake linked fine (debugger not in the bootstrap subset); the full binary
   died at 100%, after ~3h05m of compiling. Fix (A3):
   `./bootstrap --no-debugger` (first-class flag, verified in the 3.28.6
   bootstrap script; drops both offenders) + belt-and-suspenders
   `-DCMAKE_EXE_LINKER_FLAGS=atomic-shim.o`.
3. **Process wall (A2, self-inflicted):** unconditional CLEANUP deleted the
   failed ~4.5h build tree before halt — relink-only recovery impossible.
   A3 cleans up only on `a-cmake-exit=0`.
4. **txiki ships LE host-order core bytecode in-tree (B1) — the quickjs
   `gen/*.c` wall (S0 Wall #1) ONE LAYER UP.** tjs builds green but EVERY
   invocation exits 134: `SyntaxError: checksum error` →
   `src/vm.c:484 TJS_NewRuntimeInternal` assert on `tjs__polyfills` → abort.
   `src/bundles/c/**` (5 core arrays compiled via CMakeLists:160-164 + 13
   more `#include`d by src/builtins.c: internal/path + 12 stdlib) are qjsc
   bytecode pre-generated on upstream's LE host; the reader's host-order
   checksum can never match on BE. aarch64 (LE) never saw it. Fix (B2):
   the plain-JS bundles are NOT shipped (distclean artifacts) → host
   esbuild's all 16 (checkout's own esbuild, exact Makefile rules; text =
   endian-neutral, staged in the tarball), guest builds the `tjsc` target
   first (src/qjsc.c + libqjs, EXCLUDE_FROM_ALL, bundle-free) and
   regenerates ALL 18 arrays natively (= BE) with the Makefile's exact
   flags (`-m -s -o … -n <tjs:name> -p tjs__[internal_]`), then the normal
   build proceeds. The regen itself is enabled by the cpool-align patch —
   without it the BE bytecode WRITER SIGBUSes (S0 Wall #2). Pipeline was
   host-validated on a darwin control build (build-s2ctl) before the guest
   cycle. Note for estimate honesty: B1 also corrected the S2 build-time
   band — ~31 min actual vs the 4-12h estimate, which was calibrated on
   cmake's C++; plain C under TCG is fast.

## Upstream candidates (adds to the engine-verdict batch)

1. **txiki: BE hosts can't run any shipped tjs** (Wall #4). Suggest
   regenerating src/bundles/c at build time when host endianness ≠ artifact
   endianness (the Makefile machinery exists; the cmake path consumes the
   baked files as-is), or land the canonical-LE bytecode serializer
   (engine-verdict candidate #3) which fixes this for free.
2. cmake (informational): `--no-debugger` is the documented escape hatch for
   targets without libatomic/64-bit atomics; nothing to file.

## What this proves for the North Star

The 32-bit big-endian rung now covers the FULL stack, not just the engine:
quickjs-ng v0.15.1 (S0/S3, engine verdict) → txiki.js v26.6.0 pure-C
(S2) → clode loader + node-shims (S4) → the real 19MB bundle 2.1.204
speaking the Messages SSE protocol end-to-end (S5) — all on big-endian,
all with base-OS toolchain only, with wurl standing in for ada at zero
URL-behavior divergence in the gates exercised.

## What this does NOT cover (by design)

Live network/TLS (mock only, PROBE_NET=0 posture), the agentic Bash-tool
probe (needs bash; no pkgsrc for sparc32), FFI (built OFF — divergence),
Workers/threads under the global-lock atomic shim, memory-axis measurements
beyond the S0 campaign, interactive TUI. The `-smp 2`/`-j2` MTTCG experiment
is future work (below).

## Future work / notes (not exercised this campaign)

- **-smp 2 / -j2 experiment (user question 2026-07-09, host probe answered):**
  `qemu-system-sparc -M SS-20 -smp 2 -accel tcg,thread=multi` (qemu 11.0.1)
  starts WITHOUT the "Guest not yet converted to MTTCG" warning — sparc32
  appears MTTCG-capable, so two vCPUs would map to two real host threads.
  Remaining obstacles: NetBSD/sparc GENERIC is uniprocessor (MP is the
  separate GENERIC.MP kernel — swap in-guest or via -kernel), and the recon
  caveat that NetBSD MP on emulated sun4m is historically shaky
  (RUNBOOK-sparc §1 #9). Shape: bounded S1-style experiment for a FUTURE
  bake/build cycle; the recurring win would be Phase-B-class tjs rebuilds
  (-j2), not the one-time cmake toll (now paid and baked). This campaign
  stayed single-vcpu `-j1` per runbook.

## Reproduction

```sh
# host: server on 8180 (loopback) serving spike/quickjs + PONG mock on 8183
python3 -m http.server 8180 --bind 127.0.0.1 --directory spike/quickjs &
node spike/quickjs/qemu/mock-s2.cjs &            # writes vendor/dist/s2-ports.env
# phase A (ONE-TIME, already baked into wd0.img; backup wd0.img.pristine-10.1 FIRST):
vendor/venv/bin/python qemu/run-sparc-bake3.py   # persist boot
vendor/venv/bin/python qemu/run-sparc-verify.py  # snapshot=on; expect a-bake-verified=0
# phase B (repeatable):
vendor/venv/bin/python qemu/run-sparc-s2.py      # snapshot=on
# payload staging (already in vendor/dist/): txiki-v26.6.0-s2.tar.gz is the
# PATCHED checkout (cpool-align applied to deps/quickjs, deps/wurl present)
# PLUS src/bundles/js/** (host-esbuild'd; see guest-sparc-s2.sh header),
# s2-runtime.tar.gz, cli.cjs (2.1.204), simde-v0.8.2.tar.gz, s2-ports.env,
# srcpkgs/{make-4.4.1,cmake-3.28.6}.tar.gz.
```

Markers: `a-*`/`a2-*`/`a3-*` (bake), `s2-*` (build+probes), `s4-loader-exit`,
`s5-pong-exit`, `=== GUEST-DONE ===`; driver exits in
`vendor/sparc-s2a-exit.txt` / `sparc-s2b-exit.txt` /
`sparc-s2a-verify-exit.txt`.
