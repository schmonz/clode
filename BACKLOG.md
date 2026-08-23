# clode — tactical backlog

Concrete clode-under-Node divergences from native Claude Code, to triage and fix.
(Strategic feasibility risks live in `LONG-TERM.md`; in-flight designs in
`docs/superpowers/`. Done items are DELETED from here — git history is the record.)

## IN-FLIGHT HANDOFF (2026-07-31) — what's being juggled

Driver = the at-desk release-readiness plan (`docs/superpowers/plans/2026-07-28-at-desk-release-readiness.md`).

1. **Cosmo APE leg (Task 4b) — CLOSEST TO SHIPPABLE.** ✅ MCP-ws sha-1/endian bug fixed
   (`patches/libwebsockets-cosmo.patch`, wired into build-tjs.mjs); ✅ FULL agentic fidelity suite
   GREEN on the cosmo APE at parity with native (mcp-ws, tools 5/5, node-shim-agentic, workflow,
   subagent-diff) via the now-APE-aware harness; ✅ interactive + tty fixes landed earlier. REMAINING
   before ship: (a) a clean-from-scratch `build-tjs.mjs --target cosmo` + `agentic-mcp-ws` green in CI
   (gold-standard; the committed patch is byte-identical to the verified scratch build); (b) the
   multi-OS CI fan-out (run the SAME `.com` on Linux/mac/Windows/BSD runners); (c) flip the `cosmo`
   leg `publish:true` in `scripts/tjs-legs.mjs` + ship UNSIGNED with a documented Gatekeeper/quarantine
   note (decided: ships as `clode-<ver>-cosmo.com`). See memory `cosmo-libc-additive-leg`.

