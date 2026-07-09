# Phase 3 — SPARC engine verdict: quickjs-ng v0.15.1 on 32-bit big-endian (gates S0 + S3)

**STATUS: ENGINE VERDICT GREEN** — quickjs-ng v0.15.1 runs *correctly* on
32-bit big-endian NetBSD/sparc 10.1 (qemu sun4m SS-20, TCG), with **two
carried patches** beyond the pin: the existing
`patches/quickjs-ng-js_exepath-netbsd.patch`, plus a NEW two-line
**cpool 8-alignment patch** (root-caused this campaign; see Walls #2 and
Upstream candidates). With both applied, every S3 correctness micro-probe
passes, probe.js is byte-identical to the darwin control, in-guest
bytecode round-trips, and all four S0 RAM rows are measured. RAM ladder
rung (a) run-from-source FITS at 512MB with ~3x headroom; rung (b/c)
run-from-bytecode fits with ~6.5x headroom; even the compile peak (the
largest row, 213MB) fits with ~2.2x.

Distilled from `vendor/sparc-gates-console.log*` (see Run ledger below).
Guest driven by `qemu/run-sparc-gates.py` + `qemu/guest-sparc-gates.sh`
(debug run: `qemu/run-sparc-debug.py` + `qemu/guest-sparc-debug.sh`) per
`qemu/RUNBOOK-sparc.md`. Everything below was measured, not assumed.

## Run ledger (all logs under `vendor/`, all boots `snapshot=on`, image never dirtied)

