# qemu guest runbook — NetBSD/sparc on sun4m (32-bit BIG-ENDIAN rung) — DRAFT (recon 2026-07-09)

This rung replaces **mac68k as the entire 32-bit big-endian axis** of the
North Star. mac68k is BLOCKED at boot (qemu's q800 `-kernel` speaks only
the Linux/m68k boot protocol; NetBSD needs the ROM-locked MacBSD Booter —
`results/gate3-netbsd-mac68k.md`, RUNBOOK.md § mac68k), and that result
file explicitly named NetBSD/sparc-on-sun4m (OpenBIOS, ROM-free, serial,
anita-supported) as the retarget. sun4m is also one of qemu's oldest and
most stable emulations — per user decision 2026-07-09 this rung is
**32-bit sparc/sun4m, NOT sparc64/sun4u** (sun4u is not a stable NetBSD
qemu guest; a sparc64 recon appendix survives as a footnote at the end).

Companion to RUNBOOK.md (aarch64/amd64): only differences are spelled out.
**Do not touch the sibling aarch64 rung's dirs**
(`/private/tmp/qemu-anita/anita-aarch64`, its logs, port 8080). sparc uses
`/private/tmp/qemu-anita/anita-sparc` and port **8180**.

## 0. Verified ingredients (checked live on this host, 2026-07-09)

| Ingredient | Status | How verified |
|---|---|---|
| qemu-system-sparc | `/opt/pkg/bin/qemu-system-sparc` (qemu 11.0.1). Machines: SS-5 (default), SS-10, SS-20, SS-600MP, LX, Classic, … | `-M help` |
| RAM ceilings | **SS-5: 256MB hard max** (`Too much memory ... maximum 256`). **SS-10/SS-20/SS-600MP: accept `-m 512M`, `-m 1G`, even `-m 2047M`** (qemu starts; whether NetBSD maps >512MB is an S0 probe — real SS-20s topped out at 512MB) | live `-m` starts |
| anita 2.18 sparc | **Supported — sparc is anita's classic target.** `arch_props['sparc']` = qemu-system-sparc, scratch disk `sd1c` (SCSI), default mem 64M. ISO-install only (`check_arch_supported`: sparc must install from ISO). sysinst has sparc-specific expect branches (no keyboard-type question, group-24 md handling, sparc halt). Entropy prompt fed from host `/dev/random` (`provide_entropy`) | anita.py lines 79-84, 444, 1898, 2369, 2463, 1530 |
| Install ISO | `https://cdn.netbsd.org/pub/NetBSD/images/10.1/NetBSD-10.1-sparc.iso` — HTTP 200, 337,838,080 bytes (the `NetBSD-10.1/images/` path 302s here) | curl -I |
| pkgsrc binaries for sparc | **NONE. ZERO packages.** `.../pkgsrc/packages/NetBSD/sparc/` exists but is EMPTY on both cdn and ftp (contrast sparc64: full 10.0_2024Q3 + 10.0_2026Q1 trees incl. gcc12). No binary cmake, gmake, libffi, or gcc12 for 32-bit sparc, any quarter | curl directory listings |
| NetBSD 11.0 | At RC6; **sparc port present** in `NetBSD-11.0_RC6/`; NetBSD 11 moves **base GCC to 12 (12.5 imported), explicitly including sparc** — a base-toolchain path to C++20 for deps/ada | CDN listing; netbsd.org changes-11.0 |
| quickjs-ng pin | txiki v26.6.0 vendors quickjs-ng **v0.15.1** (deps/quickjs/quickjs.h QJS_VERSION 0.15.1) | local grep |
| 32-bit JSValue | v0.15.1: `JS_NAN_BOXING 1` when `INTPTR_MAX < INT64_MAX` — **8-byte JSValue on sparc32** (vs 16-byte struct on 64-bit) | quickjs.h:155-158 (vendored + tag) |

## 1. Risk table (ranked; each row cites its verification and names its probe)