2. **Tiger / darwin-ppc agentic-turn deadlock — FIX IMPLEMENTED, arm64-PROVEN, ppc pending (2026-07-31).**
   The poll(2) event backend for old Darwin is IN (`fixupLibuvPollBackendOldDarwin`, knob
   `CLODE_TJS_DARWIN_POLL=1` → cmake `CLODE_DARWIN_POLL`, leg field `darwin-poll:true` on
   darwin-ppc + darwin-x86). It swaps `kqueue.c`→`posix-poll.c` + `no-fsevents.c` and drops
   `UV_HAVE_KQUEUE`, which also moves child-exit to SIGCHLD and async wakeups to pipes — so
   sockets, pipes, child exit, DNS/threadpool wakeups and signals ALL leave kqueue in one
   change. TTYs keep the proven select()-thread path. Accepted loss: `uv_fs_event`→ENOSYS
   (the shim's fs.watch is already a non-firing stub, and cosmo ships this way). PHASE 1
   GREEN on arm64: a poll-backend engine passes the full agentic gate (11/11, no skipped
   oracles) + the node-shim suite (166 pass/0 fail). Spec:
   `docs/superpowers/specs/2026-07-31-old-darwin-poll-backend-design.md`.
   **PHASE 2/3 ON REAL TIGER HARDWARE (2026-07-31): the kqueue deadlock is GONE; a SECOND,
   DISTINCT live-API stall remains.** With a hand-cross-built ppc poll engine (Mach-O ppc,
   `uv__kqueue_init` absent) cross-fused into a quaude and run on the Tiger VM against the
   deterministic mock: `-p` turn **exit 0, "Paris", first byte 337ms** (was: parked in
   `kevent` forever, mock received NOTHING); **Bash `outcome=ok`**; **Write actually wrote**
   `NEEDLE-TIGER-WRITE` to disk; Read closed its two-turn loop; the **TUI renders** (welcome
   box, animated spinner, theme picker, syntax-highlighted diff) **and accepts keystrokes**
   (advanced theme -> API-key -> OAuth screens). The bare poll engine also does **real
   HTTPS/TLS**: `fetch(api.anthropic.com/api/hello)` -> 200 in 275ms. So sockets, pipes,
   child-exit, async wakeups, signals, tty input and TLS all work under `poll(2)` on Darwin 8.
   **STILL RED — the fused quaude against the REAL api.anthropic.com stalls** during
   "Starting background startup prefetches", BEFORE any `/api/hello`. Signature: main thread
   parked in `poll`, all 4 threadpool workers idle in `uv_cond_wait`, **zero external
   sockets**, no child processes — i.e. awaiting something that never posts, the same CLASS
   as the original bug at a LATER phase. Reproduced with the real HOME *and* with a clean
   HOME holding only `.credentials.json`, so it is NOT plugin/session state. NOT a
   regression (the original bug hung the live path too, and hung the mock path, which is now
   fixed) — but it is what stands between Tiger and daily-drive fidelity. NEXT: instrument
   the prefetch path (the shim's `CLODE_SHIM_TRACE=1` fetch wrapper is baked into the fused
   loader, no re-fuse needed) to find which await never resolves.
   ALSO PENDING: the `darwin-ppc` CI leg has never built with `darwin-poll:true` — the
   engine proven here is a hand cross-build, so nothing shipped carries the fix yet.

   **THE RESIDUAL STALL IS ISOLATED (2026-07-31, REPEATABLE MATRIX, n=2 per row).** It is NOT
   the event loop, NOT DNS, NOT TLS, NOT the keychain. Harness: `/tmp/matrix.sh` on the Tiger
   VM — each row a fresh HOME, 420s hard limit, records exit code + elapsed + whether
   `API REQUEST` appears (so a fast wrong-reason exit can't pass as a round-trip):
     A mock via IP  (http://10.0.2.2:8790)        PASS x2  40-50s  "Paris"
     B mock via HOSTNAME (10.0.2.2.nip.io:8790)   PASS x2  40-50s  "Paris"   <- DNS exonerated
     C real api.anthropic.com + INVALID key       PASS x2  50s     "Invalid API key" <- TLS exonerated
     F real api + NO key, NO creds file           PASS x2  50s     "Not logged in"
     D real api + creds file, no key              HANG x2  >420s   apiReq=0
     E real api + creds file + invalid key        HANG x2  >420s   apiReq=0
   => **the mere PRESENCE of `~/.claude/.credentials.json` is necessary and sufficient**;
   both key states pass without it, both hang with it, and the hang is BEFORE any API request.
   RULED OUT with evidence: DNS (row B; plus NXDOMAIN/bogus hosts reject in ~343ms on the
   engine); TLS to the real endpoint (row C reaches a real API request); async-DNS UDP sockets
   (idle resolver sockets, not pending queries); `probeInternalNetworkAccess` (it is literally
   `async function vzm(){return null}`); the keychain/GUI-modal theory (the shim's `security`
   probe runs at lines 1-3 of 219, fails over -X to -p, concludes unusable, falls back to its
   file store — no modal, no SecurityAgent, no hung child, and the run continues past it).
   ALSO NOTE the `[timer]` trace is NOT trustworthy for "timers stopped": loader.cjs traces
   setTimeout creation+fire but NOT clearTimeout and NOT interval ticks, so "N scheduled /
   M fired" says nothing about pending timers. The libuv handle dump (new: CLODE_SHIM_HANDLE_DUMP=1
   + SIGUSR2, commit ab4f783) shows ACTIVE timers and 3 active io watchers at the hang.
   NEXT: the shim's `http`/`https` modules have NO tracing, so any request not made through
   `globalThis.fetch` has been invisible (the `[fetch]` trace saw exactly ONE request all run:
   `/api/hello` -> 200). The bundle carries a full token-refresh path (`refresh_token` x32,
   `oauth/token` x9) that only engages when credentials exist. Add a `[http]` trace to the
   shim's http/https modules, re-fuse, and re-run row E — that names the request that never
   settles.
   **DONE, NEGATIVE (2026-07-31, cc2ac10):** with the `[http]` trace live on a re-fused ppc
   quaude, row E still hangs (>450s) and logs **ZERO `[http]` lines** — the bundle never calls
   `http.request`/`https.request` here. One `[fetch]` for the whole run (`/api/hello` -> 200).
   So the hang involves NO http request of any kind, and the (separately notable) discovery that
   `http.request` was never implemented in the shim is NOT this bug. Building that tracer
   required implementing a minimal fetch-backed `http.request` client (cc2ac10, 193 lines in
   http.cjs) — UNREVIEWED and UNRELATED to this bug; decide whether to keep, review, or revert.
   STILL UNEXPLAINED: with a creds file present the process waits, before any API request, with
   no socket, no child, no busy worker, and no http/fetch in flight; the handle dump shows 3
   active timers and 3 active io watchers (one pipe, two UDP resolver sockets). Candidate next
   probes: (a) instrument the fs/crypto surface the credential path touches; (b) check whether
   the two UDP watchers hold a REAL outstanding query at the hang (the bare engine resolves and
   rejects correctly under LIGHT load — that needs re-testing under the fused runtime's load);
   (c) diff row C's debug log (passes, no creds) against row E's (hangs, creds) line by line
   from `attribution header` onward — the first divergent bundle step names the code path.
   **(c) DONE — the divergence is named.** Row C (passes): `attribution header` -> Fast mode x2 ->
   `Remote settings: Retry 1/5 after 541ms` -> `dispatching to firstParty` -> `API REQUEST`.
   Row E (hangs): `attribution header` -> Fast mode x2 -> `Remote settings: Loading promise timed
   out, resolving anyway` -> `Git remote URL: null` -> `No git remote URL found` -> SILENCE. So on
   the credentialed path the remote-settings load TIMES OUT (its timer fires — "resolving anyway"),
   then git-remote detection runs, and its CALLER never continues.
   **HANG RE-VERIFIED ON AN IDLE BOX (2026-07-31):** >420s, apiReq=0, same last line, with `ps`
   confirming ZERO other quaude processes. This matters because the original matrix ran while
   ELEVEN stale quaude processes were alive on the 1-CPU VM (see the process-hygiene note below),
   which could have explained the hangs as starvation. It does not — the hang is real.
   **PROCESS HYGIENE (cost real credibility today):** `pkill -9 -f` silently does nothing on
   Darwin 8, AND naive `for p in $(ps|grep|awk); do kill -9 $p; done` loops were ALSO failing
   silently — 11 orphans from six separate test rounds were still running hours later. ALWAYS
   re-check the survivor count after killing, and treat any timing measurement taken without that
   check as suspect.
   Original diagnosis below (still the WHY):

   **(root cause, unchanged)** The PPC
   quaude boots + authenticates + full startup + (bare) HTTPS/TLS, but an agentic turn deadlocks: **Darwin 8
   kqueue drops socket/pipe/SIGCHLD/async event delivery under the fused runtime's fd load** (ktrace-confirmed).
   Fix = a poll()/select() event-loop backend for old Darwin (NOT per-mechanism `osx_select` patches — see
   the kqueue-usage audit) = the same paleo-POSIX backend roadmapped for cosmo/retro. Needs a PPC engine
   rebuild to test. The VM's DNS was separately broken and is now FIXED. Full detail + audit in memory
   `tiger-ppc-agentic-turn-deadlock`. (Task 3's double-Ctrl-C wedge is a SEPARATE, already-TRIAGED
   node-faithful non-bug.)

3. **Windows fidelity differential (Task 1) — user-gated on an SSH-able Windows box.** Windows `.exe`
   asset naming already FIXED (`f061843`). Remaining: build both targets on Windows, run the
   mock-anthropic differential, triage divergences (shim gaps vs deliberate).

4. **Release-atomic naming ship (Task 4) — PARTIAL.** Done: Windows `.exe` + cosmo `.com` asset names
   (`f061843`, `3898be0`). Pending: CI bash-mirror of `canonical-name.cjs` + tripwire + the no-`v` pin in
   an atomic release commit. See memory `canonical-artifact-names`.

5. **Release cut (Task 5) — endgame, user-driven.** Bump surface = `VERSION` + `package.json` +
   `package-lock.json` ×2 ONLY (date versioning, `date-versioning-next-release`); notes from `CHANGELOG.md`
   via `--notes-file`; watch the full matrix (all tjs legs + win SEA + darwin universal + the cosmo `.com`)
   green. RESOLVED and off the list: NetBSD/arm64 fullscreen crash (doesn't repro on main); Tiger
   double-Ctrl-C wedge (node-faithful).

## Cosmo APE fidelity gaps — posix-poll fd-event delivery (2026-07-29)

Full fidelity run of a FRESH cosmo quaude (fused from the committed Phase-E leg) on the dev host
surfaced two real cosmo-only divergences (native tjs passes both). Cosmo's args-driven/`-p` agentic
path is SOLID (8/9 offline agentic rows pass; real-creds `-p` returns a live "PONG"; TLS/spawn/fs/render
all fine) — the gaps are input/socket-event-delivery:

1. **TTY (interactive) stdin reads never fire — ROOT-CAUSED + FIXED (2026-07-29).** ✅ Cosmo quaude
   is now interactively driveable on macOS (trust prompt advances to the main prompt; `ttyread3.js`
   RED→GREEN: keystroke read len=1 b0=65; end-to-end fused quaude.com verified). **REAL fix (tiny):**
   in `deps/libuv/src/unix/tty.c` `uv_tty_init`, SKIP the tty reopen under `__COSMOPOLITAN__` — force
   `r = -1` so libuv's existing "reopen failed → use the original fd" fallback kicks in. Why: cosmo's
   `ttyname_r(0)` returns the generic `/dev/tty` alias, and reopening it yields a fd that `poll()`
   immediately POLLNVALs (busy-spin, 1.8M polls, keystrokes never delivered). The ORIGINAL tty fd
   `poll()`s correctly in raw mode (proven by a standalone cosmo C test: `poll` on raw fd0 → POLLIN;
   `select` does NOT work, so osx_select was the WRONG approach and is abandoned). After the fix,
   strace shows ttyname_r=0, POLLNVAL=0, and the keystroke reads. **The multi-hour red herring:**
   cosmoar's incremental archive NEVER replaced `tty.c.o` inside `libuv.a` — every rebuild compiled a
   fresh object but LINKED the stale archive, so runtime always ran old code (nm on the object said
   "fixed", disasm of the final elf said "still reopens"). FIX FOR THE BUILD LOOP: force-clean
   `deps/libuv/libuv.a` (+ `.aarch64/libuv.a`) before `gmake tjs-cli`, or do a clean build — never
   trust the incremental archive under cosmocc. PRODUCTIZED ✅: reopen-skip landed in
   `patches/libuv-cosmo.patch` (commit b4f7b41, applies clean to pristine); a from-scratch `build-tjs`
   cosmo run (pristine vendor reset → committed patch, NO osx_select cruft) built a working engine and
   the clean engine passes the TTY read (`TTY-READ len=1`, strace ttyname_r=0/POLLNVAL=0). INTERACTIVE FIDELITY VERIFIED ✅
   (2026-07-29, manual PTY differential): F6 render (welcome box + prompt paint clean, no corruption),
   D6 resize (reflows narrower, no stale frame), and **G2 live-creds turn (real API streamed "Paris"
   in the interactive TUI)** all PASS on cosmo — the rows that were blocked by this bug. Driven via the
   /bin/sh trampoline in tmux (the "human differential oracle") because the automated node-pty harness
   can't drive the cosmo APE: node `execve` returns ENOEXEC on the MZ APE (the shell only runs it via
   its ENOEXEC→/bin/sh fallback, and `assimilate -m` does NOT produce a real arm64 Mach-O — it warns and
   leaves an APE). AUTOMATED HARNESS NOW APE-AWARE ✅ (2026-07-29,
   72bdcc5): `test/e2e-pty.cjs` gained `apeCmd()` (detects MZ magic → wraps `/bin/sh -c '"$@"' sh <ape> …`);
   `capture()` applies it centrally and the `version()` checks in interactive-render/-resize/-live-turn use
   it. Cosmo APE subjects now gate automatically: **F6 render 2/2, D6 resize 2/2, G2 live-turn (real creds)
   2/2, I1 update-notify 3/3.** Non-APE subjects unchanged (native-tjs F6 still 2/2). RUN RECIPE: build-based
   rows want `CLODE_TJS=<cosmo APE engine>` (e.g. a from-`build-tjs` cosmo `tjs`) + `CLODE_LIVE_RENDER=1`
   (+`CLODE_LIVE_ONLINE=1` for G2); update-notify wants `CLODE_QUAUDE=<a fused cosmo quaude.com>`. F3
   stale-frames still skips — unrelated env precondition (needs a logged-in `/doctor`), not cosmo-specific.
   (Superseded osx_select notes below.)

   ~~TTY (interactive) stdin reads never fire — ROOT-CAUSED (macOS-host-specific).~~ The interactive
   TUI can't be driven (trust prompt won't advance on any key). Engine-level differential nails it:
   bare cosmo `tjs` reads a **PIPE** stdin fine (`READ len=6`, identical to native) but a **TTY**
   keystroke times out (`setRawMode` succeeds, `uv_read_start` on the tty never fires) — native reads
   it. Cause: libuv's macOS tty workaround `uv__stream_osx_select` (a per-tty `select()` thread feeding
   a socketpair the main loop can watch; `deps/libuv/src/unix/stream.c:145-405`, chosen at
   `tty.c:219`) is ALL `#if defined(__APPLE__)`. macOS's kqueue/poll can't reliably watch tty fds —
   that's WHY the workaround exists (there's even a CLODE Tiger fixup at stream.c:315 forcing select
   for ttys). **Cosmo doesn't define `__APPLE__`**, so it isn't compiled → cosmo reads ttys via generic
   `poll()`, which on a macOS host doesn't deliver tty read events. **macOS-HOST-SPECIFIC**: cosmo on
   Linux/BSD uses poll on ttys (works there), so cosmo interactive likely works off-mac. FIX = port the
   osx_select select()-thread path to `__COSMOPOLITAN__` (force it for ttys, skip the kqueue probe like
   the Tiger fixup). Multi-site `#if __APPLE__ → || __COSMOPOLITAN__` patch + cross-host care; feasible
   via fast incremental rebuild (cosmo build tree persists). RED test: the `ttyread3.js` engine-level
   tty differential (cosmo TIMEOUT vs native READ).
   ROOT CAUSE PROVEN (2026-07-29) via cosmo `--strace`: `ppoll({...,{9,POLLIN,[POLLNVAL]}},...)→1` on
   EVERY poll — **cosmo's poll()/ppoll() returns POLLNVAL for the macOS tty fd** (the classic macOS
   "ttys/char-devices aren't pollable via poll()" limitation — the exact reason libuv uses kqueue+select
   on Apple). So the poll-based io loop never sees the tty readable → keystrokes never delivered. strace
   also shows the tty reopen `openat("/dev/tty",O_RDWR|O_NOCTTY)→9 ENOTTY` and `socketpair`=0, so the
   osx_select select()-thread (the CORRECT fix — select() DOES work on macOS ttys) never engaged.
   TOOLING (reusable, KEY): cosmo APEs support `--strace` (syscalls+returns) and `--ftrace` (function
   calls), symbolized via the `tjs.com.dbg`/`tjs.*.elf` sidecars next to the engine. This is THE way to
   debug the cosmo APE — C `fprintf`/`write(2)`/`open()`-probes all produce NO output (tjs redirects fd2;
   probe writes vanish), so DON'T instrument with prints; use --strace/--ftrace. `__COSMOPOLITAN__` IS a
   predefined macro (`cosmocc -dM -E`), confirmed effective (a `#error` inside the tty.c cosmo `#if`
   fired). Fast incremental rebuild: rm the target .o + `gmake tjs-cli` in the persisted build tree.
   REMAINING FIX WORK: make the osx_select select()-thread actually ENGAGE for the cosmo tty —
   `uv__stream_try_select` isn't wiring up the socketpair/thread (fd 9 is polled directly, POLLNVAL).
   Likely the `/dev/tty` reopen→ENOTTY makes the reopened fd's `isatty` gate fail (my cosmo branch bails
   `if(!isatty(*fd)) return 0`), OR skip the reopen under cosmo. Also verify select() works on the fd
   that poll POLLNVALs (it should on macOS — that's osx_select's premise). WIP osx_select port
   (compiles, doesn't yet engage) lives in the scratchpad cosmo-vendor working copy; repo untouched.

   FIX ATTEMPT 1 (2026-07-29, INCONCLUSIVE — observability wall): ported the osx_select select()-thread
   path to `__COSMOPOLITAN__` (guards in stream.c/tty.c/internal.h + `select` field via
   `UV_STREAM_PRIVATE_PLATFORM_FIELDS` in cosmo.h + kqueue-probe bypass since cosmo's sys/event.h is a
   stub). COMPILES + links (fast incremental: edit `$SP/cosmo-vendor` libuv → `gmake tjs-cli` in
   `$SP/cosmo-out/build`, cosmocc on PATH). Read STILL times out, and I could NOT verify why: stdin is
   `type=tty`/`isTerminal=true`, yet NO C probe fires — not fprintf(stderr), not write(2), not even an
   absolute-path open()+write at a GUARANTEED-hit point (`uv_guess_handle`). JS console.error + tjs
   writeFileSync reach disk; ALL C-level output vanishes on the stripped mac cosmo APE. So EITHER tjs's
   stdin bypasses `uv_tty_init` (osx_select port = wrong layer) OR C observability is broken on the mac
   APE. NEXT: use real tooling (lldb on a debug-symbol cosmo build, or a NON-APE mac cosmo-libuv build) —
   blind file-probes don't work here; a Linux cosmo build won't reproduce (mac-host-only bug). Repo is
   UNTOUCHED (all WIP in the ephemeral scratchpad working copy).
2. **MCP-over-WebSocket client never connects — FIXED (2026-07-30).** ✅ Cosmo `new WebSocket()` now
   connects (WS-OPEN against a local node ws echo server). ROOT CAUSE: libwebsockets' bundled
   `lib/misc/sha-1.c` gates byte-swapping on `BYTE_ORDER`/`LITTLE_ENDIAN`/`BIG_ENDIAN`; cosmo defines
   those as aliases to `__BYTE_ORDER`/`__LITTLE_ENDIAN`/`__BIG_ENDIAN` which it never defines → in `#if`
   arithmetic all read 0, so BOTH `==LITTLE_ENDIAN` and `==BIG_ENDIAN` are true (0==0) → sha-1.c compiles
   an inconsistent LE+BE byte mix → every lws SHA-1 is wrong → the ws client's `Sec-WebSocket-Accept`
   (=`base64(SHA1(key+GUID))`) check fails on every valid 101 (`HS: Accept hash wrong`). HTTPS was fine
   because TLS uses mbedtls SHA, not lws's builtin. FIX: **patches/libwebsockets-cosmo.patch** (new;
   applied `git -C deps/libwebsockets apply` in build-tjs.mjs `applyCosmoPatches`) re-derives the macros
   from the compiler's `__BYTE_ORDER__`/`__ORDER_*_ENDIAN__` builtins, gated on `__COSMOPOLITAN__`
   (behavior-neutral for other legs). Verified: applies clean to pristine lws; scratch rebuild → accept
   hashes match → WS-OPEN. FOLLOW-UP: a full clean `build-tjs.mjs --target cosmo` end-to-end + the
   `agentic-mcp-ws.test.cjs` row green on a fresh cosmo quaude (high-confidence; the productized patch is
   byte-identical to the verified scratch edit).

