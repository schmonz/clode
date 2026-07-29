# clode — tactical backlog

Concrete clode-under-Node divergences from native Claude Code, to triage and fix.
(Strategic feasibility risks live in `LONG-TERM.md`; in-flight designs in
`docs/superpowers/`. Done items are DELETED from here — git history is the record.)

## Arch / artifact-name rationalization — release-atomic remainder (2026-07-27)

The canonical-name refactor SHIPPED (single `scripts/canonical-name.cjs` source of truth;
download name == `--list-targets` tag == fetched engine; pin drops the `v`; the build-leg
bash asset name now comes from the canonical-name CLI). What's LEFT is release-coupled:
- **Shipping the pin-format change is release-atomic** — an old clode's baked pin
  (`v26.6.0-…`) vs a new manifest (`26.6.0-…`) mismatches → obtainEngine refuses. Land it
  WITH a release, not before. See the at-desk release-readiness plan (Task 4).
- CI **engine-upload names** must be the canonical `tjs-<os>-<arch>-<pin>` a fetching clode
  expects (verify on the release pass).
- Optional leg-token rename (plan path B) — internal-token uniformity, bigger blast radius;
  follow-up only.

## tjs must be BUILT + REQUIRED by the suite, not skipped (2026-07-25)

On netbsd11-arm64, 200 of 240 suite skips are "no tjs binary (CLODE_TJS or
build/tjs/…)". tjs builds on EVERY target platform (the whole cross-build matrix
— a solved problem), so skipping on its absence is the same silent-coverage-loss
anti-pattern as the old node-pty skip (now fixed: node-pty is built + required,
7d1763f). The suite should ensure tjs is built (like the PTY harness) and tests
should REQUIRE it, converting ~200 skips into runs. Wire a build-or-require step into
test/run.mjs (mirror the node-pty harness path) and drop skipUnlessTjs's silent-skip in
favor of a loud requirement. User framing (2026-07-25): "Isn't tjs known to build on every
platform we target?" — yes; don't skip on a buildable artifact's absence. (Unblocked now
that the build-dir isolation lands.)

## NetBSD 64-bit time_t: write-side utimes truncation in the pkgsrc host node (2026-07-25)

`fs.utimesSync(f, new Date('2076-...'))` under the pkgsrc host node writes a mtime
of 1940 — a signed-32-bit time_t wrap (2076 ≈ 2^32 s). Disambiguated: the OS `stat`
(and `ls`) read back the SAME 1940, so libuv WROTE the truncated value; the kernel
stored it faithfully (not a read bug). NetBSD/arm64 has had 64-bit time_t forever;
this is the NetBSD symbol-versioning trap — 64-bit time is exposed via renamed libc
symbols (`__utimes50`/`__stat50`/…), and a binary built without the correct NetBSD libc
headers links the OLD 32-bit `utimes`. So the pkgsrc node 24 (or its bundled libuv) was
compiled to call 32-bit `utimes`, not `__utimes50` — an upstream pkgsrc/node BUILD defect,
not clode code. THE ONE WE OWN: clode's tjs build vendors libuv (spike/quickjs/vendor/
txiki.js/deps/libuv); it MUST compile with NetBSD 64-bit-time_t symbols or quaude will
truncate timestamps the same way. Verify (and patch the tjs build if needed) once the
native tjs build is unblocked. Report the pkgsrc node build bug upstream.

## Native tjs on NetBSD needs CLODE_TJS_WASM=off (WAMR uses Linux mremap) (2026-07-25)

Building native tjs on netbsd11-arm64 fails in WAMR: `deps/wamr/core/shared/platform/
common/posix/posix_memmap.c` uses Linux-only `mremap(..., MREMAP_MAYMOVE)` (NetBSD has
no such mremap). Same class as the documented MAP_32BIT breakage on s390x/ppc64le/
riscv64. STOPGAP for green: build with `CLODE_TJS_WASM=off` (build-tjs.mjs supports it —
drops WASM/WAMR; "nothing shipped imports it", bun:ffi is a throw-on-use stub). TODO: decide
whether NetBSD (and other non-Linux BSDs) should ship WASM at all; if yes, patch WAMR's
posix_memmap.c with a non-Linux mremap fallback (munmap+mmap or guard the MREMAP path) and
upstream it. For now WASM-off is the shipping posture on platforms where WAMR won't build —
record it in the per-target build config, not as an ad-hoc env flag a human must remember.

## ★ Build-working-dir isolation — no shared-tree tromping (2026-07-25)

Principle (user, 2026-07-25): "cross-build a zillion clodes and quaudes and they
can't be tromping on each other." On a shared NFS tree, EVERY build output AND
every build WORKING dir must be platform-unique (or per-invocation isolated), so
concurrent/cross builds never corrupt each other. Existence-only gates then can't
mistake a foreign-platform artifact for a local one. (DONE: `build/tjs/tjs` output → per-target
`build/tjs/<osToken>-<arch>/tjs`; the cmake build dir → out-of-tree per-target `<outDir>/build`;
and build-tjs is now REENTRANT — ensureCheckout resets the vendored source to a pristine pin
before applyPatches, so a killed/failed build can't poison the next, via
`scripts/tjs-source-reset.mjs` + `test/tjs-source-reset.test.cjs`. That reset also sweeps the
NFS AppleDouble `._*` turds that were making `git clean` exit non-zero mid-sweep.)

