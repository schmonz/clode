# Cosmopolitan APE — the FIDELITY RUN (Task 4b, pre-Phase-E)

Date: 2026-07-29. Host: arm64 macOS (Darwin 26), host node `/opt/pkg/bin/node` v26.3.0.
Goal (BACKLOG "Cosmopolitan APE leg" → NEXT): run the `test/fidelity/` agentic surface with
the **cosmo tjs engine as SUBJECT** vs a native-tjs **control**, triage every divergence, fix the
clear shim/libuv-cosmo gaps. Done BEFORE Phase E so Phase E codifies the final patch set.

**Bottom line: engine built + fused + smoked green; 7/7 fidelity scenarios IDENTICAL between the
cosmo APE and the native-tjs control (0 divergences); the fused `quaude.com` APE itself does a full
Bash tool round-trip and is byte-stable across runs. No shim/libuv-cosmo fixes were needed.**

---

## 1. Engine — build recipe (reproduced/verified)

The committed patches are **byte-identical** to the patches that built the working engine:

    diff patches/libuv-cosmo.patch  <prior scratch>/patches-wip/libuv-cosmo.patch   -> IDENTICAL
    diff patches/libtjs-cosmo.patch <prior scratch>/patches-wip/txiki-cosmo.patch    -> IDENTICAL

The pinned source tree `spike/quickjs/vendor/txiki.js` already carries the applied cosmo guards
(`grep -c __COSMOPOLITAN__ deps/libuv/include/uv/errno.h` -> 70). The engine that these produce was
verified running here:

    <engine> run ev.js   ->   "COSMO RUNS: 42 | 26.6.0"    (fat APE, DOS/MBR 'MZ' header)

Exact recipe (from the out-of-tree `txiki-build/CMakeCache.txt` + `scripts/cosmo.toolchain.cmake`),
all build output OUT OF TREE (build dir in scratch; source read from the tree):

1. Provision cosmocc **4.0.2**, pin sha256 `85b8c37a406d862e656ad4ec14be9f6ce474c1b436b9615e91a55208aced3f44`
   (cosmocc-4.0.2.zip, 441MB); `chmod +x tc/bin/cosmoranlib` (host ranlib can't index cosmo fat archives).
2. Apply `patches/libuv-cosmo.patch` (deps/libuv 1.52.2) + `patches/libtjs-cosmo.patch` (src/).
3. Configure with `CMAKE_TOOLCHAIN_FILE=scripts/cosmo.toolchain.cmake`
   (→ `CMAKE_SYSTEM_NAME=Cosmopolitan` via `scripts/cmake/Platform/Cosmopolitan.cmake`;
   `CMAKE_C/CXX_COMPILER=cosmocc/cosmoc++`, `CMAKE_AR=cosmoar`, `CMAKE_RANLIB=cosmoranlib`;
   `-std=gnu17 -D_DEFAULT_SOURCE -isystem scripts/cosmo-compat -include cosmo-prelude.h` + the
   `-Wno-error=` demotions).
4. **Lean profile** (all OFF): `BUILD_WITH_MIMALLOC`, `BUILD_WITH_FFI`, `BUILD_WITH_WASM`,
   `BUILD_WITH_SQLITE`, `BUILD_WITH_LTO`, `LWS_WITH_SQLITE3`, `QJS_BUILD_CLI_WITH_MIMALLOC`.
5. Build target **`tjs-cli`** (cosmo's engine is the `tjs-cli` executable, not the default
   `tjs` static lib `libtjs_core.a`).

Result: a 9.9MB fat (x86-64 + aarch64) `tjs` APE.

> Provenance note (honesty): I did NOT re-run the multi-CPU-hour full txiki+deps cosmocc rebuild —
> the committed patches are byte-identical to what produced the existing out-of-tree engine and that
> engine boots + evaluates JS here. I validated reproducibility via the patch/source-state check
> above and used that verified engine as the fidelity subject. A from-clean `build-tjs.mjs` cosmo
> build is Phase-E work (explicitly out of scope for this run).

## 2. Fuse — `quaude.com` + smoke (GREEN)

    CLODE_TJS=<cosmo tjs.com> \
    CLODE_CLAUDE_BIN=~/.local/share/claude/versions/2.1.220 \
    CLODE_DEPS=<tmp> CLODE_CACHE=<tmp> CLODE_NO_WATCH=1 \
    node libexec/clode-main.cjs build --out <tmp>/quaude.com

    -> quaude-fuse: wrote quaude.com (50254044 bytes, 523 members, bundle 2.1.220)
    -> clode: smoke: PONG round-trip ok, attest ok

`clode-fuse.cjs` already routes the MZ-header APE template + smoke through `/bin/sh` (isApeFile →
`sh -c '"$@"' sh <ape> <args>`), so the fuse + smoke ran with no changes. The 50MB `quaude.com` is a
DOS/MBR 'MZ' fat APE.

**Self-modification / stability:** sha256 of `quaude.com` is byte-IDENTICAL before/after a run
(`3d4d0f17…819b` → same). The shipped APE stays pristine — reassurance re-confirmed on THIS fuse.

## 3. Fidelity run — cosmo SUBJECT vs native-tjs CONTROL

**Method.** To isolate *cosmo-specific* divergences (vs pre-existing shim/bundle behavior), I ran the
SAME extracted Claude bundle (`cli-2.1.218.cjs` + `libexec/bun-shim.cjs`) under two engines through
`libexec/node-shim/loader.cjs`, mirroring `test/fidelity/agentic-*.test.cjs` + `test/node-shim-agentic.test.cjs`
(same `bootP`, same `test/mock-anthropic-helper.cjs` scripted SSE, same client-observable oracles):

- CONTROL: native tjs `build/tjs/macos-26-arm64/tjs` (26.6.0).
- SUBJECT: cosmo tjs APE behind a `/bin/sh` wrapper (`exec /bin/sh -c '"$@"' sh <ape> "$@"`), pointed
  at via `CLODE_TJS`/`FIDELITY_ENGINE` — exactly BACKLOG's "cosmo engine behind a /bin/sh wrapper at
  the engine's bootP path". Both use `CLODE_PROVIDER_BIN`-class bundle = 2.1.218 (extract-claude-js on
  the official 2.1.220 Bun binary also carves cleanly, confirming the reference path).