Cosmo's args-driven/`-p` agentic path is SOLID (8/9 offline rows; real-creds `-p` returns live PONG;
TLS/spawn/fs/render fine) — these gaps bound cosmo to non-interactive/agentic on macOS. Additive
soft-fail leg, so NOT a leg blocker. See memory `cosmo-libc-additive-leg`.

**FULL AGENTIC FIDELITY SUITE GREEN ON COSMO (2026-07-30).** With both fixes (tty + ws) on a clean
rebuilt engine, the entire `node --test` agentic fidelity suite passes on the cosmo APE at parity with
native tjs: agentic-mcp-ws (connect+handshake+tool-call over ws), agentic-tools 5/5 (Write/Grep/
multi-turn/--continue/PreToolUse-hook), node-shim-agentic 2/2 (Bash inline stdout, Edit/FileHandle.chmod),
agentic-workflow-complete 1/1, agentic-subagent-diff 1/1 (Task dispatch identical node-vs-cosmo-quaude).
The harness is now APE-aware end-to-end (node-shim-helper `engineSpawn`/`isApeFile`), so `CLODE_TJS=<cosmo
.com> node --test test/fidelity/agentic-*.test.cjs test/node-shim-agentic.test.cjs` is the standing gate.
No cosmo-specific divergences remain on the agentic surface.