STILL OPEN — true CONCURRENT-build isolation of the shared txiki SOURCE:
- Reentrancy (sequential self-heal) is shipped, but the reset-before-patch still mutates the
  ONE shared `spike/quickjs/vendor/txiki.js` checkout, so two builds running AT THE SAME TIME
  on this box still race on it. `applyPatches` is one unconditional, platform-independent patch
  list, so per-target source copies are needed ONLY for concurrent patching, not for the build
  itself. When concurrent local builds are actually exercised, give each build its own source
  via `git worktree`/`git clone --local` at the pin under `<outDir>`, keyed like the build dir.
  (CI legs already each run on a fresh checkout, so CI isn't exposed; this is a local-dev axis.)
- **Build-system rethink goal (user):** take the next step toward FULL CROSS BUILDS — build
  any target from any host. Generalize the host≠target split (CLODE_TJS_OUT/cross-file/
  CLODE_TARGET_*): platform keys become TARGET keys (token/arch injectable; tjsDir/tjsBin
  already accept them), the shared patched source feeds N per-target out-of-tree builds, and
  the tag vocabulary (platform-tag.cjs) is the single axis for output + build dirs across the
  whole matrix. Make the mechanism target-parametric, not just NetBSD-specific.

Sweep needed: audit ALL of build/ and any in-tree scratch (spike/, .matrix/) for un-keyed
working dirs and apply the principle. platform-tag.cjs is the single source of truth for the keys.

AppleDouble `._*` root cause + the mount fix (2026-07-28): the turds are NOT files that need
xattrs — recent macOS (13+) auto-stamps `com.apple.provenance` on every file it writes (git
checkout, build copies, even `touch`), and the tree's NFSv3 mount (`ap-juicer:/export/code/trees`)
has nowhere to store an xattr inline, so each stamped file spawns a `._<file>` sidecar. PROVEN the
copy-tool levers can't stop it: `cp -X` AND `ditto --noextattr --norsrc` STILL made sidecars —
the kernel re-stamps provenance at create time, so it isn't copied, it's re-added (COPYFILE_DISABLE
is likewise futile). The only durable "never happens" fix is STORAGE-side: give the volume native
xattr storage. Plan: keep Mavericks/NetBSD/Linux on **NFSv3** (none of them generate AppleDouble —
provenance is macOS-13+, and non-macOS clients never write `._*`), mount ONLY the recent-macOS box
**NFSv4 with named attributes** — recent macOS is the sole generator, so stopping it there stops the
whole shared tree. CONTINGENT on verifying macOS-over-NFSv4 actually maps xattrs to native named
attributes rather than STILL writing AppleDouble (its NFSv4 support is historically partial): 30-sec
test on a v4 mount — `touch probe.c; ls ._probe.c` (sidecar present = v4 didn't help; absent with
`xattr -l probe.c` showing provenance = native storage, win). Server prereqs: NFSv4 named-attr
export + xattr-capable backing FS. One-time `find <tree> -name '._*' -delete` clears the residue.
User's read (2026-07-28): this NFS friction is probably a nudge to **replace NFS with Syncthing** —
peer-to-peer sync per host, no shared-mount xattr-fallback problem at all (each box has a real local
FS). If Syncthing lands, this whole AppleDouble class evaporates and the reset's `._*` sweep becomes
vestigial. Meanwhile the build is already robust to the turds (the reset sweeps them), so this is an
infra-hygiene task, not a correctness one.

## node-pty won't build on NetBSD — make it available, don't silent-skip (2026-07-25)

node-pty 1.1.0's `src/unix/pty.cc` forkpty include block has branches for __linux__/
__APPLE__/__FreeBSD__/__OpenBSD__ but NO `__NetBSD__`, so NetBSD includes no header →
forkpty/openpty/B38400/VTIME/cfsetispeed all undeclared, the addon fails to compile, and
the PTY/TUI test harness can't install. NetBSD has these in `<util.h>` + `<termios.h>`
(link `-lutil`) — identical to the OpenBSD branch. Fix = a ~2-line patch (pty.cc NetBSD
branch + binding.gyp adds netbsd to the `-lutil` link condition), applied durably during
harness install (clode already has a patch-apply discipline for tjs), and upstreamable.
User's call (2026-07-25): silent-skip on a missing native addon is NOT desirable — make it
available or make skipping a conscious, tracked choice. STOPGAP shipped: run.mjs no longer
hard-aborts the whole suite when the harness can't build (it warns + runs the non-PTY suite);
but that warn is a backstop for genuinely-unsupported platforms, NOT the answer for NetBSD —
the answer is the pty.cc patch so the PTY tests actually RUN.

## ★ ACTIVE FRONTIER — the general-purpose cross-build matrix (2026-07-14)

North star (user, 2026-07-14): a cross-build matrix "as **reproducible, large,
well-tested, and reasonably fast** as we can possibly make it."

- **NEXT: the four quality bars for the WHOLE matrix** (native + cpa/vmactions VM +
  Debian-cross + NetBSD build.sh + darwin cross):
  - *reproducible* — immutable pins everywhere: SHA-pin `netbsd-src` (needs fetch-by-SHA in
    the composite) + a Renovate annotation; digest-pinned images; honest-floor SDKs.
  - *large* — the NetBSD fleet, then the same treatment for other build.sh-class and
    Debian-cross-class targets.
  - *well-tested* — push verify coverage up: qemu-user where it exists, qemu-system (NetBSD
    level-3) as the upgrade, arch gate everywhere, attest.
  - *reasonably fast* — cross-build over in-guest TCG where possible (cross = minutes vs TCG
    = ~hour); cache toolchains (machine+src-rev) + tjs (source-hash); tmpfs for disk-bound loops.

### Known shipped-artifact bugs

- **`dragonflybsd-amd64` leg red — UPSTREAM VM-IMAGE infra, NOT our code (2026-07-18,
  track-only per user).** The leg fails at guest SETUP, before any tjs build:
  `Error updating repositories!` + `mount_hammer2: cluster_connect(...) failed` — the
  DragonFlyBSD 6.4.2 guest can't update pkg repos / mount its FS. Persistent; the ONLY
  non-green job while everything ours is green. We use `cross-platform-actions/action@v1.3.0`
  (`.github/actions/guest`). Can't route around it: **6.4.2 is the ONLY DragonFlyBSD version
  cpa supports.** vmactions/dragonflybsd-vm has CLOSED prior art that IS our symptom (#12
  "low disk space only on DragonflyBSD", #5 "Installing packages is broken") — a recurring
  DFly-VM-image class problem. The leg is `publish: true` hard-gating with NO `soft-fail`.
  When ready to act: demote to soft-fail (a leg whose guest won't boot ships nothing anyway)
  and/or file a cpa issue. For now: watch upstream.

- **darwin-universal i386/ppc slices are `no-exec` — clode by construction, unverified.**
  The universal artifact lipo's four bare tjs engines (arm64, x64, i386, ppc) then fuses ONE
  canonical-LE trailer spanning all slices, so running the i386 or ppc slice carves the same
  payload and *is* full clode. But i386/ppc are cross-built and never smoked (no such macOS in
  CI), so an arch-specific boot bug would only surface on real hardware. **User will smoke the
  shipped binary on Tiger/PowerPC** — fold the result back here. (CLEANUP, not a bug: the
  builder embeds an all-four-slice fat template but only arm64+x64 are real build hosts —
  embedding arm64+x64 instead of the full fat one trims builder bloat with no capability loss;
  doesn't remove the codesign thin-on-failure fix.)

### Known quaude runtime bugs

- **quaude does not persist config across invocations — CREDS half open (NetBSD/arm64 at
  least).** The 0-byte `~/.claude.json` config-write half was ROOT-CAUSED + FIXED (2026-07-15):
  the node-shim `fs.writeFileSync` didn't support the fd-as-first-arg form, so CC's atomic
  writer (`ED6`: openSync temp → writeFileSync(fd) → fsync → close → rename) wrote to a bogus
  file named "8" and rename-clobbered the config to empty. Fixed + guarded by
  `node-shim-fs.test.cjs`. **STILL OPEN — the credentials half:** native CC stores login in the
  OS keychain (macOS) or a credentials file; under tjs there may be no keychain-equivalent, so
  the token isn't saved. Confirm `~/.claude/.credentials.json` now persists under quaude (it may
  be a co-fix of the fd-writeFileSync bug); if creds use a different path, re-check keychain vs
  file store. Repro platform: NetBSD/arm64.

- **quaude login browser-launcher does not open the browser (macOS/arm64 at least).** The
  "spawn detached/ignore gap" lead was DISPROVEN (2026-07-15): CC's opener
  (`spawn("open",[url],{stdio:"ignore",detached:true})`) LAUNCHES under real tjs, `open`
  PATH-resolves, and returns its exit code — the mechanism works at every testable layer. NOTE
  `spawn` silently DROPS `opts.detached` (never threaded to `tjs.spawn`, child_process.cjs
  ~L189) — harmless for `open` but a latent gap worth closing. NEXT: needs an INTERACTIVE
  real-quaude login (real browser/OAuth) to repro — likely env/onboarding state poisoned by the
  now-fixed 0-byte config, or a timing/exec-option nuance. Re-test on a fresh quaude now that
  config persists. Workaround: the login URL is printed — open it manually.

- **quaude TUI leaves stale frames on screen (daily-driver, 2026-07-15).** Finished commands
  persist after they should clear (a done `/login` still shows; `/doctor` shows "queued" after
  it ran). The repaint isn't ERASING prior lines — either the cursor-up + clear-to-EOL sequence
  isn't emitted/honored under the tjs tty shim, or the Ink diff-render redundantly repaints
  without clearing (cf. M3 render-parity: tjs interactive render ~1.2MB vs node ~8KB/turn).
  Likely a node-shim `tty`/write or ANSI-erase gap. Part of the M3 render-parity frontier.

- **quaude's fullscreen renderer crashes before it can draw a frame (NetBSD/arm64). FIX
  BEFORE NEXT RELEASE.** PROVEN this session to be NetBSD-SPECIFIC (fullscreen works cleanly on
  macOS; repro lever `CLAUDE_CODE_NO_FLICKER=1`). Whatever enters the alt-screen path takes
  quaude down before a fullscreen frame paints. NEXT: capture the crash on NetBSD/arm64
  (`--debug-to-stderr` / handle+unhandledRejection dump) to get the failing call; suspect a
  node-shim tty/altscreen gap on that platform. See the at-desk release-readiness plan (Task 2).

- **quaude TUI won't exit on double-Ctrl-C (Tiger/PPC Darwin 8). Likely FIX BEFORE NEXT
  RELEASE.** The FIRST Ctrl-C shows "Press Ctrl-C again to exit" (input is fine); the SECOND
  doesn't tear down — the process stays alive, only `kill -TERM` escapes. The fault is the EXIT
  path, not input. Suspect a blocking SYNC tty op during raw-mode restore / alt-screen leave on
  Darwin 8 — the same class as the fixed `/quit` O_NONBLOCK wedge. NEXT: trace the second-Ctrl-C
  shutdown on Tiger (which sync call blocks) and confirm whether the `/quit` O_NONBLOCK fix
  reaches it. See the at-desk release-readiness plan (Task 3). (Secondary, same box: couldn't
  copy the printed OAuth URL out of the frozen login screen — a selection/scrollback issue.)

### Platform wishlist (reachable-frontier tracker)

- **NetBSD hard-arch remainder:**
  - **vax** (32-bit LE) — dropped from the fleet: toolchain builds, but quickjs assumes IEEE
    floats and VAX has **non-IEEE** F/D/G format. Real fix = a soft-float IEEE mode for GCC's
    VAX backend (a GCC-backend project, not a leg tweak). (Expect ia64, or1k, m68000/sun2 as the
    sweep reaches them.)
  - **DEFERRED PROJECT — `build.sh` light sysroot / "sysroot without userland".** Compose a
    lighter DESTDIR from `distrib-dirs` + `make includes` + runtime libs instead of a full
    `distribution`, so no leg builds userland it throws away (and userland bugs like sbmips
    `crash` never fire). Prototype scaffolding EXISTS, dormant, in netbsd-crossbuild
    (`sysroot-mode: light`). METALOG + `includes` work; the open wall is `lib/csu` not building
    `crt0.o` standalone. Worth finishing — it speeds EVERY NetBSD leg, and there's no blessed
    `build.sh sysroot` op, so a working recipe is a plausible upstream feature. Finish csu, then
    converge the other NetBSD legs onto light.
- **Paleo-POSIX host (macOS floor-walk) — HELD until Tiger is solid (user, 2026-07-28).**
  Walk the darwin floor older (Tiger 10.4 proven → Jaguar 10.2; kqueue is the 10.3 cliff) so the
  event loop runs on pre-kqueue systems. KEYSTONE — the same backend later unlocks A/UX, IRIX,
  and old-everything from one mechanism. Decision (user): do NOT reach down to Jaguar until the
  current floor (Tiger) is trustworthy — reaching below a shaky floor multiplies risk. **Scoping
  insight (2026-07-28):** it is NOT "write a select backend from scratch" — our vendored libuv
  already ships `deps/libuv/src/unix/posix-poll.c` (a `poll(2)`-based `uv__io_poll`, used by
  AIX/generic-POSIX). So the real work is: compile libuv against `posix-poll.c` instead of
  `kqueue.c` for the pre-kqueue Darwin target, and determine whether old-Darwin `poll(2)` is
  reliable (it was historically buggy on pipes/ttys — the reason libuv prefers kqueue on Apple);
  if poll can't drive the loop, fall back to `select()` under it. Resume once Tiger is solid.
- **MorphOS** (PowerPC AmigaOS-family) — tier-3, needs a libuv port (non-POSIX Amiga exec API,
  no epoll/kqueue). The hardware is already reachable via NetBSD/macppc (PPC) + NetBSD/m68k, so
  the fleet covers the boxes without porting the OS. Revisit only if a libuv backend appears.

## Cosmopolitan APE leg — ADDITIVE "one .com everywhere" (spike, 2026-07-28)

One `quaude.com` running native on Linux/macOS/Windows/BSD, x86-64 AND arm64, from one build.
Upside beyond portability: Cosmopolitan gives `fork()`/`exec()` on Windows → agentic-Bash/
child_process could match POSIX fidelity where the win32 SEA can't. ADDITIVE beside the tjs legs,
never a replacement.

Toolchain: cosmocc **4.0.2** (github.com/jart/cosmopolitan), single self-contained zip, produces
fat x86-64+aarch64 APEs. Pin sha256 `85b8c37a406d862e656ad4ec14be9f6ce474c1b436b9615e91a55208aced3f44`
(cosmocc-4.0.2.zip, 441MB). Slots into the existing `CLODE_TJS_CROSS_FILE` seam (a cosmo CMake
toolchain file), a `cosmo` target token, the lean profile (wasm/mimalloc/ffi off).

FEASIBILITY: PROVEN. The two scary unknowns (engine core, errno model) are both resolved; the rest
is a bounded, well-understood port. Spike (this box, arm64 macOS, cosmocc 4.0.2):
- ✓ Step 1: cosmocc builds + a `hello.com` APE runs native.
- ✓ Step 2: **bare QuickJS-ng compiles under cosmocc with ZERO source changes** → a 2.7MB `qjs.com`
  APE that ran and evaluated real JS. The ENGINE CORE is not a blocker.
- ✓ THE CRUX (errno) — CRACKED. libuv maps its error enum to system errno (`UV_E2BIG=(-E2BIG)`),
  but cosmo's errno macros are NOT compile-time constants: they're linker/runtime symbols resolving
  to the HOST OS's native value (probed: `EAGAIN=35` on macOS = the BSD value, would be 11 on Linux)
  — the SAME .com yields different errno per host, so they can't be constant. Enum init → "not an
  integer constant". FIX (proven to clear the blocker): patch libuv's `include/uv/errno.h` guards
  (`#if defined(E2BIG) && !defined(_WIN32)` → also `&& !defined(__COSMOPOLITAN__)`) to force libuv's
  FIXED -40xx codes. FOLLOW-UP for correctness: runtime errno→UV translation (like libuv's Windows
  path), since stored `-errno` (host value) won't equal the fixed UV codes — hot-path retries use raw
  `errno==EAGAIN` (runtime, fine); only public error NAMING needs the translation.
- ✓ Remaining libuv work CHARACTERIZED — a bounded source-portability port, "teach libuv that
  `__COSMOPOLITAN__` is a generic-POSIX + poll platform": (a) cosmo defines `__COSMOPOLITAN__`/
  `__unix__` (not `__linux__`/`__APPLE__`) and ships `poll.h` (no epoll/eventfd; has a kqueue-ish
  sys/event.h) → select `posix-poll.c` + self-pipe wakeup [the SAME backend paleo-POSIX/Jaguar
  needs — one port, two frontiers]; (b) add cosmo to libuv's platform `#ifdef` guards + its
  header dispatch (`uv/unix.h`) so system headers get included; (c) DROP the GNU-branch feature
  macros `_POSIX_C_SOURCE=200112`/`_XOPEN_SOURCE=500` — they HIDE `if_nametoindex` et al. in cosmo's
  headers (cosmo guards them under default/BSD-source); (d) write `cosmo.c` platform file for the
  hurd.c-class misc funcs (exepath/cpu_info/rss/uptime/loadavg). NB cosmocc HARD-enforces
  `-Werror=implicit-function-declaration` (no `-w`/`-Wno-*`/`-std` suppresses it) so every missing
  decl is a real fix. libuv's event-loop hooks are self-contained in `posix-poll.c` already.

PHASE A DONE (2026-07-29) — **libuv's event loop RUNS under Cosmopolitan as an APE** (timer test:
3 ticks, uv_run returned 0). A working libuv-on-Cosmopolitan port, which did not exist publicly.
Clean, upstreamable patch (scratchpad `patches-wip/libuv-cosmo.patch`, 637 lines, 5 files, all
`#ifdef __COSMOPOLITAN__`-guarded → behavior-neutral for other targets, applies clean to pristine
libuv 1.52.2):
- `include/uv/errno.h`: guards force libuv's fixed -40xx codes under `__COSMOPOLITAN__` (like _WIN32).
- `include/uv/unix.h`: dispatch cosmo → new `include/uv/cosmo.h`.
- `include/uv/cosmo.h` (NEW): `#include "uv/posix.h"` (poll(2) loop fields) + declares the interface
  helpers cosmo's libc lacks.
- `src/unix/cosmo.c` (NEW): `if_nametoindex`/`if_indextoname` (documented stubs — no interface scope;
  quaude's global-DNS path never uses them) + `uv_interface_addresses` (empty; no getifaddrs on cosmo).
- `src/unix/udp.c`: add `__COSMOPOLITAN__` to the two existing source-specific-multicast guards
  (SSM absent on cosmo → ENOSYS, like OpenBSD/NetBSD). Source set = generic-POSIX + posix-poll.c
  (drop bsd-ifaddrs.c → cosmo.c); build defines `_GNU_SOURCE _DEFAULT_SOURCE` (NOT the strict
  `_POSIX_C_SOURCE`/`_XOPEN_SOURCE` which hide cosmo's default-source decls); `-std=gnu17` (cosmocc's
  GCC defaults to C23 which hard-errors implicit decls). Errno runtime→UV translation still owed for
  correct error NAMING (not exercised by the timer test).

PHASE B — the tjs.com APE RUNS JavaScript under Cosmopolitan (2026-07-29). ✅ `tjs eval` works
(`COSMO RUNS: 42 | 26.6.0`), ✅ the poll(2) event loop works (setTimeout fires, promises resolve),
✅ a genuine 9.9MB APE. The boot HANG is FIXED — two libuv-cosmo bugs, both committed in
patches/libuv-cosmo.patch: (1) **UV__ERR sign** — libuv guards it with `#if EDOM > 0`, but cosmo's
errno macros are runtime symbols so the preprocessor reads EDOM as 0 and picks the NON-negating
form → every libuv error came back +errno → `uv_fs_open` of a missing file returned +2 (a bogus fd),
and tjs's module loader spun on `pread(2)→EBADF`. Forced the negating form under __COSMOPOLITAN__.
(2) **uv_exepath** — `readlink(/proc/self/exe)` is not portable across cosmo's host OSes; use
Cosmopolitan's `GetProgramExecutableName()`. PHASE C (TLS) — DONE (2026-07-29), zero extra work: HTTPS just works under cosmo. Verified from the
tjs.com APE: `fetch("https://example.com")` → 200; **`fetch("https://api.anthropic.com/v1/messages")`
→ 401** (the real target reached securely — 401 = needs a key); and cert verification is genuinely
ON (`expired.badssl.com` rejected: "server's cert didn't look good, expired"). mbedtls + libwebsockets
build and run correctly under cosmo, CA bundle resolves. So the engine can already do quaude's secure
API traffic. PHASE D (fuse) — MECHANISM PROVEN COMPATIBLE (2026-07-29), and the zipos-vs-trailer design fork is
RESOLVED in favor of the EXISTING trailer fuse (no zipos rework). Confirmed on the cosmo tjs.com APE:
(1) appending a 200KB trailer does NOT break the APE (cosmo's zipos tolerates trailing data — it
scans backward for its EOCD and skips our trailer); (2) `tjs.exePath` resolves; (3) the APE opens +
positional-reads its OWN executable tail (the `tx1k1.js` 12-byte trailer read in
src/js/run-main/index.js works). So fusing quaude = run the EXISTING `libexec/clode-fuse.cjs` with the
cosmo tjs.com as the template (append [bytecode][TPK payload][tx1k1 trailer]); the APE reads it exactly
like the native tjs template. NEXT (implementation, overlaps E): materialize a quaude payload + invoke
clode-fuse with the cosmo APE template → boot quaude.com. Then E (leg + multi-OS CI). Build-cache note: incremental cmake-on-NFS
under-recompiles (mtime staleness); use `rm -rf build` or Ninja for dev — a non-issue for build-tjs
(builds clean each run). Below: the earlier build-complete characterization.

PHASE B EARLIER — the tjs.com APE BUILDS (2026-07-29). The full txiki tree compiles and LINKS under
Cosmopolitan into a 9.9MB `tjs` Actually Portable Executable that BOOTS (starts running). Every
BUILD-level cosmo gap is solved, all as clean guarded patches: `patches/libuv-cosmo.patch` (libuv
port + 4 misc platform funcs uv_exepath/cpu_info/loadavg/uptime) + `patches/libtjs-cosmo.patch`
(txiki's SIG*-in-static-init fixes) + the cosmo toolchain/compat/prelude + CMAKE_RANLIB=cosmoranlib
(host ranlib can't index cosmo fat archives). Lean profile (mimalloc/ffi/wasm/sqlite OFF); the tjs
CMake target is the STATIC LIB (libtjs_core.a), the executable is `tjs-cli`.
**REMAINING — RUNTIME hang, ROOT CAUSE LOCALIZED (2026-07-29 via cosmo `--strace`):** the tjs.com
APE boots then spins in an infinite loop:
  `openat("tjs:internal/bootstrap", O_RDONLY) → ENOENT`
  `pread(fd=2, 65536, offset) → EBADF`  (repeats forever, offset crawling, position advanced on error)
tjs's module loader fails to resolve the compiled-in builtin `tjs:internal/bootstrap` from the
bytecode registry, falls through to a filesystem/fd load path, and spins on a bad descriptor (fd 2).
NOT missing bundles — `strings tjs | grep internal/bootstrap` = 2, the bundle bytecode C arrays
(src/bundles/c/core/*.c) are compiled in. So it's builtin-module RESOLUTION under cosmo (why the
registry lookup misses → openat), plus a loader bug (the pread-EBADF fallback should fail loud, not
loop). Bisect fact: hang correlates with stdout fd-type (pipe stdout → exits; regular file/​/dev/null/
closed → hang) because the fd table shifts and changes whether the loader lands on fd 2. ROOT CAUSE (2026-07-29, deeper): the hang is `uv_fs_open("tjs:internal/bootstrap")` returning **+2**
(a bogus fd = ENOENT's runtime value) instead of a NEGATIVE error, so `tjs__load_file` (vm.c:917)
accepts fd 2 and spins in the `pread(2)->EBADF` loop. (`tjs:internal/bootstrap` legitimately isn't a
builtin — it's imported by the core bundle and normally load-fails cleanly; the bug is that the
"missing file" error comes back POSITIVE.) Isolated with a standalone `uv_fs_open` probe: returns 2.
PARTIAL FIX SHIPPED (6407bae, in patches/libuv-cosmo.patch): libuv's `UV__ERR(x)` is guarded by
`#if EDOM > 0`, but cosmo's errno macros are runtime symbols so the preprocessor reads EDOM as 0
(VERIFIED) and picks the non-negating `UV__ERR(x)=(x)` → all libuv errors come back +errno. Forced
the negating form under `__COSMOPOLITAN__` in uv/errno.h + uv-common.h. **BUT the probe STILL returns
+2 after that fix** (verified: the fixed macro negates correctly AND fs.c recompiled) — so there is a
SECOND source of the positive result in libuv's fs open path. NEXT: trace libuv `src/unix/fs.c`
`uv__fs_open` / `uv__fs_work` result assignment under cosmo — where does req->result become +2 instead
of -2 (a raw `x = open()` returning the errno? a `result < 0` check that fails under cosmo?). Repro
(fast): the standalone probe `uv_fs_open(NULL,&req,"nope",0,0,NULL)` should be < 0. Then the hang
clears and tjs.com runs. Then Phase C (TLS), D (fuse), E (leg). Below is the earlier characterization:

PHASE B EARLIER (2026-07-29) — the full txiki tree CONFIGURES under the cosmo toolchain and
its CORE COMPILES: quickjs, wurl, txiki's C modules, and the patched libuv all build. Landed:
`scripts/cosmo.toolchain.cmake` (CLODE_COSMOCC, CMAKE_SYSTEM_NAME=Cosmopolitan via
`scripts/cmake/Platform/Cosmopolitan.cmake`, -std=gnu17/_DEFAULT_SOURCE, -isystem cosmo-compat,
force-included prelude, -Wno-error demotions) + `scripts/cosmo-compat/` (sys/syslog.h, net/route.h
aliases cosmo omits; cosmo-prelude.h = u_int, SO_PRIORITY, if_* decls). libuv patch has the CMake
Cosmopolitan source-selection branch. Build via: `--source-only` then apply patches/libuv-cosmo.patch
to deps/libuv, then cmake with the toolchain (-DBUILD_WITH_MIMALLOC/FFI/WASM/SQLITE=OFF, target tjs).
REMAINING for a `tjs.com` (a `patches/txiki-cosmo.patch`): txiki's OWN "constants aren't constant
under cosmo" spots — static arrays indexed by SIG* (src/utils.c `tjs_signal_map`; also signals.c
"modding const structs", mod_os.c, mod_posix-socket.c) must be built at RUNTIME, exactly the class
of the libuv errno fix. Then re-check the libwebsockets tail (SO_PRIORITY handled by the prelude;
watch for more). Then link → run the tjs.com APE.
- Phase C: TLS (mbedtls under cosmo — quaude needs HTTPS to the API; expected easy per getentropy).
- Phase D: zipos-fuse the quaude payload into the APE (/zip/).
- Phase E: wire the cosmo target into build-tjs.mjs + scripts/tjs-legs.mjs; multi-OS CI
  (Linux+Mac+Windows+BSD run the SAME .com); land the libuv-cosmo patch in patches/ once end-to-end.
Design forks for productization: (a) FUSING — APE already uses its tail as a ZIP store (zipos,
`/zip/…`); our quaude trailer-append collides, so embed quaude's payload in the APE zipos instead;
(b) TLS scope for v1 (defer mbedtls, ship lean no-TLS first?); (c) mac Gatekeeper on APE (assimilate
or rcodesign ad-hoc); Windows APE runs unsigned. Spike artifacts live in scratchpad (untracked).

## Phase 3 — still open (render parity + apicheck v1 + upstream-txiki batch)

M1/M2/agentic Bash under tjs SHIPPED; these remain:
- **M3 (render parity)** — tjs interactive render is byte-heavy (~1.2MB vs node ~8KB/turn,
  redundant full redraws); non-fatal, the last phase-3 milestone. (Overlaps the stale-frames
  runtime bug above.)
- **apicheck v1 → `clode selftest`** — v0 shipped (`scripts/apicheck.mjs`); v1 = the embeddable
  oracle (recording-Proxy coverage %, checked-in golden baselines, a corpus that exercises
  TOOL-USE turns), then wire it into a shipped `clode selftest [--json]`.
- **Upstream-txiki batch** (awaiting go-ahead): the spawn/stream/CLOEXEC patches + the quickjs-ng
  `v`-flag regexp fix + the phase-2 batch + the WIP `txiki-unhandledrejection-no-abort.patch`
  (formalize when patches/ unfreezes). Minor: `process.resourceUsage` still undefined (add when
  a path needs it).

## Endgame — API-surface gate: reference principles (v0 shipped)

`scripts/apicheck.mjs` (v0) runs the seed corpus under node AND tjs and gates on the `[wall]`
miss union + node-vs-tjs divergences (v1/v2 tracked under Phase 3). Load-bearing principles:
- **Oracle principle (for exotic platforms):** where `node` doesn't exist to diff against
  (NetBSD/SPARC), capture canonical/deterministic outputs (exit codes, crypto digests, fixed
  frames) on a reference platform, check them in, and diff the exotic platform against the record
  — this is what catches big-endian divergence.
- **Harness caution (still live):** this env carries `CLAUDE_CODE_BRIDGE_SESSION_ID` (child bundle
  auths via the parent bridge) — strip it to test real subscription auth.

## Hermetic test execution — still open (one item)

Curate the live `/doctor` parity allowlist — `e2e-doctor-parity` **test 2 is skipped**. A STRICT
native-vs-clode comparison reds on environment noise, not clode bugs; the goal (user decision) is a
curated allowlist of ignorable areas (Updates, Remote Control, Keychain warnings) that fails on
anything else — the upstream-`/doctor`-format drift signal. Needs: give clode's capture the REAL
render deps (kill wrapping noise), normalize status glyphs in `doctor-parity.cjs parseScreen`,
extend the allowlist, un-skip. Validation needs live captures (Keychain dialogs each cycle) — batch
it. (Related: un-skip `test_tui` #60, TUI-fails-loud-on-missing-ws, once its hermetic per-project
trust-state fixture is rebuilt.)

## The test suite requires host Node — can't run on clode's own target platforms (2026-07-24)

The suite is `node --test test/*.test.cjs`, orchestrated by `test/run.mjs` off `process.execPath`
(a real node). So the tests can only run where a modern host Node exists — precisely **not** where
clode is aimed. On a target platform (native binary won't run, no modern node) the suite is
unrunnable. Observed on `netbsd11-arm64`: no `node`/`tjs`/`qjs` on the box, `test/.harness` ships
node24 only for darwin/linux/win, so a `bun-shim.cjs` change made for that platform could only be
verified by pushing to CI. Want: run the suite — or a runtime-agnostic subset of the pure-logic
tests (rewriteSnapshot, CLODE_SHADOWS, translators, arg rewriting) — **under tjs/quaude**, so the
shim is validated on the runtimes clode ships to. Blocker: the tests bind to `node:test` + `node:`
builtins; running under tjs needs either a `node:test` shim on the tjs side or a port of the
pure-logic tests to a runtime-neutral harness. Relates to the `tjs-legs.yml` CI leg and the
node-floor squeeze in `LONG-TERM.md`.

## Where's `gh auth login` in the bottom status line?

Observed live: the bottom status line doesn't surface the expected `gh auth login` hint. Likely the
same class as the auto-update nudge — status-line content the bundle computes that clode's
environment (or a shim gap) changes. Investigate: reproduce, compare against native, locate where
the bundle builds that status-line item — is the hint suppressed, mis-evaluated (a `gh`/auth probe
behaving differently under the Node host), or rendered and just not where expected?

## Store our versions more parallel to how upstream stores binary versions

Upstream keeps versioned binaries at `~/.local/share/claude/versions/<ver>` with a
`~/.local/bin/claude` symlink to the active one. clode's cache (`~/.cache/clode/<KEY>`) keys on the
provider binary — `<ver>` when the path encodes one, else `<basename>-<size+mtime>` — and stores an
`.extractor-sig` so a changed extractor re-extracts. The schemes aren't aligned. Want: make clode's
per-version storage mirror upstream's more directly (a `versions/<ver>` layout with an "active"
pointer), so it's obvious which extracted bundle corresponds to which upstream version, easy to GC
stale ones, natural to diff side by side. Relates to the extractor-fingerprint re-extract and the
cache-key logic in `bin/clode` (`cache_key`).

## Proactively steer the model toward clode's update path (system-prompt nudge) — deferred

Idea, deferred. At launch, have `bin/clode` pass a short `--append-system-prompt` line telling the
model it's running under clode/quaude, that Claude Code here is **managed by clode and updated by
rebuilding** (`clode build`) — not `claude update`/`upgrade`/`npm i -g` — and that the target
surfaces a "newer version available" note (in `/status` + `claude doctor`) when upstream ships one.
The flag feeds the bundle's shared system-prompt builder (`Kn1`). WHY MAYBE-LATER: the
`PreToolUse(Bash)` update-guard (SHIPPED) already denies model-issued update/global-install commands
with a clode-pointing message, and the notify surface tells the human — so the reactive case is
covered and the nudge is lower-value than when first written. Revisit if the model keeps reaching
for upstream update paths despite the guard. Tradeoff: `--append-system-prompt` is last-wins, so a
user's own value would override clode's (the bundle also concatenates a settings `appendSystemPrompt`
inside `Kn1`).

## Windows code-signing / Smart App Control — deferred decision memo (2026-07-04)

**Current call: ship UNSIGNED.** For the unsigned `clode.exe` (and, now, an unsigned win32
`naude.exe`): most Windows users run it today; revisit signing when a real SAC-blocked user reports
it. Who's affected:
- ❌ **Hard-blocked:** Windows 11 with **Smart App Control (SAC) in Enforcement** — checks all
  executables regardless of origin; only signing fixes it, and only once reputation builds (no
  per-file "Run anyway"). SAC auto-enables only on clean/OEM Win11 (never on a 10→11 upgrade).
- ⚠️ **Bypassable warning ("Run anyway"):** Win10 / Win11-without-SAC when the file carries
  Mark-of-the-Web (browser/email download). One click, per file hash.
- ✅ **Runs clean:** Windows 10 (all), Server, any Win11 with SAC Off/Evaluation, AND any Windows
  where the file has no MOTW — fetched via CLI (curl/wget/`gh`/winget/scoop), git, or copied.
  clode's dev audience skews heavily here.
Notes: EV certs no longer bypass SmartScreen; reputation is per (hash+publisher) and ramps over
weeks; CLI installs usually don't set MOTW. Cheapest signing path when worth it: **Azure Trusted
Signing** (~$10/mo, cloud HSM, CI-native, individuals in US/Canada eligible). `scripts/sea-sign.cjs`
is already structured to add a real `signtool sign` on Windows when creds are present — wiring is a
small `release.yml` + `sea-sign.cjs` change behind a secret. **OPEN ITEM:** that Windows `signtool`
wiring, deferred until a user is actually SAC-blocked.

## node-shim Linux portability (first surfaced by the s390x BE oracle, 2026-07-09)

The s390x-musl leg is the first time the node-shim suite runs against a **Linux** tjs (the pinned
binary is darwin; the qemu guests are NetBSD). The BE oracle proved the engine is big-endian-clean,
but surfaced darwin assumptions the shim bakes in — Linux-portability debt, NOT big-endian bugs:
- **os.constants.signals is a hardcoded darwin table.** The shim returns darwin signal numbers
  (SIGBUS=10) where Linux differs (SIGBUS=7). Fix: per-platform signal tables (linux/darwin/
  netbsd/BSDs) in os.cjs (or constants.cjs). TDD: characterize against host node per-platform.
- **bun:ffi `suffix` hardcodes macOS 'dylib'.** Should be platform-aware (.so Linux/BSD, .dylib
  darwin, .dll Windows) — bun-shim.cjs BUN_BUILTINS['bun:ffi'].suffix. The bunshim test hardcodes
  the macOS extension too; fix both.
- **Audit for other hardcoded darwin assumptions** now that a Linux target exists: library
  extensions, default paths, os.constants.* / signal / errno tables, DYLD_* vs LD_* env handling.
  Sweep libexec/node-shim/** and libexec/bun-shim.cjs.
Not matrix-blocking (the BE oracle scopes these out); about node-shim FIDELITY on Linux, which the
shim-fidelity gate should grow to cover once a Linux tjs is a first-class local build target.