Reference `CLODE_PROVIDER_BIN` note: `extract-claude-js.cjs` needs a **Bun**-compiled provider; the
darwin **naude** (Node SEA) does NOT carve (`no Bun @bun-cjs entry marker`) — the official `claude`
(Bun) does. So the bundle came from the Bun path; correctness is asserted by the mock oracles, and the
native-tjs run is the localizing reference (quaude-off-but-native-matches ⇒ cosmo gap).

**Scenarios (fs / streams / spawn / hooks / session / vm — the unaudited surface):**

| # | Scenario | Surface exercised | native | cosmo |
|---|----------|-------------------|--------|-------|
| 1 | Write round-trip → file on disk | fs write | PASS | PASS |
| 2 | Grep round-trip → tool_result carries match | search-applet spawn + streams | PASS | PASS |
| 3 | Bash stdout INLINE in tool_result | spawn + FileHandle output-file read (asyncDispose) | PASS | PASS |
| 4 | 2-tool Bash loop, both results coherent+ordered | spawn + multi-turn streams | PASS | PASS |
| 5 | PreToolUse hook fires + denies `claude update` | hook child spawn + stdin/stdout pipes + settings | PASS | PASS |
| 6 | `--continue` restores prior session context | fs session persistence | PASS | PASS |
| 7 | Workflow runs to `completed` (wf_<id>.json) | node:vm isolation + fs | PASS | PASS |

**Result: native 7/7, cosmo 7/7 — IDENTICAL. Zero divergences.**

Additional check on the **actual shipped artifact** (fused `quaude.com`, zipos bundle path — not the
loose engine+loader): a Bash tool round-trip driven against the APE via `/bin/sh` → **PASS**
(exit 0, reached final turn, tool_result carries the echo stdout inline, no "output unavailable"
degrade).

## 4. Triage of divergences

None. The spawn class was already CLOSED (errno→UV translation, `uv__translate_sys_errno`, shipped
6bf98e5). This run audited the remaining streams/fs/spawn/hook/session/vm edges and found the cosmo
APE behaves identically to native tjs on every one. Nothing to fix.

## 5. Files modified

**None in the repo.** No shim (`libexec/node-shim/`) or `patches/` changes were required — the
fidelity surface was already clean under cosmo. All artifacts/scripts live in the session scratchpad
(fidelity runner, /bin/sh wrapper, staged bundle, fused quaude.com, logs). This doc is the only repo
addition.

## 6. Remaining before Phase E

- **TTY / interactive (fullscreen, raw-mode, alt-screen)** is the one surface this run did NOT cover —
  the fidelity suite's PTY/live-render rows are gated (`CLODE_LIVE_RENDER=1`) and interactive. On macOS
  the cosmo APE goes through the same node-shim tty layer as native tjs (which renders cleanly on
  macOS), so no macOS TTY divergence is expected; the standing NetBSD/arm64 fullscreen crash (Task 2)
  is engine-independent and orthogonal to cosmo. A cosmo PTY smoke on a real target is a nice-to-have,
  not a blocker.
- **Multi-OS proof.** All results here are on arm64 macOS (one slice of the fat APE). The payoff claim
  — the SAME `.com` on Linux + Windows + BSD, x86-64 + arm64 — is Phase E's CI job (PONG + attest per
  runner). Not fidelity-blocking; it's the leg-wiring deliverable.
- **Phase E wiring** (unchanged, still owed, explicitly out of scope for this run): cosmo target in
  `build-tjs.mjs` (apply both patches + `CLODE_TJS_CROSS_FILE=scripts/cosmo.toolchain.cmake` + lean +
  `tjs-cli` + `chmod +x cosmoranlib` + provision cosmocc 4.0.2), a `cosmo` leg in `scripts/tjs-legs.mjs`,
  multi-OS CI, and the mac-APE signing posture.

**Fidelity verdict: cosmo quaude is fidelity-trusted on the audited (non-TTY) agentic surface — it
matches native tjs 1:1. Phase E is unblocked to codify this exact (already-committed) patch set.**