## TRIAGED — Tiger/PPC double-Ctrl-C "wedge" is FAITHFUL, not a bug (2026-07-29)

Filed here so it is NOT re-chased. On slow-DNS boxes (Tiger/PPC VM), the TUI's double-Ctrl-C
appears to hang but actually exits cleanly (RC=0) after a ~65s teardown. Cause: `tjs.exit`→
`mod_os.c:38 exit()`→ C atexit → libuv `uv__threadpool_cleanup`→`pthread_join` blocks on a pending
`getaddrinfo` worker whose DNS lookup takes ~65s on that box. **Plain Node hangs identically** in a
dev-host differential (dispatch a blocking libuv threadpool op, then `process.exit` → both Node and
quaude wait for the join) — so it's libuv-inherent, shared with real Claude Code. The pending lookup
is bundle-driven (api.anthropic.com warmup + status.claude.com + Datadog, captured from naude). A
`_exit()` speedup was REJECTED (would diverge from Node; violates the fidelity doctrine). Mitigation
for slow-network boxes: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (drops the status/telemetry
resolves; api.anthropic.com stays). Maintainer decision (2026-07-29): accept faithful + document;
removed from release blockers. Full method + repro in memory `tiger-ctrlc-teardown-threadpool-join`.

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

## Spec sweep 2026-08-01 — the threads that had a spec but no backlog entry

Swept `docs/superpowers/` from 145 files to 16 by verifying each cluster against the
tree (windows/SEA/bats/hermetic/universal-binaries/phases and ~25 single workstreams all
shipped; deleted). The survivors are genuinely unfinished. These had NO backlog entry at
all, which is how they went quiet — recorded here so the remaining specs are the only
place work hides, not the last place anyone looks:

- **Target-matched assembly — PAUSED BY DECISION, not forgotten.** `providerFor` by-OS
  shipped; template-by-arch fixed (21127a5). Held per the 2026-07-19 call that cross-build
  waits on trusted daily-drive fidelity plus a durable naude-vs-quaude gate. Un-pause
  condition is the fidelity tier ledger above, so these two are coupled.
  Spec: `2026-07-19-target-matched-assembly-design.md`.
- **Universal cross-build Layer 1 — engine production, deferred half.** Layer 2 (clode
  cross-fuses from prebuilt engines) shipped and now range-fetches its slice. Layer 1 —
  one clang/zig + pinned sysroots replacing the per-target toolchain zoo, plus the target
  descriptor and `build-tjs.mjs --target Y` — is untouched. Depends on build-working-dir
  isolation (already tracked above).
  Spec: `2026-07-25-universal-cross-build-compiler-free-quaude-design.md`.
- **Feature parity #2 image (sharp/libvips) and #3 TypeScript (Bun.Transpiler).** Both
  DRAFT since 2026-07-15, both unimplemented, both sequenced after the runtime-retirement
  decision in the user's original order (SQLite ✓ → image → TypeScript → MCP computer-use).
  Neither is reachable from any current test, so quaude silently lacks them.
  Plans: `2026-07-15-image-sharp-spec.md`, `2026-07-15-typescript-transpiler-spec.md`.
- **Comparative performance fixtures.** A hermetic benchmark harness running the SAME
  bundle under quaude/naude/claude against fixtures, so QuickJS interpreter-tax shows up
  as wall-clock/RSS ratios instead of guesses. Directly serves the Tiger perf work
  ([[tiger-ppc-quaude-perf]]: sys-time is the tractable lever, and we are guessing today).
  Plan: `2026-07-24-comparative-performance-fixtures.md`.

Three more were closed out on 2026-08-02 by checking the tree rather than the spec, and
their plans deleted — recorded here so nobody re-derives them:

- **Retire the host-Node runtime (tjs-primary) — ACHIEVED.** clode ships as tjs binaries
  for 22 OSes and carries no Node ever; the pinned Node is fetched on demand only for a
  naude. Proven and CI-gated by `test/clode-native.test.cjs` "acceptance 4: the native
  builder BUILDS A NAUDE (fetch node + assemble + PONG), node absent from PATH". The
  older "clode-native builds quaude only / `--naude` refuses" note was stale.
- **quaude daily-driver hardening — ABSORBED into RECIPE.** BUG1 (0-byte `~/.claude.json`)
  is row A1, a `→` row citing a live test; BUG4 (in-TUI update unhooked) shipped as
  notify-only; BUG2 and BUG3 are the open probes E4 (`detached` / login opener) and F3
  (stale frames). Nothing was lost by deleting the plan.
- **At-desk release readiness — SPENT.** Tasks 4/4b/5 shipped (canonical naming, the cosmo
  leg, two releases). Task 3 was TRIAGED as node-faithful. Task 2 (NetBSD/arm64 fullscreen)
  is recorded above as not reproducing on main. Task 1 (Windows fidelity differential) is
  the only live remainder and already sits in the IN-FLIGHT HANDOFF.

## Engine-recipe identity — the two deferred halves (2026-08-22)

`scripts/engine-recipe.mjs` (the sha256 of the engine-source set) and
`scripts/templates-drift.mjs` (published-templates-vs-this-tree, its own ci.yml job)
shipped. Two deliberate follow-ups, in this order:

- **Stamp `recipe` into the published manifest — OPEN, and the cheap one.** Today
  `templates-drift.mjs` derives the PUBLISHED recipe by computing it at the release
  TAG (`git show <tag>:<path>`). That is sound — the engines in a release were built
  from that tag's tree by definition — but it is inference, and it needs full history
  in the checkout. Have `scripts/build-templates-manifest.mjs` write
  `recipe: <sha256>` into the manifest; `templates-drift.mjs` ALREADY prefers that
  field when present (`derivedFrom: manifest.recipe`), so this is one line plus a
  test, and it turns an inference into an assertion. It also makes the answer
  available to a `clode` that has no git checkout at all.
- **A recipe marker inside the engine binary — OPEN, and it needs care.** The
  strongest version of this check is a `tjs` that can state the recipe it was built
  from, so `obtainEngine` could refuse a stale engine at fetch time instead of CI
  catching it a push later. The marker must be injected as a build-time `-D`
  (build-tjs.mjs → cmake), NOT written into a patch: the recipe hashes
  `spike/quickjs/patches/*.patch`, so a patch containing the recipe is a fixed-point
  problem. Note also that this would make the pin gate meaningfully strict for the
  first time — an old clode meeting a new pack must still fail *readably*, not
  cryptically.

Also unresolved: the ci.yml job is RED on main until the next release cut, by
design (14 engine-source commits sit between v0.20260801.2 and main, none of which
the tjsPin gate can see). It is actionable red with exactly one remedy — republish
the pack — but it IS ambient red while it lasts, which is the thing
[[silently-gated-tests-hide-p0s]] warns about. If it is still red weeks from now,
that is the signal to cut the release, not to soften the job.