| Run | Log | What happened |
|---|---|---|
| 1 | `sparc-gates-console.log.run1` | Full gates. Build green (no-cmake recipe, all `-O2`). S3 green EXCEPT s3-4 (`SyntaxError: checksum error`). S0: control + run-from-source measured; compile row blocked by s3-4's cause. |
| 2 | `sparc-gates-console.log.run2` | Regen fix attempt (rebuild `gen/*.c` in-guest). **qjsc SIGBUS (exit 138)** on both regen commands → gen files truncated → qjs unlinkable → no new data. Exposed Wall #2. |
| 3 | `sparc-gates-console.log.run3` | Dedicated debug run (gdb in guest). O2/O0/FNSA matrix; SIGBUS root-caused to file:line:instruction (Wall #2 evidence chain). |
| 4 | `sparc-gates-console.log` | Final full gates with BOTH patches. ALL GREEN; complete S0 table. |

## HOSTINFO / RAMPROBE (verbatim, run-1 = run-4 environment)

```
NetBSD  10.1 NetBSD 10.1 (GENERIC) #0: Mon Dec 16 13:08:11 UTC 2024  mkrepro@mkrepro.NetBSD.org:/usr/src/sys/arch/sparc/compile/GENERIC sparc
cc (nb3 20231008) 10.5.0
[     1.000000] total memory = 495 MB
[     1.000000] avail memory = 480 MB
hw.physmem = 519962624
Device      1K-blocks     Used    Avail Capacity  Priority
/dev/sd0b       32768        0    32768     0%    0
```

S0's first question answered: NetBSD maps essentially all of `-m 512M`
on qemu SS-20 (495MB total / 480MB avail). Note the anita-default swap
is only **32MB** — measurements that exceed RAM have almost no swap
cushion here (none needed; see table). The 1G/2047M `dmesg` visibility
probes were not run (everything fit at 512M); they remain a cheap
boot-only follow-up if headroom is ever needed.

## Build: the no-cmake recipe (S1-lite)

cmake-from-source (est. 4–15h TCG, the toolchain long pole per
RUNBOOK-sparc § 2) was **avoided entirely**: bare qjs/qjsc need none of
it. Recipe derived from CMakeLists.txt on the host, verified on darwin,
then run in-guest with base gcc 10.5 only:

```sh
CFLAGS="-O2 -std=gnu11 -funsigned-char -D_GNU_SOURCE -DQUICKJS_NG_BUILD -DNDEBUG -I."
# lib: quickjs.c libregexp.c libunicode.c dtoa.c  + libc: quickjs-libc.c
# qjsc = qjsc.c + lib;  qjs = qjs.c gen/repl.c gen/standalone.c + lib
cc $CFLAGS -c each.c ... && cc -o qjsc ... -lm -lpthread [+ atomic shim]
```

Guest hardening (both mattered): each compile runs under
`ulimit -v 409600` so gcc fails fast instead of swap-thrashing under TCG
(fallback ladder -O2→-O1→-O0 — never needed: **everything compiled at
-O2**, quickjs.c in 216s guest time); links use a plain→`-latomic`→shim
ladder (see Wall #3 — shim required). Whole build ≈ 4.5 min guest time.
Run-4 build order: objects → link qjsc → **regenerate `gen/repl.c` +
`gen/standalone.c` natively** (`qjsc -ss -o gen/X.c -m X.js`, upstream's
own Makefile commands — see Wall #1) → link qjs.

## S3 — big-endian correctness micro-probes (bare qjs)

All verbatim from run-1 (re-confirmed in run-4); zero BE divergence.

| # | Probe | Result | Evidence |
|---|---|---|---|
| 3.1 | `print(1+1)` | PASS | `2` |
| 3.2 | host order + DataView | PASS | `host-BE=true dv-be-byte0=0x11 dv-le-read=0x44332211` |
| 3.3 | regexp charclass + `/u` + `\p{L}` | PASS | `regexp-ok` |
| 3.3b | `/[\p{L}]/v` (informational) | `false` — **NOT a BE bug**: darwin control build of the same pin also prints `false` (known pin-level v-flag defect, fixed upstream post-pin; same bug phase-3 M1 hit via string-width) |
| 3.4 | in-guest bytecode round-trip (`qjs -c hello.js -o hello-exe && ./hello-exe`) | run-1 FAIL (`SyntaxError: checksum error` — Wall #1), **run-4 PASS** | `bc-ok 42` |
| 3.5 | dtoa / Date / JSON | PASS | `sum=0.30000000000000004`, `now=1783586202649`, `j.a=1e+300` |
| 3.6 | probe.js sweep | PASS, exit 0 | `PROBE-SUMMARY ok=3 fail=0 absent=21` — **byte-identical to the darwin bare-qjs control** (same absents: no fetch/crypto/etc. in bare qjs; `exercise.endianness OK le=true be=true f64=true`) |
| 3.7 | inventory.cjs | SKIPPED — node/tjs-only CommonJS tooling; S2' scope |

## S0 — RAM-fit measurements (`/usr/bin/time -l`, NetBSD units = KB)

Bundle: `cli.cjs` 19,106,804 bytes (2.1.204). 64-bit column:
`results/gate3-mem-darwin-arm64.md` (bundle 2.1.198, 18,441,695 bytes —
slightly smaller; darwin `time -l` reports bytes, converted here).

| Row | sparc32 BE peak RSS | wall (TCG) | darwin arm64 (64-bit) | 32/64 ratio | RUNBOOK est. |
|---|---|---|---|---|---|
| control `qjs --eval '1+1'` | 2,488 KB ≈ 2.4 MB | 0.02s | 2.4 MB | 1.0 | — |
| (a) run-from-source `qjs cli.cjs` | 157,800 KB ≈ 154 MB | 181.9s | 208.3 MB | 0.74 | 115–145 MB |
| (b/c) compile `qjs -c cli.cjs -o exe` | 218,476 KB ≈ 213 MB | 93.0s | 267.9 MB (qjsc parse)¹ | 0.80 | 150–190 MB |
| (b/c) run-from-bytecode `./bundle-exe` | 75,840 KB ≈ 74 MB | 2.4s | 80.4 MB | 0.92 | 45–60 MB |

¹ Frontends differ slightly: the darwin row is `qjsc -o /dev/null`
(parse+compile, output discarded); the guest row is `qjs -c` (parse+
compile+embed into a copy of qjs). Run-1 measured run-from-source at
157,864 KB — 64 KB from run-4's 157,800, i.e. reproducible to 0.04%.

The standalone produced in-guest is 26,568,710 bytes (darwin's was
25.8MB) and its failure mode matches the platform family exactly:
run-from-source dies at `ReferenceError: require is not defined
(cli.cjs:2:1)`; the standalone dies at `Possibly unhandled promise
rejection: ReferenceError: require is not defined` — the same pair
darwin and NetBSD/aarch64 show, and the 75,840 KB peak sits right next
to aarch64's patch-validation 81,296 KB. The parser+startup genuinely
ran to the first missing Node API on 32-bit BE, on all three paths.

**RAM ladder verdict:** rung (a) fits 480MB avail with ~3x headroom —
S4/S5 can run from source. Rung (b/c) fits with more (~6.5x); the
compile peak (largest row) fits with ~2.2x, so BE bytecode production
needs no swap assistance at 512M. Estimate honesty: every bundle row
landed ABOVE its runbook band — run-from-source 154 vs 115–145, compile
213 vs 150–190, run-from-bytecode 74 vs 45–60 (ratio 0.92, not ~0.6).
NAN-boxing halves live JSValues, but these paths are dominated by
source text, bytecode, atoms, and fixed structures that don't scale
with value width; the 32-bit savings shrink as the workload shifts from
values to code. Still comfortably inside budget at every rung.

## Walls ledger (all four root-caused; none open)

1. **LE-baked `gen/*.c` artifacts (run-1, `s3-4`/`s0-compile`).**
   `qjs -c` first does `JS_ReadObject(qjsc_standalone)`; the release
   tarball ships `gen/repl.c`/`gen/standalone.c` as bytecode
   pre-generated on upstream's little-endian 64-bit host (visible in the
   shipped bytes: version `0x1a` then LE checksum `0x64 0x80 0xb9 0x26`).
   The reader's host-order checksum can never match on BE →
   `SyntaxError: checksum error`. **Fix (run-4):** regenerate in-guest
   with the freshly built qjsc — upstream's own commands
   (`Makefile:77-78`): `qjsc -ss -o gen/repl.c -m repl.js`,
   `qjsc -ss -o gen/standalone.c -m standalone.js`.
   Repro (any BE host): build v0.15.1 as shipped, run
   `./qjs -c anything.js -o out`.

2. **JSFunctionBytecode cpool misalignment → SIGBUS (run-2, root-caused
   run-3). The campaign's headline engine bug.**
   Regenerating the gen files made qjsc itself crash: exit 138 =
   128+SIGBUS. Debug-run evidence chain (log `.run3`):
   - Faults at **-O2, -O0, and -O2 -fno-strict-aliasing** alike → source
     bug, not compiler assumption or aliasing UB.
   - Tiny module/script (`export default 1;` / `var x = 1;`) serialize
     fine at every opt level → only faults when `cpool_count > 0`.
   - gdb (O0 build): `SIGBUS ... JS_WriteFunctionTag at quickjs.c:38005`
     = `if (JS_WriteObjectRec(s, b->cpool[i]))`; faulting instruction
     **`ldd [ %g1 ], %g2`** with **`%g1 = 0xedb93b3c`** — 4-mod-8
     address, and sparc `ldd` requires 8-byte alignment.
   - Source: `js_create_function` (quickjs.c:36209) lays out the
     trailing arrays as `cpool_offset = sizeof(*b)` with no rounding.
     On sparc32 every member of `JSFunctionBytecode` is 4-byte, so
     `sizeof(*b) ≡ 4 (mod 8)` and the JSValue (8-byte under
     `JS_NAN_BOXING`) cpool array is *permanently* misaligned.
     `JS_ReadFunctionTag` (quickjs.c:38911) has the identical bug on the
     read side. This is latent UB on **every** 32-bit build (x86 tolerates
     unaligned u64 loads; strict-alignment sparc makes it loud); whether
     a given site faults depends on gcc emitting `ldd` vs two `ld`s —
     which is why the interpreter ran 19MB of cli.cjs while the writer
     died instantly.
   - Method note: `-DJS_NAN_BOXING=1` on a 64-bit host is NOT a valid
     proxy for reproducing this (it SEGVs at context creation because
     64-bit heap pointers don't fit the nan-box payload); the backtrace
     had to come from the guest. UBSan `-fsanitize=alignment` on darwin
     64-bit is clean for the same reason: the 64-bit build has no
     nan-boxed cpool.
   **Fix (run-4):** round `function_size` up to 8 before `cpool_offset`
   at both sites — two lines, in-memory layout only, **zero effect on
   the serialized bytecode format**. Diff (to be moved into
   `patches/` + PINS.md when committing):
   `/private/tmp/claude-502/-Users-schmonz-Documents-shared-trees-clode/92ec4ece-f7b5-447b-a42b-193432ed5ec3/scratchpad/patch-work/cpool-align.diff`
   Host-validated (darwin: engine, regen, standalone, probe unchanged);
   guest-validated in run-4.

3. **No libatomic on NetBSD/sparc base (run-1).** quickjs.c's JS
   Atomics ops on `_Atomic uint64_t` lower to `__atomic_*_8` libcalls on
   sparc32 (not lock-free); NetBSD 10.1/sparc base provides no
   libatomic and plain `-lm -lpthread` and `-latomic` links both fail
   (undefined `__atomic_fetch_add_8` etc. — only `_8` variants missing;
   1/2/4-byte ops resolved natively). Carried workaround: a ~20-line
   pthread-mutex `__atomic_*` shim compiled in-guest
   (`s1-link-variant=shim`) — semantically sound for these
   single-threaded gates; a real tjs/Worker build on this rung should
   revisit (build libatomic, or accept the global-lock shim).

4. **`bc_csum` trailing-window quirk (host source audit; not our bug).**
   The checksum loop exits with up to 4 bytes left but its `switch`
   handles only 0–3: an exact 4-byte remainder is silently excluded from
   the checksum. Symmetric between writer and reader, so harmless
   intra-host — recorded because it surprises anyone reasoning about
   cross-host checksum behavior (e.g. while designing the canonical-LE
   serializer, risk #3c).

## Upstream candidates (strongest first)

1. **cpool-align patch (Wall #2).** Universal latent UB on all 32-bit
   builds, loud SIGBUS on strict-alignment targets (sparc, some MIPS/
   m68k configs), two-line fix, zero bytecode-format impact, complete
   evidence chain (file:line, faulting instruction, 4-mod-8 address,
   O0 reproduction). Ready to file with the run-3 gdb capture.
2. **gen artifacts are endian-specific (Wall #1).** Shipping
   pre-generated bytecode in release tarballs silently breaks every BE
   build of the `qjs` CLI (`-c`, REPL) even where the engine itself is
   fine. Report + suggest regenerating gen/ at build time when
   host-endianness ≠ artifact-endianness (or shipping UINT32_MAX-checksum
   escape-hatch artifacts... which would then hit the format's deeper
   host-order fields — leads to 3).
3. **Canonical-LE bytecode serializer (RUNBOOK-sparc risk #3c).** The
   gen wall is live evidence for it: bytecode is same-endianness-only at
   this pin *by construction* (raw host-order `bc_put_/bc_get_`), which
   forbids host-side bytecode production for BE targets and forced the
   in-guest regen. A writer-swaps-to-LE/reader-swaps-from-LE patch
   contained to `bc_put_*`/`bc_get_*` would re-enable rung (b) host
   production (and make the gen artifacts portable, subsuming 2).

## Reproduction

```sh
# host: stage + launch (server on 8180 serving spike/quickjs)
python3 -m http.server 8180 --directory spike/quickjs &
vendor/venv/bin/python qemu/run-sparc-gates.py   # boots /private/tmp/qemu-anita/anita-sparc/wd0.img snapshot=on
# guest side is fully scripted: qemu/guest-sparc-gates.sh
# debug variant (gdb backtrace matrix): qemu/run-sparc-debug.py + qemu/guest-sparc-debug.sh
```

Markers: `s1-*` build (incl. `s1-patch2-exit`, `s1-regen-*-exit`,
`s1-link-*-variant`), `s3-<n>-*-exit`, `s0-*-exit` + raw `time -l`
blocks, `=== GUEST-DONE ===`; driver exit in `vendor/sparc-gates-exit.txt`.

## What this does NOT cover (by design — stop at the engine verdict)

tjs (S2'), loader boot (S4), mock PONG (S5) — the sparc rung's later
gates. The ada/C++20 toolchain question (NetBSD 11 track) is untouched.
No live network was used; payload came from 10.0.2.2:8180 only. Nothing
was persisted into wd0.img; the S0 bundle-exe artifact was discarded at
halt (re-producible in ~4 min guest time; a persist boot or `nc` export
is needed if a kept BE bytecode artifact ever matters).