| # | Risk | Evidence today | Probe / mitigation |
|---|---|---|---|
| 1 | **RAM ceiling (32-bit)**. 64-bit gate-3 peaks: qjsc compile **267.9MB**, run-from-source **208.3MB**, run-from-bytecode **80.4MB** (`results/gate3-mem-darwin-arm64.md`). With NAN boxing halving JSValue (but source text/bytecode/strings unchanged), 32-bit estimate ≈ 0.55–0.7×: compile ~150–190MB, run-from-source ~115–145MB, run-from-bytecode ~45–60MB. Against SS-20 @512MB (~470MB usable): **all three plausibly fit, incl. run-from-source**. Against SS-5 @256MB: run-from-source likely fits (~215MB usable), compile is marginal → swap-assisted (swap thrash costs wall-clock under TCG but disk is host-SSD-backed; CPU emulation stays the bottleneck) | qemu -m probes; gate3 numbers; quickjs.h NAN boxing | **Gate S0 measures, never assumes** (below). Use SS-20; probe `-m 512M`→`1G`→`2047M` visibility in `dmesg`. The RAM LADDER (§ 5) orders fallbacks |
| 2 | **quickjs-ng v0.15.1 on 32-bit big-endian — tested NOWHERE upstream as a combination.** Dimensions separately: 32-bit x86 (LE) is in CI **with test262**; big-endian is 64-bit-only ad hoc (maintainer s390x Docker after PR #1418; Fedora packages it on s390x). CI at the v0.15.1 tag has **no BE target at all** (ci.yml: x86/x64/arm64/riscv64/wasm/BSDs). History: cross-endian bytecode support **removed** in PR #1412 (2026-03, "may or may not still be possible to run on BE, no longer guaranteed"); native-BE build broke instantly (#1417 "checksum error") and was fixed by #1418, which IS an ancestor of v0.15.1 (compare API). 32-bit+BE adds NAN-boxing on BE — value ops are uint64 arithmetic (endian-neutral by construction) but zero test coverage | GitHub #1412/#1417/#1418/#1376/#1410/#1237; ci.yml@v0.15.1; releases + compare API | Gate S3 micro-probes (below) run on bare `qjs` BEFORE any tjs work; a failure here re-plans the rung before hours are spent. sparc32's strict alignment turns latent unaligned-access bugs into loud SIGBUS (a finding with a backtrace, not a corruption) |
| 3 | **Bytecode is same-endianness-only at our pin** (coordinator-verified in vendored source: bc_put_/bc_get_ are raw host-order memcpy; no swap path in the reader; `JS_WRITE_OBJ_BSWAP(0)`'s "handled transparently" comment is misleading — the quickjs.c bswap code is TypedArray handling). **Upstream has NOT fixed this since the pin**: master quickjs.c still raw `dbuf_put_u32` in bc paths; the only PR touching this space since 2026-06 is the regexp-engine port (#1548, unrelated) | local vendored-source audit (coordinator); master fetch + PR search 2026-07-09 | (a) All bytecode consumed on sparc must be PRODUCED on sparc (in-guest qjsc/`qjs -c`); never ship host LE bytecode. (b) 64→32-bit same-endian portability (leb128 + u32 atoms) looks fine on paper — **verify in-gate, don't assume** (S3.4b). (c) Upstream-candidate patch this project could carry: canonical-LE serializer (writer swaps to LE, reader swaps from LE on BE hosts; contained to bc_put_*/bc_get_*) — would re-enable host-side bytecode production and rung (b) of the RAM ladder |
| 4 | **No pkgsrc binaries for sparc → toolchain must be built from source in-guest (TCG!) or avoided.** gcc12 from source under TCG = days → effectively off the table on 10.1. deps/ada (C++20 constexpr std::string; base g++ 10.5 can't) is `add_subdirectory`'d + `target_link_libraries(tjs PUBLIC ada)` **unconditionally — no skip flag** (CMakeLists.txt:304-305); ada backs src/url.c (`ada_c.h`), i.e. the URL/URLSearchParams globals — load-bearing for the bundle (fetch, import-map, ws). Patch-out = swap in a JS URL polyfill or an older C++17 ada (2.x) — moderate, assess-only | CDN listings; vendored CMakeLists + src/url.c; aarch64 M4 precedent | **Primary: NetBSD 11.0(_RC6→release) guest — base gcc 12.5 compiles ada with NO pkgssrc compiler.** Then only gmake→cmake→libffi need in-guest source builds (gmake ~0.5–1.5h, libffi ~0.5–1h, cmake **the long pole, C++ bootstrap, est. 4–15h TCG**, all one-time → bake into image via a persist boot). Secondary options, assess-only: older-ada swap; URL-polyfill patch-out; host cross-compile via NetBSD build.sh tools (compiles C fine, but tjs's build-time core bytecode would be LE → blocked on risk #3's LE-canonical patch, or regenerate core bytecode in-guest) |
| 5 | **quickjs-ng alone (for S0–S3) needs only cmake + base gcc 10.5** — proven combo on the aarch64 rung's guest-build.sh; no ada, no gcc12. So the engine gates don't wait on the ada story at all | guest-build.sh precedent | Build order in-guest: gmake → cmake → quickjs-ng. Run S0/S3 on bare qjs/qjsc; tjs enters at S2' |
| 6 | **libffi on NetBSD/sparc (32-bit)**: upstream README lists SPARC (v8) for Linux/Solaris only — no *BSD-sparc32 row; and no pkgsrc binary to prove it here (sparc64 had one; sparc doesn't) | libffi README; CDN | Build from source at S2'; if it fails, `-DBUILD_WITH_FFI=OFF` (tjs FFI module unused by our shims/probes) |
| 7 | **libuv on NetBSD/sparc**: NetBSD is supported (community tier); no sparc-specific code paths; but zero binary-pkg evidence for sparc32 (unlike sparc64's libuv-1.48.0) | libuv docs; CDN | S2' compile+link; S4/S5 exercise loop/pipes/spawn |
| 8 | **Our nine patches** (`spike/quickjs/patches/`): audited 2026-07-09 — byte-stream I/O, string sysctls, #ifdef guards; **zero endian/bswap/struct-punning hits**. Arch-sensitive: `posix_spawn_file_actions_addchdir_np` availability (OS-level, shared with aarch64 leg, PINS.md caveat); `txiki-netbsd-portability.patch` is arch-independent NetBSD fixes and applies unchanged | grep audit; PINS.md | S2' compile + S4 execution |
| 9 | **qemu sun4m stability**: mature/ancient emulation, OpenBIOS boots NetBSD from CD ROM-free over serial; anita's original target. Residual: NetBSD-on-SS-20-model quirks vs SS-5, `-smp` >1 (qemu accepts; NetBSD MP on qemu sun4m historically shaky) | qemu docs/history; anita design | Install runs on SS-20 @512M (today's kickoff); if sysinst wedges, retry `-M SS-5 -m 256M` (most-trodden path). Treat `-smp 2` as an S1 experiment only; plan `-j1` |
| 10 | **NetBSD 11.0 is an RC** (RC6): sysinst dialogue drift vs anita 2.18, RC bugs | CDN listing | Only affects the S2'+ (ada) track; 10.1 track is unaffected. gson tests anita against HEAD continually; verify with the actual install when that track starts |

## 2. Time/cost estimate (single-vcpu TCG sun4m on this M-series host; aarch64 baseline ≈ 21 min total under HVF)

TCG ≈ 15–40x slower than native per core, minus sun4m's small-machine
overheads; sparc32 code is compact. Orders of magnitude:

| Step | aarch64 (HVF) | sparc/sun4m (TCG) | Once-only? |
|---|---|---|---|
| ISO download | ~1 min | ~2–4 min (322 MiB, host net) | once |
| anita install (full sysinst from CD) | ~2 min (image dd) | **~1–3 h** | **once** — wd0.img persists; boots are snapshot=on |
| Boot to login | ~30 s | ~2–5 min | per run |
| gmake+libffi from source | (pkg_add: minutes) | ~1–2.5 h | once (bake via persist boot) |
| cmake from source | (pkg_add: ~1 min) | **~4–15 h — the toolchain long pole** | once (bake) |
| quickjs-ng build (base gcc) | ~5 min | ~1–3 h | per iteration unless baked |
| S0 memory measurements | ~2 min | ~20–60 min (incl. one swap-assisted qjsc compile of the bundle) | per S0 |
| tjs build (11.0 track, base gcc12) | ~10–15 min `-j2` | **~4–12 h `-j1`** | per S2' iteration |
| **Engine verdict (S0+S3, no tjs)** | — | **~1 day wall-clock incl. one-time toolchain** | |
| **Full pass to S5** | ~21 min | **~2–3 days wall-clock, mostly unattended** | |

Snapshot/bake levers (the whole strategy): (1) install once; (2) ONE
`persist=True` boot to bake gmake/cmake/libffi (+extracted, patched
sources) into wd0.img; (3) keep `snapshot=on` for all gate runs so a
crashed run never dirties the image; (4) artifacts produced in-guest
under snapshot=on are DISCARDED at exit — anything worth keeping
(measurements, an S0 bundle-bytecode artifact) must be copied out
before halt via guest→host TCP (the one reliable slirp path), e.g.
`nc 10.0.2.2 8181 < artifact` against a host-side `nc -l` — or produced
during a persist boot.

## 3. Media + staging

```sh
# dist tarballs + cli.cjs bundle: RUNBOOK.md § 2 (already in vendor/dist/).
# NO pkgsrc mirror possible (no sparc binaries exist) — instead stage
# toolchain SOURCE tarballs for the guest (fetch pinned versions once):
mkdir -p spike/quickjs/vendor/dist/srcpkgs
#   gmake (gnu.org), cmake (cmake.org), libffi (github) — record exact
#   versions in PINS.md when chosen. Serve as usual:
find spike/quickjs/vendor/dist -name '._*' -delete
python3 -m http.server 8180 --directory spike/quickjs \
  > spike/quickjs/vendor/http-server-sparc.log 2>&1 &
```

## 4. Install (one-time; kicked off 2026-07-09, see § 8)

Workdir on LOCAL disk (NFS byte-range-lock lesson, RUNBOOK.md § 4):

```sh
WORK=/private/tmp/qemu-anita/anita-sparc
mkdir -p "$WORK"
nohup sh -c 'spike/quickjs/vendor/venv/bin/python \
    spike/quickjs/qemu/install-sparc.py; \
  echo driver-exit=$? > spike/quickjs/vendor/sparc-install-exit.txt' \
  > /dev/null 2>&1 &
# console log: spike/quickjs/vendor/sparc-install-console.log
```

`install-sparc.py` (this dir, uncommitted phase-1 tooling like the rest):

- `anita.Anita(anita.ISO('https://cdn.netbsd.org/pub/NetBSD/images/10.1/NetBSD-10.1-sparc.iso'), workdir=WORK, disk_size='8G', memory_size='512M', vmm_args=['-M','SS-20'])`
  — **no `-smp`**; SS-20 because SS-5 hard-caps at 256MB and S0 needs
  headroom. anita ISO-dist auto-downloads the ISO into the workdir.
- `a.install()` only (boots the CD via `-boot d`, drives sysinst over the
  `-nographic` serial console, feeds the entropy prompt, halts).
- stdout+stderr dup2'd to the console log; 12h SIGALRM watchdog kills
  qemu instead of hanging forever (RUNBOOK.md wedge lesson).
- Idempotent; after a FAILED install `rm "$WORK/wd0.img"` before retry.
- Fallback if sysinst wedges under SS-20: retry `-M SS-5`,
  `memory_size='256M'` (image remains portable across sun4m models).

## 5. The RAM ladder (cheapest rung first — S0 decides where we stand)

64-bit measured / 32-bit estimated peaks vs budget (SS-20 @512M ≈ ~470MB
usable; @256M ≈ ~215MB usable):

- **(a) run-from-source** — needs the full parse peak (~115–145MB est).
  If S0 says it fits: simplest path, all gates run from source.
- **(b) run-from-bytecode** (STRIP_SOURCE|STRIP_DEBUG) — ~45–60MB est;
  parser never runs on target. Bytecode must be BE → produced either by
  ONE swap-assisted in-guest qjsc compile (peak ~150–190MB est; S0b
  measures; artifact must be exported to the host or made in a persist
  boot — snapshot=on discards it) or by a host qjsc once the
  canonical-LE serializer patch (risk #3c) exists.
- **(c) bytecode in the executable as file-backed .rodata** (`qjs -c`
  self-embedding — the measured 80.4MB/64-bit path; NB `qjsc -o` only
  emits C source, `qjs -c FILE -o OUT` emits the ready binary, see
  gate3-mem notes) — demand-paged clean pages the VM can evict:
  bytecode effectively leaves the RAM budget. This is also the
  project's "self-attesting executable" end state.
- **(d) bundle carving** (`libexec/bundle-carve.cjs`) to a headless
  profile — shrinks the 19MB input before any of the above.

Gate results map: (a) fits → S4/S5 run from source. Only (b/c) fit →
S4/S5 must run the standalone path and S0b's export mechanics become
part of the rung. Nothing fits even at 2047M → carve (d) and re-run S0.

## 6. STAGED GATES (S0 first; stop after S5)

- **S0 — RAM-fit probe (NEW, before everything).** Boot installed image
  with `-M SS-20 -m 512M` (then 1G, 2047M): does `dmesg` show the RAM?
  Then with the in-guest quickjs-ng build (S1-lite toolchain: gmake→
  cmake→qjs, base gcc 10.5): `/usr/bin/time -l qjs --eval '1+1'` control;
  `time -l qjs cli.cjs` (run-from-source peak, ladder rung a);
  `time -l qjs -c cli.cjs -o /tmp/exe` (compile peak, S0b, rung b/c);
  `time -l /tmp/exe` (run-from-bytecode peak). Record 32-bit numbers
  against the 64-bit table; pick the ladder rung. (ulimit -t guard +
  `sh -x` keepalive, per RUNBOOK.md memory-phase lesson.)
- **S1 — guest boots + toolchain present.** dhcpcd -w, ping 10.0.2.2,
  fetch source tarballs from :8180, build gmake→cmake→libffi, `cc
  --version`/`cmake --version` recorded; then ONE persist boot to bake.
  *Probes: sun4m stability, slirp, source-toolchain viability.*
- **S2 — tjs builds.** On the NetBSD 11.0 track (base gcc12) — or 10.1 +
  whichever ada answer § 1 #4 lands on. guest-m4.sh pattern, `-j1`, all
  nine patches (GNU `patch -p1 --forward` from pristine),
  `-DBUILD_WITH_WASM=OFF` (wamr: no NetBSD or sparc port),
  `-DBUILD_WITH_MIMALLOC=OFF`, strip `-Werror`, simde pre-seeded.
  *Probes: libffi/libuv/ada on sparc32; addchdir_np branch.*
- **S3 — engine sanity + BE probes** (bare qjs first — available at S0;
  re-run under tjs once S2 passes):
  1. `qjs --eval 'print(1+1)'` — if 32-bit-BE quickjs-ng is broken this
     fails before anything else matters.
  2. Endianness self-check: `new Uint8Array(new Uint16Array([1]).buffer)[0]===0`
     (must be true = BE) + DataView LE/BE reads disagree correctly.
  3. Regexp with char classes + unicode (`/[a-z]+/u`) — the historically
     BE-buggy lre paths (#1376/#1410).
  4. Bytecode round-trip IN-GUEST (`qjs -c` hello → runs). **4b:** run a
     sparc-compiled bytecode artifact under the 64-bit aarch64 guest or
     darwin qjs and vice versa? NO — cross-endian is unsupported by
     design; instead verify 64→32 SAME-endian portability is untested
     territory we don't rely on (all bytecode stays in-guest).
  5. dtoa/Date/JSON spot checks: `(0.1+0.2).toString()`, `Date.now()`,
     `JSON.parse('{"a":1e300}')`.
  6. probe.js + inventory.cjs full sweep; diff vs darwin control
     (`results/gate2-probe-darwin-arm64.md`) — every divergence is a
     finding.
- **S4 — loader boots a trivial script** (clode loader + node-shims,
  hello.cjs, no network). *Probes: sync-fs/sync-spawn execution on BE.*
- **S5 — mock PONG** (offline mock-transport subscription echo, same
  fixture as the aarch64 M4 leg, PROBE_NET=0 posture). STOP — no live
  network, no full bundle boot, no memory-axis beyond S0 in this phase.

## 7. Driver changes vs run-in-guest.py (when gates start; do NOT edit it while the aarch64 rung is mid-run)

```python
# ARCHES row (TCG budgets ~mac68k-class, not aarch64):
'sparc': ('<ISO URL>', '8G', '512M', 3600, 86400, None),  # pkgarch None: no binary pkgs
# dist: anita.ISO(url), not anita.URL (sparc is ISO-only)
# vmm_args: ['-M','SS-20'] and NO '-smp 2' (probe MP later, if ever)
# setup steps: replace pkg_add with fetch+build-from-source of
#   gmake/cmake/libffi (or skip when baked into the image)
# file server port: 8180
```

## 8. Kicked off today (2026-07-09)

The one-time NetBSD/sparc 10.1 anita install (S1 front half) was launched
detached: log `spike/quickjs/vendor/sparc-install-console.log`, exit
marker `spike/quickjs/vendor/sparc-install-exit.txt`. Everything past the
install awaits human review of this runbook.

---

### Footnote: the abandoned sparc64/sun4u recon (2026-07-09, same day)

Recorded so the facts aren't re-derived: NetBSD-10.1-sparc64.iso exists
(481MB); anita 2.18 supports sparc64 (ISO-only, cdrom index 2, OBP `> `
halt prompt); qemu sun4u caps at **1 vcpu**, accepts `-m 4G`; pkgsrc HAS
full sparc64 binaries incl. gcc12 (10.0_2024Q3 and 10.0_2026Q1 quarters).
Rung retargeted to 32-bit sparc by user decision: sun4u is not a stable
NetBSD qemu guest (qemu's own docs call it merely "mostly complete";
historical NetBSD-on-sun4u ATA/NIC interrupt trouble), sun4m is the
mature emulation, and the project's BE need is the 32-bit axis anyway.
No sparc64 install was ever started.