## Release follow-ups 2 + 3 — the unbuilt half of the 2026-07-27 spec

Spec `docs/superpowers/specs/2026-07-27-release-followups-design.md` carries five
follow-ups. Audited 2026-08-01 against the tree, not against memory:

- **FU1 one canonical version source — DONE** (`test/version-single-source.test.cjs`
  asserts VERSION == package.json == package-lock ×2 + a matching CHANGELOG section).
- **FU4 naming consistency — DONE** (`scripts/canonical-name.cjs`, b63233b). Remainder
  is the release-atomic pin work in the section above.
- **FU5 one range-fetchable templates blob — DONE** (6bd9088). Two assets
  (`templates-<pin>` + `.json`), Range-fetch a slice or `CLODE_TEMPLATES_BLOB` for
  fully-offline cross-build. Verified 206 through the real GitHub→CDN redirect.
- **FU2 fold the darwin legs into the one matrix — OPEN.** `release.yml` still runs
  `leg (only: notdarwin)` + `darwin-slices (only: darwin)`. The spec's keep/remove split
  stands: KEEP the universal `lipo`, Mach-O ad-hoc signing, and osxcross (real Apple
  constraints); REMOVE the `only:` bifurcation and the bespoke `pack: true` flag. Cousin
  to the `ciOnly` release-vs-ci discrepancy that already bit us.
- **FU3 gate BE correctness on the real netbsd-sparc guest — OPEN.** `be-oracle` is
  still `continue-on-error` against s390x under qemu-**user**, excluding five I/O test
  files, while `netbsd-sparc` already boots a REAL full-system guest and only runs a
  PONG smoke. Blocker named in the spec: the oracle diffs tjs against LIVE host node,
  which qemu-user permits in-process and a full-system guest does not — so it needs a
  goldenized oracle (record expectations from host node, replay in the guest) before the
  gate can move. Doing this retires a known-flaky non-gating signal, which is squarely
  [[ci-job-is-to-tell-the-truth]].

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

## ★ `spike/quickjs/` is not a spike — separate the components (2026-08-23)

**Noted, not planned.** User: *"spike/quickjs/ smells funny and suggests that QuickJS
should be in our build graph some other way than 'source code in this tree directly'.
And I bet there are several more separable components that should be separated."*

**The smell, concretely.** A directory named `spike/` — the universal signal for
throwaway exploration — is load-bearing production infrastructure. `PINS.md` is the pin
of record, read by `scripts/build-clode-main.mjs`, `scripts/build-templates-manifest.mjs`
and `release.yml`. `patches/` holds 23 engine patches. `atomic-shim.c` is compiled into
every engine. `qemu/` is consumed by two CI actions. Four of the six engine-recipe inputs
(`scripts/engine-recipe.mjs`) live under `spike/`. Nothing about that is exploratory.

**QuickJS itself is already NOT in the tree** — `spike/quickjs/vendor/` is 753M and
gitignored, so what we actually keep is a *pin plus a patch stack*. That is a coherent
thing; it is just not named or shaped like one, and it is the shape the user is asking
about: whether the engine should enter the build graph as a declared, versioned
dependency rather than as directory-shaped convention.

**Candidate seams, in the order the evidence supports them:**

1. **Engine recipe** — `PINS.md` + patch stack + `atomic-shim.c` + `scripts/*.toolchain.cmake`.
   The patch stack is ALREADY SPLIT ACROSS TWO DIRECTORIES: `spike/quickjs/patches/`
   (txiki/quickjs-ng) and repo-root `patches/` (the three cosmo ones). That split has
   already cost real money — the cosmo patches were not in the engine recipe at all, so
   `libtjs-cosmo.patch` rotted for 13 commits with no cache invalidation and no drift
   signal (fixed in a6fc3e8 by widening `FILES`, which is a patch over the smell, not a
   fix for it). One patch directory, or one manifest naming both.
2. **VM / emulation rigs** — `spike/quickjs/qemu/` is test infrastructure used by
   `build-leg` and `guest` actions. Unrelated to engine source.
3. **Genuine spike residue** — `results/`, `boot/`, `syntax/`, `probe.js`,
   `inventory.cjs`, `measure-mem.sh`, `bc-le-oracle.mjs`. Some is live documentation
   (design memos are cited by comments in `libexec/clode-fuse.cjs` and
   `libexec/bun-shim.cjs`) and some is dead. Worth separating "notes we still cite" from
   "notes about a decision already made".
4. **Provenance data** — `tls-cacert-provenance.json` is neither engine source nor spike.

**Why it is worth doing rather than tolerating.** The recipe is the identity of an
engine, and it is now load-bearing in three places (tjs cache key, `templates-drift`, the
manifest `recipe` stamp added in 4f86738). An identity assembled from globs over
directories that mean different things is one rename away from silently covering the
wrong set — the exact failure `test/engine-recipe.test.cjs` exists to catch, and the
exact one that already happened with the cosmo patches.

**Do not start this without a plan.** It touches the engine recipe, so a careless move
changes every engine hash and rebuilds every leg. See [[clode-backlog-plan-first]].

## ★ Move the engine build to cmake — the last hard Node dependency (2026-08-05)

Direction (user, 2026-08-05): "we need to move toward cmake when we move away from node."
Sequenced AFTER the Node-retirement work, but it is the piece that actually completes it.

**The asymmetry.** clode RUNS without Node — that shipped. clode cannot BUILD ITS OWN ENGINE
without Node, because `scripts/build-tjs.mjs` (3,270 lines) is the orchestration. So
"move away from node" is not done while the engine build needs it.

**The motivating evidence — a build that silently discarded a patch.** Patching any txiki JS
source under `src/js/**` had NO EFFECT: cmake compiles `src/bundles/c/**` (pre-compiled
quickjs bytecode arrays txiki git-tracks), and build-tjs.mjs regenerated those only behind an
opt-in `CLODE_TJS_REGEN=1`. A correct `AbortSignal.timeout` patch (+ its C binding) built
clean and changed nothing; the esbuilt `.js` HAD the change while the `.c` that compiled was
pristine upstream, three minutes older. No failure signal anywhere. Full detail in memory
`polyfill-patches-dropped-on-le`.

**Why that argues for cmake specifically.** txiki's own Makefile already declares the rule we
needed — `src/bundles/c/core/polyfills.c: $(TJSC) src/bundles/js/core/polyfills.js`. We bypass
it by driving cmake directly and shipping pre-built `.c`, then re-derive the ordering by hand
in imperative JS, and got it wrong. A declarative OUTPUT/DEPENDS rule regenerates when its
input changes, full stop: no flag, no fingerprint trailer, no staleness tripwire — because
staleness stops being expressible. We are currently building a tripwire to catch a class of
bug a real build graph makes unrepresentable.

**Split the work by what actually fits.**
- NATURAL for cmake: bytecode regen as custom commands with real deps; host-vs-target `tjsc`;
  the source fixups; per-target compile config; the cross-files we already hand it.
- AWKWARD for cmake: cosmocc toolchain provisioning (fetch + sha-pin a 441MB zip); vendor
  reconstruction (pinned clone + 16 patch applications); post-build hermeticity verification
  of the shipped binary; artifact naming/placement. cmake can shell out for these, but that
  just relocates the imperative code.
- So the likely shape is: **cmake owns the build graph; something small owns provisioning and
  verification** — and that something must run WITHOUT Node, i.e. quaude itself or shell.

**Constraints any replacement must keep.** 36 published run-targets including cross-builds,
cosmo APEs, and Tiger PPC; `scripts/tjs-legs.mjs` stays the single source of truth for leg
definitions ([[tjs-legs-manifest]]); the build hermeticity check on the shipped binary; and
the out-of-tree/local-disk build requirement below (this tree is NFS).

### ccache rides along with this (deferred 2026-08-06, user's call)

ccache was measured and the case is good, but it belongs HERE, not before: the
compiler-launcher wiring is a cmake concern, so doing it now would mean wiring it
twice. Numbers from a quiet box, so they do not have to be re-derived:

* cold build 308s; incremental on unchanged sources 56s; with regen skipped 50s —
  so regeneration itself costs only ~7s.
* The recurring cost is NOT regen: the source phase resets the vendor checkout
  every build, which forces recompiles even when nothing changed.
* `tjsc` is DETERMINISTIC — two runs produced byte-identical output
  (`e5b091ea...`), so those recompiles are of identical bytes. That is exactly
  what ccache converts into hits, and it is why the case is good.

Not installed on this box; installing it there and in CI is part of the cmake
work, not a prerequisite for it.

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

- **Local builds on the dev mac compile txiki against PKGSRC's `uv.h`, not the vendored one
  (2026-07-31). Latent, currently harmless, sharp.** txiki's FFI lookup sets
  `FFI_INCLUDE_DIR=/opt/pkg/include`, which lands `-I/opt/pkg/include` SECOND in the `tjs`
  target's include path — ahead of every vendored path. pkgsrc also ships libuv, so
  `vm.c` and friends `#include "uv.h"` from pkgsrc while `uv_a` compiles the vendored
  sources against `deps/libuv/include`. Two `uv_loop_t` definitions in one binary. It works
  today ONLY because both are 1.52.x with an identical layout: a pkgsrc libuv bump (or any
  vendored-side field addition) silently corrupts the loop struct with NO compile error.
  FOUND THE HARD WAY: the darwin-poll backend adds 4 fields to `UV_PLATFORM_LOOP_FIELDS`, so
  the local poll build got `uv_loop_t` 1104 (libuv) vs 1072 (txiki) → `poll_fds_used` read a
  pointer → `poll()` EINVAL → SIGABRT before the first JS line. CI and the cross containers
  are UNAFFECTED (no `/opt/pkg` there), and the lean profile the floor legs use
  (`ffi:'off'`) never adds the include. Fix candidates: force the vendored libuv include
  ahead of `FFI_INCLUDE_DIR`, or narrow the ffi include to the specific header. Until then,
  local engine builds that must match CI should pass `CLODE_TJS_FFI=off`. Same family as
  [[dev-box-state-hides-bugs]]: warm/foreign host state hiding — here, *creating* — defects.

- **Try `darwin-x86` WITHOUT the poll backend, sometime.** The old-Darwin poll-backend fix
  (spec `2026-07-31-old-darwin-poll-backend-design`) sets `darwin-poll: true` on BOTH 10.4-floor
  legs — darwin-ppc (where Tiger's kqueue event-drop is ktrace-confirmed) and darwin-x86 (where
  it is ASSUMED by the "on old Darwin, route nothing through kqueue unless we've PROVEN kqueue
  handles it" principle). i386 was never observed failing: there is no Tiger/i386 box, and the
  leg is `no-exec`. So the x86 knob is an unfalsified precaution, and it costs the leg its
  `uv_fs_event` (ENOSYS) plus a divergence from the x64 slice. WHEN a 10.4/10.5 i386 target is
  reachable (a qemu Tiger-x86 guest, or real hardware), build the leg BOTH ways and run the
  agentic differential: if kqueue delivers correctly on Darwin/i386 under the fused runtime's
  fd load, drop `darwin-poll` from that leg and keep it ppc-only. Either result is worth
  knowing — it tells us whether the Darwin 8 defect is kernel-wide or ppc-specific, which is
  direct evidence for the paleo-POSIX floor walk (`panther-floor-next-rung`).

- **~~`http.request`/`https.request` are a WALL in the node-shim (2026-07-31)~~ — CLOSED
  2026-08-22.** Implemented for real over `tjs.connect('tcp'|'tls', ...)`: request/get/
  ClientRequest for both modules, sharing ONE message parser with the server half, and
  characterized differentially against host node (`test/node-shim-http-client.test.cjs`, 22
  plaintext rows + 5 TLS rows, both engines driving the same origin). The 2026-07-31 entry's
  "today's evidence says nothing needs it" was RE-MEASURED before implementing, and was only
  half right:
    - **default Anthropic backend: genuinely latent, confirmed.** A `-p` turn, an interactive
      TUI boot, MCP over HTTP *and* SSE, and a run with `HTTP(S)_PROXY` set reach the client
      ZERO times. axios — the bundle's only heavy `node:http` user under real Node (bootstrap,
      event_logging, mcp-registry, metrics_enabled, datadog) — picks its **XHR** adapter under
      tjs, because txiki defines a global `XMLHttpRequest` and axios prefers
      `['xhr','http','fetch']`. Those requests all complete today (200/202/401 observed).
    - **Bedrock: NOT latent.** `CLAUDE_CODE_USE_BEDROCK=1` with no static credentials drove 10
      `http.request` calls at the EC2 instance metadata service (169.254.169.254) from the AWS
      SDK credential chain; with static credentials it drove an `https.request` at
      `bedrock.<region>.amazonaws.com/inference-profiles` from `@smithy/node-http-handler`.
      Host node, same bundle/env, degrades cleanly to "Could not load credentials from any
      providers"; quaude printed `API Error: <nameless> is not a function` (QuickJS TypeErrors
      carry no symbol name), and on a real EC2 instance role Bedrock could not work at all.
  Deliberately NOT covered, each throwing a named error rather than approximating: `socketPath`,
  `createConnection`, `lookup`, `localAddress`, `family`
  (`ERR_SHIM_HTTP_UNSUPPORTED_OPTION`); TLS options with no `tjs.connect` equivalent — pfx,
  passphrase, secureContext, ciphers, minVersion, maxVersion, checkServerIdentity,
  secureProtocol (`ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION`); non-`chunked` Transfer-Encoding.
  Documented divergences: no connection pooling (always `Connection: close`), `setKeepAlive`/
  `cork`/`uncork` no-ops, `socket.end()` full-closes rather than half-closes.

- **npm `ws` still cannot connect under the shim, and now says so by name (2026-08-22).**
  Implementing `http.request` did NOT unblock `ws`, as had been hoped. Reason, measured:
  `ws/lib/websocket.js` unconditionally sets `opts.createConnection = opts.createConnection ||
  (isSecure ? tlsConnect : netConnect)` before calling `request(opts)` — so `ws` never uses the
  client's own socket; it demands `net.connect`/`tls.connect`, which remain walls. The shim's
  client refuses `createConnection` by name (`ERR_SHIM_HTTP_UNSUPPORTED_OPTION`) instead of
  ignoring it and connecting somewhere the caller did not ask for. Unblocking `ws` therefore
  means implementing a real `net.Socket` (it also reads `socket._writableState.length` for
  `bufferedAmount`), not more HTTP. Not needed today: quaude's WebSocket transport is the
  engine's own header-capable native `WebSocket` (see `libexec/bun-shim.cjs`), and that wiring
  was deliberately left untouched.

- **~~HTTP(S)_PROXY is silently ignored under quaude~~ — HALF WRONG, and the true half is
  FIXED (2026-08-22).** The earlier entry claimed "the engine's `fetch` and `XMLHttpRequest` do
  not consult the proxy environment at all". RE-MEASURED against a local recording proxy, that
  is FALSE: the engine honours `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for both (txiki's lws
  client vhost — `tjs__parse_proxy_url`/`no_proxy` matching in `src/lws-utils.c`), it tunnels
  even plain http through `CONNECT`, and a *dead* proxy makes the request FAIL rather than fall
  back to direct. A real `-p` turn through a local proxy shows every request arriving there,
  Messages POST included. **The lesson is about the instrument, not the engine:** the original
  measurement was taken with a harness whose mock server lived in the same process as a
  `spawnSync`, so the mock could never accept a connection — everything "went direct" because
  nothing could arrive anywhere. A client-side observation cannot tell "proxied" from "direct";
  only the proxy's own log can.
  The true half: the node-shim's own http/https CLIENT (ours, over `tjs.connect`) ignored the
  proxy environment completely, and ignored a proxy AGENT the caller passed. That is a
  naude-vs-quaude divergence — clode sets `NODE_USE_ENV_PROXY=1` for every target it builds
  (`libexec/target-env.cjs`) and node >= 24 honours the proxy env in its http/https clients
  under that flag — and it was REACHABLE: `CLAUDE_CODE_USE_BEDROCK=1` with a proxy set sent the
  AWS credential chain's IMDS requests (169.254.169.254) straight past the proxy, nothing
  arriving there at all. Now fixed: node's semantics ported (absolute-form request line,
  `proxy-authorization`, `proxy-connection`, global-agent-only, `NODE_USE_ENV_PROXY` strictly
  `"1"`, node's exact `no_proxy` matcher), proved by
  `test/node-shim-http-proxy.test.cjs` against a recording proxy and end-to-end on a fused
  quaude (the IMDS requests now arrive AT the proxy, in absolute form).
  **STILL OPEN, and now loud instead of silent: an https ORIGIN through a proxy.** The CONNECT
  tunnel is trivial; starting TLS on the socket it returns is not — `tjs.connect('tls', ...)`
  always makes its own connection and the engine exposes no adopt-fd/startTls entry point
  (`src/js/core/sockets.js`). So that case throws `ERR_SHIM_HTTPS_PROXY_UNSUPPORTED` rather
  than connecting directly (a direct connection *is* the silent bypass). Closing it means an
  engine patch: either TLS-over-an-existing-socket, or a `proxy:` option on the TLS connect that
  does the CONNECT preamble in C. Same for a socks proxy: node ignores non-http(s) proxy URLs
  and so do we, but we now say so once on stderr instead of bypassing quietly.
  Two smaller residues, both named where they bite: (1) `ALL_PROXY` is honoured here even though
  node ignores it — a DELIBERATE divergence, because the engine honours it for fetch/XHR and a
  client that did not would be the same bypass one env var over; (2) an `https://` PROXY URL
  works, but its certificate can only be trusted via a caller-supplied `ca` — measured, neither
  `SSL_CERT_FILE` nor `TJS_CA_BUNDLE` reaches `tjs.connect('tls', ...)`, so there is no
  environment knob for a private CA on a client socket (node has `NODE_EXTRA_CA_CERTS`). An
  untrusted proxy cert fails visibly; it never falls back to a direct connection.

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
like the native tjs template. PHASE D DONE — quaude.com does a FULL AGENTIC TURN under Cosmopolitan (2026-07-29). `clode build`
smoke PASSES: "PONG round-trip ok, attest ok". So the fused 49.6MB `quaude.com` APE is a fully
working Claude Code single binary: boots, runs the CLI, TLS to the API, AND completes a full agentic
turn (prompt → API → streaming response → output → sha attest). The last runtime bug was the
agentic-turn SIGABRT (bfb6299): a threadpool worker's futex(FUTEX_WAIT) returned EINTR when SIGCHLD
(a spawned child, e.g. `rg`, exiting) interrupted it, and libuv's uv_cond_wait/timedwait abort() on
any non-zero pthread return (POSIX swallows EINTR; cosmo surfaces it) → spawning any child that exits
aborted quaude. Fixed by retrying on EINTR. THREE genuine latent libuv bugs found+fixed this arc, all
upstreamable: UV__ERR sign (#if EDOM>0), uv_exepath (GetProgramExecutableName), uv_cond_wait EINTR.
SELF-MODIFICATION CHECK (2026-07-29): cosmocc 4.0.2 APEs do NOT auto-assimilate — VERIFIED our
quaude.com is byte-identical (same sha256) before/after a run, APE header + tx1k1 trailer intact. So
the shipped binary stays a pristine portable APE (runs on every host after any run) and the fuse
trailer/attest are stable. (Old APEs self-modified their header on first run; cosmocc 4.x makes
assimilation explicit — `--assimilate` only.)

SPAWN FIDELITY FIX SHIPPED (2026-07-29, 6bf98e5): the child_process/spawn divergence is FIXED. Root
cause was the errno→UV translation gap: the UV__ERR sign fix made libuv return -runtime_errno, but
the enum uses fixed -40xx codes under cosmo, so uv_err_name couldn't name them — a missing-binary
spawn reported `code='Unknown system error -2'` (was even `-78` pre-sign-fix) not `ENOENT`, breaking
the node-shim's e.code checks. Added `uv__translate_sys_errno` (src/unix/cosmo.c, 69 #ifdef-guarded
mappings) routed through UV__ERR under __COSMOPOLITAN__. VERIFIED: tjs.spawn of a missing binary now
throws code=ENOENT; in a real agentic run `rg` now fails GRACEFULLY ("ripgrep not found on PATH…"
instead of "spawn rg Unknown system error -78") and the hook `setEncoding of null` cascade is GONE.
Smoke still passes (PONG + attest). So hooks / rg-search / Bash-tool error handling are correct now.

NEXT — the full FIDELITY RUN (to enumerate remaining diffs): the test/fidelity/ agentic suite
(agentic-tools, agentic-subagent-diff, agentic-workflow-complete) needs (a) a reference binary
CLODE_PROVIDER_BIN (naude or a real claude), and (b) the cosmo engine behind a /bin/sh wrapper (the
APE can't be execve'd directly — same MZ→sh issue clode-fuse already solves) pointed at via the
engine's bootP path. Set that up, run vs the cosmo quaude, triage diffs — likely a few more
node-shim/libuv cosmo gaps (the spawn class is now closed, but streams/tty/fs edges are unaudited).
- PHASE E (wire the leg): build-tjs.mjs cosmo target = apply patches/libuv-cosmo.patch +
  patches/libtjs-cosmo.patch + CLODE_TJS_CROSS_FILE=scripts/cosmo.toolchain.cmake + force lean
  (mimalloc/ffi/wasm/sqlite OFF) + build target `tjs-cli` + chmod +x on cosmoranlib; provision
  cosmocc 4.0.2 (pin sha 85b8c37a…); add a cosmo leg to scripts/tjs-legs.mjs + multi-OS CI (run the
  SAME .com on Linux/mac/Windows/BSD). Do this AFTER fidelity so it codifies the final patch set.
  Fuse APE-spawn (clode-fuse MZ→/bin/sh) already done.

PHASE D FUSE WORKS END-TO-END (2026-07-29): `CLODE_TJS=<cosmo-tjs> clode build` produces a 49.6MB
`quaude.com` APE (cosmo engine + full quaude payload: Claude bundle + node-shim + bytecode) that
BOOTS and runs Claude Code — `--version` → 2.1.218, `--help` prints the full CLI. Fix shipped
(90d59d4, clode-fuse.cjs): the fuse spawns the template engine (to append the payload) and
smoke-tests the result by spawning it; an APE begins with the DOS 'MZ' header so execve rejects it
(ENOEXEC) on non-Windows hosts — detect MZ-magic templates and spawn via /bin/sh (ENOEXEC→script
fallback). REMAINING — RUNTIME: the full mock AGENTIC round-trip SIGABRTs (smoke: "did not complete
the mock round-trip", SIGABRT, empty stdout/stderr) — an abort() in a deeper node-shim path under
cosmo exercised by real agent execution (streaming/tool-use/fs), same CLASS as the boot hang. CLI
paths (--version/--help) and basic -p don't crash. NEXT: reproduce with the mock (startPongMock) +
--debug-to-stderr to find the aborting op, likely another cosmo libc/errno/syscall gap. Then E
(wire the cosmo leg into build-tjs.mjs + tjs-legs.mjs + multi-OS CI). Build-cache note: incremental cmake-on-NFS
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

## ★ OPEN — MCP over SSE POSTs to `/[object Object]` under quaude (2026-08-06)

**Symptom.** With an `{"type":"sse"}` MCP server, quaude opens the stream fine and
receives the `endpoint` event, then POSTs its JSON-RPC to a path that is a
STRINGIFIED OBJECT. Straight off the server's wire log:

```
<< GET  /sse?_=1786022754527
<< POST /[object%20Object]   {"method":"initialize",...}
```

The upstream binary against the SAME server completes `initialize` -> `tools/list`
-> `tools/call` and returns the needle. So the transport works; ours mis-builds the
POST URL.

`new URL('[object Object]', 'http://h/sse')` resolves to exactly `http://h/[object
Object]`, so the value handed to the URL constructor was already an object — i.e.
the `endpoint` event's `data` is not the string the parser expects.

**ELIMINATED with evidence — do not re-chase:**
- `new URL(rel, base)` with a STRING base and with a URL-OBJECT base: identical to
  node.
- `URL.parse(rel, base)` (the static form): present and identical to node.
- `fetch()` response-body chunks for the SSE stream: byte-identical to node
  (`Uint8Array`, decodes to `event: endpoint\ndata: /messages?sessionId=probe`).
- `TextDecoderStream` / `TransformStream` via `pipeThrough`: yields the same
  STRING chunk as node.
- `EventSource` is undefined in node, engine, and shim alike, so the bundle parses
  the stream itself — this is not a missing-global problem.

**Where to look next:** whatever turns a parsed SSE event into the endpoint value.
Everything BELOW that (stream bytes, decode, URL resolution) is proven equivalent,
so the divergence is in the event-object shape the bundle's own parser builds —
likely a `MessageEvent`/event-record field that is a string under node and an
object under the shim. Instrument the value passed to the URL constructor rather
than re-testing the layers above.

**Severity.** MCP/SSE is unusable under quaude; MCP over stdio (fixed 2383de2) and
over HTTP (fixed fc54ae9) both work now. Bundle references: http 314, stdio 136,
sse 94, ws 24 — so SSE is the last common transport still broken. ws is untested.

## ★★ SHIPPED ENGINE TEMPLATES PREDATE THE uid/gid FIX — cross-fused Linux quaude is DOA (2026-08-09)

**Every `clode build --target linux-*` produces a binary that cannot run on Linux
at all.** It dies before doing any work:

```
Temp directory /tmp/claude-1000 is owned by uid 0, expected 1000.
Refusing to use it — another user may have pre-created it.
```

The directory is genuinely owned by 1000 (`stat(1)` agrees). The bundle is told
0, so its tmpdir-ownership guard refuses and exits.

**Root cause: a STALE published engine, not a code defect.** The shim is already
correct — `libexec/node-shim/modules/fs.cjs` reads `raw.uid` and only falls back
to 0 when the ENGINE omits it, with a comment naming this exact failure. The fix
landed 2026-08-04 in 906af8b ("surface real uid/gid from FSS.stat"). But the
downloaded engine templates are all pinned `26.6.0-1a230d3`, built 2026-07-27 —
BEFORE that commit:

| engine | `__tjs_fs_sync.stat()` keys |
|---|---|
| template `tjs-linux-arm64-26.6.0-1a230d3` | `size, mode, mtimeMs, kind` — **no uid/gid** |
| built from current source on the VM | `size, mode, **uid, gid**, mtimeMs, kind` |

So the shim's fallback fires and reports uid 0. Proven from inside the fused
binary with `CLODE_PROBE`: `statSync uid=0`, `getuid=1000`, `raw engine
uid=undefined`.

**This hits the product's headline feature.** One-host-builds-all-quaudes goes
through `clode build --target`, which DOWNLOADS a template and OVERWRITES
`CLODE_TARGET_TEMPLATE` (clode-fuse.cjs:907) — so even an operator who builds a
correct engine locally and exports that variable is silently ignored. CI-built
release artifacts compile from source and are NOT affected; this is the
user-side cross-fuse path only.

**Every template is from the same stale build** (all `1a230d3`, dated 2026-07-27),
so assume every cross-fuse target is affected, not just linux-arm64. The guard is
what makes it VISIBLE on Linux; other targets may be silently degraded wherever
stat().uid matters.

**Fix:** republish the engine templates from current sources. Then re-drive the
cross-fuse targets. Worth adding a tripwire: a template whose tjs pin predates a
known-required patch should fail the build loudly rather than fuse a binary that
cannot boot.

**Blocked on this:** `linux-arm64-glibc` floor rows. The VM-built engine works, but
`clode build --target` will not use it, so a good Linux quaude cannot currently be
produced from this host without bypassing the template path.

## ★ HANDOFF — operational state at 2026-08-22 (read this first)

Written at the end of a long session, for whoever picks this up. The durable
record is: this file, the commit messages (deliberately long), the memory notes,
and the tests. Anything below is the perishable part that lives nowhere else.

**Unpushed:** `195af60` (proxy fix). `origin/main` is at `0decc98`.

**THE OPEN QUESTION.** CI run **32573776213** (`ci` on `0decc98`) had 20 of 32 jobs
failing while still in progress — legs on linux, windows AND darwin. That is
AFTER the regression fix, so the first thing to establish is which of these it is:

- Is the leg failure the SAME `SIGINFO`-shaped compile error as before
  (`src/signals.c: 'X' undeclared`)? Then the guard fix is incomplete — look for
  another unguarded name, or a group whose names still come from the host.
- Is it a DIFFERENT error? Then the constants fix worked and this is new.
- Is it just slow/cold? `ed0d8ff` made the tjs cache key consume
  `scripts/engine-recipe.mjs`, so the key CHANGED ONCE and every leg rebuilds its
  engine from scratch on the first run after. Expected, and it is not a failure.

Do not guess between those three. Read the logs; `gh api
repos/schmonz/clode/actions/jobs/<id>/logs` and grep for `error:` — `gh run view
--log-failed` is drowned by git-config teardown noise in this repo.

**TWO ATTRIBUTION TRAPS, both live right now:**

1. `upstream-drift` run 32555253017 is RED, and that does NOT mean upstream broke
   us. It ran on `d4f831c7`, which had my constants regression; its `boots` job
   builds the musl leg and died on the same compile error. Re-run it against a
   green commit before believing anything it says. (This is exactly the misread
   that job's own header warns about, and I nearly made it.)
2. `tjs-legs` run 32555844772 (netbsd-arm64) is RED for the same reason — it was
   dispatched to prove the errno fix made that leg green, and it proved nothing.
   Re-dispatch: `gh workflow run tjs-legs.yml --field tier=release --field
   only=netbsd-arm64`.

**`templates-drift` is RED BY DESIGN** until a release is cut (published engines
are 3 weeks stale). Do not "fix" the check. Cutting a release is the remedy, and
the check will then go green as evidence rather than assumption. See the
templates section above — republishing WITHOUT the recipe stamp silently resets
the clock, so land the manifest `recipe` field with or before the republish.

**Renovate:** 8 open PRs are not stuck on Renovate. `automerge: true` with no
`ignoreTests` means they wait for a green base — a red main blocks all of them.
They should drain by themselves once main is green. Note that pushing to main
re-triggers all 8 (their merge commits are invalidated), which looks like CI
noise from a push and is not.

**Still open, with full diagnoses in the commit messages / sections above:**
`close()` while CONNECTING is ignored (pre-existing, may be reachable via the
bundle's connect-timeout path); the template cache dead-ends on a stale entry
with no re-fetch; `net.Socket` over `tjs.connect` is what real npm `ws` needs
(NOT `http.request`, which was already tried); glibc legs will report 55 fs
constants where node reports 57 until `_GNU_SOURCE` reaches the `tjs` target.

**The lesson worth carrying:** four separate times this session the INSTRUMENT was
wrong, not the thing measured — a mock's handshake GUID, a mock that never
answered a close frame, a fidelity test comparing both sides through JSON, and a
proxy mock that could not accept connections because it shared a process with a
`spawnSync`. Assert on what ARRIVED at the far end, always run the reference
implementation against the same mock, and prove a test fails before believing it
passes.
