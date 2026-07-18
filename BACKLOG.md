# clode — tactical backlog

Concrete clode-under-Node divergences from native Claude Code, to triage and fix.
(Strategic feasibility risks live in `LONG-TERM.md`; in-flight designs in
`docs/superpowers/`.)

## ★ ACTIVE FRONTIER (2026-07-14) — the general-purpose cross-build matrix

North star (user, 2026-07-14): a cross-build matrix "as **reproducible, large,
well-tested, and reasonably fast** as we can possibly make it." Sequencing:
**(1) bank the NetBSD approach FULLY, then (2) resume the general machinery.**

- **DONE:** the tier-2 cross program — 4 weird arches green + v0.1.3 cut
  (netbsd-sparc, linux-riscv64, linux-s390x, netbsd-m68k). The exec=cross path is
  parameterized (cross-file/cross-apt/atomic-shim/tier2); a `verify` rung
  (smoke|qemu-user|none) + an ELF **arch gate** (`file(1)` — because verify=none
  legs had no arch check and shipped an x86-64 labeled m68k once). NetBSD
  `build.sh` cross proven generic (m68k).

- **NEXT (task #8, v0.1.4): bank NetBSD fully — the arch fleet.** 43 MACHINE_ARCH
  values, ~20-24 distinct buildable. Generalize `netbsd-m68k.toolchain.cmake` →
  ONE param'd file (triple+processor from the leg); one leg per arch; batch
  wall-walk (canonical-LE handles BE; atomic-shim for 32-bit-no-64bit-atomics;
  ia64/or1k/vax/m68000 may not build). The three m68k fixes are already generic
  NetBSD-cross wins (CMAKE_SYSTEM_NAME NetBSD, atomic-shim-in-exe, native-build
  guard).

- **Then: the four quality bars for the WHOLE matrix (native + cpa/vmactions VM +
  Debian-cross + NetBSD build.sh + darwin cross):**
  - *reproducible* — immutable pins everywhere: SHA-pin `netbsd-src` (deferred
    from v0.1.3; needs fetch-by-SHA in the composite) + a Renovate annotation;
    digest-pinned images; honest-floor SDKs. The Renovate doctrine (`f2a3c11`)
    backs this.
  - *large* — the NetBSD fleet, then the same treatment for other build.sh-class
    and Debian-cross-class targets.
  - *well-tested* — push verify coverage up: qemu-user where it exists,
    qemu-system (NetBSD level-3) as the upgrade, arch gate everywhere, attest.
  - *reasonably fast* — cross-build over in-guest TCG where possible (cross =
    minutes vs TCG = ~hour); cache toolchains (machine+src-rev) + tjs
    (source-hash); tmpfs for disk-bound local loops.

### Known shipped-artifact bugs

- **`dragonflybsd-amd64` leg red — UPSTREAM VM-IMAGE infra, NOT our code (2026-07-18,
  track-only per user).** The leg fails at guest SETUP, before any tjs build:
  `Error updating repositories!` + `mount_hammer2: cluster_connect(/dev/da0s1d@ROOT)
  failed` — the DragonFlyBSD 6.4.2 guest can't update pkg repos / mount its FS.
  Persistent across runs; it's the ONLY non-green job while everything that's ours
  (test both OS, node-shim-oracle ×2, self-update-e2e, windows) is green, so the run
  reads "failure" over a lie about our code. We use `cross-platform-actions/action@v1.3.0`
  (`.github/actions/guest`), NOT vmactions (that's only solaris/openindiana here).
  Can't route around it: **6.4.2 is the ONLY DragonFlyBSD version cpa supports.** No
  open upstream issue tracks it — cpa has none dragonfly-specific (closest: #111 "No
  space left on device"); vmactions/dragonflybsd-vm (a different action) has ZERO open
  and CLOSED prior art that IS our symptom (#12 "low disk space only on DragonflyBSD",
  #5 "Installing packages is broken") — so this is a recurring DFly-VM-image class
  problem. The leg is `publish: true` + hard-gating with NO `soft-fail` and NO Renovate
  annotation on its guest-version. When ready to act: demote to soft-fail (a leg whose
  guest won't boot ships nothing anyway) and/or file a cpa issue with the two error
  strings above + the closed-vmactions links. For now: watch upstream.
- **RESOLVED 2026-07-18: `--quaude-attest` on Haiku ("exits 0 after only the manifest,
  zero member lines") was the tjs >64KB pipe/socketpair WRITE DEADLOCK, not a WebCrypto
  or closure-size problem.** Hypothesis 2 in the old entry (tjs dropped queued stdout
  writes past the first block) was the right one. Fixed by `50646d9`
  (`fix(tjs/haiku): pipe() child stdio — Haiku's socketpair deadlocks past 64KB`), the
  same fix that cleared the general write deadlock. CI-confirmed: haiku-x64 leg green at
  `60dc7cb` (run 29646287285), job log reads `PONG round-trip ok, attest ok`. The
  manifest is small (<64KB, gets through); the hundreds of `ok <member>` lines are the
  bulk stream that stalled — so it looked like "only the manifest, then nothing, exit 0."

- **RESOLVED 2026-07-15: darwin-universal codesign on old macOS.** The universal
  clode carries a fat (x64+arm64) tjs template; Mavericks-era `codesign_allocate`
  choked on the arm64 slice's newer load command (LC 5). Fixed by `233190a` +
  `efbd4c5` (fix (a) from the original weigh-list): on the builder path, thin the
  fat template to the host arch before codesign via a direct in-place
  `lipo <file> -thin <hostSlice> -output <file>` — no `-archs` probe (old `lipo`
  rejects that flag, which is why the first attempt's probe silently no-op'd the
  thin). Proven end-to-end on REAL hardware (OS X 10.9.5 Mavericks, Darwin 13.4):
  `clode build` logs "thinned fat template to x86_64", re-signs, fuses a working
  29MB x86_64 quaude from the fat engine; 10/10 unit tests on the direct-thin
  contract. The fuse+codesign path is now solid for the tjs-everywhere clode.

- **darwin-universal i386/ppc slices are `no-exec` — clode by construction,
  unverified.** The universal artifact lipo's four bare tjs engines (arm64, x64,
  i386, ppc) then fuses ONE canonical-LE trailer spanning all slices, so running
  the i386 or ppc slice carves the same payload and *is* full clode — NOT just the
  engine. But i386/ppc are cross-built and never smoked (no such macOS in CI), so
  an arch-specific boot bug would only surface on real hardware. Test-coverage
  gap, not a packaging defect (same class as the arch-gate lesson: green ≠
  verified-on-arch). **User will smoke the shipped binary on Tiger/PowerPC**
  (2026-07-15) — fold the result back here.

- **CLEANUP (not a bug): the builder embeds an all-four-slice fat template, but
  only arm64+x64 are real build hosts** (i386/ppc are no-exec engine-only slices —
  nobody runs `clode build` on a PowerPC Mac). Embedding an arm64+x64 template
  instead of the full fat one trims builder bloat with no capability loss. Does
  NOT remove the codesign thin-on-failure fix (the arm64 slice is still present,
  so old-macOS codesign still needs it).

### Known runtime bugs

- **`clode fetch` looks eternally stuck at 0 bytes.** Reported 2026-07-15.
  **FIXED 2026-07-15 (session "daily-driver").** ROOT CAUSE was `clode-net.cjs`
  `downloadFile` buffering the ENTIRE ~240MB provider binary via `res.arrayBuffer()`
  then `writeFileSync`ing ONCE at the end — dest sat at 0 bytes the whole download
  (looked hung) and a 243MB arrayBuffer hangs/OOMs under tjs. FIX SHIPPED: dest mode
  now STREAMS `res.body.getReader()` → `fs.openSync/writeSync/closeSync` chunk-by-
  chunk (a WHATWG primitive verified working under BOTH host node AND the tjs fetch —
  `fs.createWriteStream`/`Readable.fromWeb`/`stream/promises pipeline` were the
  original plan but createWriteStream is ABSENT from the node-shim, so the fd-loop is
  the portable choice). Added optional `opts.onProgress(received, total)`; the
  provider-fetch caller (`clode-update.cjs`) renders a throttled in-place TTY
  progress line (percent + MB) / 10%-newline for piped stderr. New test
  `test/clode-net.test.cjs` "streams to dest with incremental progress" (multi-chunk
  server, asserts per-chunk monotonic progress summing to content-length). Full
  offline suite green (450 pass / 0 fail). NOTE: this DECOUPLES from the config
  0-byte bug — the fs write does NOT truncate (see corrected config entry below).

### Known quaude runtime bugs

- **quaude does not persist config across invocations (NetBSD/arm64 at least).**
  Reported 2026-07-15: every `quaude` launch requires choosing the theme AGAIN and
  logging in AGAIN — neither the config (`~/.claude.json` / theme) nor the
  credentials survive the process exit. Two likely-independent faults to check:
  1. **Config write — ROOT CAUSE FOUND + FIXED (2026-07-15, session
     "daily-driver").** The 0-byte `~/.claude.json` (also broke `-p` smoke:
     "Unexpected end of JSON input") was **the node-shim `fs.writeFileSync` not
     supporting the fd-as-first-arg form.** Extracted the real CC (`clode-extract`
     on the native `~/.local/share/claude/versions/2.1.179`, no fetch) and read its
     atomic config writer `ED6` (`saveConfigWithLock`):
     `const fd = fs.openSync(tmp, O_WRONLY|O_CREAT|O_EXCL, 0o600);
      fs.writeFileSync(fd, JSON.stringify(cfg), {encoding:'utf-8'});
      fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, ~/.claude.json)`.
     The shim's `writeFileSync(p,...)` assumed `p` is a PATH and did
     `FSS.open(p,'w')` — passed the fd NUMBER (e.g. 8) it opened a bogus file
     literally named "8" (config bytes went THERE) and left the real temp fd 0
     bytes, so the atomic `rename` clobbered the config to empty. Reproduced under
     real tjs (bogus `./8` @ 33 bytes, temp @ 0). Arch-independent → explains both
     NetBSD/arm64 and Mavericks/x64. FIX SHIPPED (`fs.cjs` writeFileSync): if arg1
     is a number, `writeAll(fd, bytes, null)` to the caller's fd WITHOUT opening or
     closing a path (Node semantics). New characterization test
     `node-shim-fs.test.cjs` "writeFileSync(fd, data) ... vs host node" (mirrors
     ED6: openSync temp → writeFileSync(fd) → fsync → close → rename; asserts the
     target reads back the JSON and no bogus numeric file). Prior WRONG suspects
     ruled out: `Bun.write`/`Bun.file` — CC uses **neither** (0 occurrences in
     cli.cjs); the shim fs primitive does NOT truncate (path form always worked).
     **LIKELY CO-FIX (verify): the credentials-not-persisted half.** Any CC writer
     that routes through `ED6`/an fd-first `writeFileSync` (settings, the file-based
     credential store CC falls back to when no keychain — quaude has no Bun keychain)
     was wiped the same way. Confirm `~/.claude/.credentials.json` now persists
     under quaude; if creds use a different path, re-check keychain vs file store.
  2. **Credentials** — native CC stores login in the OS keychain (macOS) or a
     credentials file; under tjs there may be no keychain-equivalent, so the token
     isn't saved. Check the credential store path CC uses and whether the node-shim
     implements it (vs a fail-loud/no-op stub swallowing the write).
  Oracle: diff where native CC vs quaude read/write config+creds; the recording
  Proxy on the fs/os surface will show a silent no-op if that's the cause. **Repro
  platform: NetBSD/arm64** (confirm whether it also repros on other quaude arches /
  darwin-universal — narrows keychain-specific vs general path/write fault).

- **quaude login browser-launcher does not open the browser (macOS/arm64 at
  least).** Reported 2026-07-15. **"spawn detached/ignore gap" LEAD DISPROVEN
  (2026-07-15, session "daily-driver").** Traced CC's actual login opener in the
  extracted 2.1.179 cli.cjs: `v4(url)` → `Gl1(url)` runs on darwin
  `let K=(Mw()?.browser ?? process.env.BROWSER)||"open"; {code}=await g8(K,[url]);
  return code===0` where `g8`→`o_` is CC's execa-based exec runner. Every layer
  works under real tjs (`tjs-darwin-x86` + node-shim loader): (1) `child_process
  .spawn("open",[url],{stdio:"ignore",detached:true})` LAUNCHES (marker-file proof);
  (2) `resolveExe` PATH-resolves bare `open`→`/usr/bin/open`; (3) bare `open` spawns
  and returns its own exit code (bogus-flag test → code 1 + usage, i.e. it ran).
  NOTE `spawn` silently DROPS `opts.detached` (never threaded to `tjs.spawn`,
  child_process.cjs ~L189) — harmless for `open` (returns immediately) but a latent
  gap worth closing. Ruled out: `Mw()` is `m6.attacherCaps` (in-memory), NOT the
  config reader, so it does NOT throw on the 0-byte config. **Could NOT reproduce a
  shim-level defect** — the mechanism works at every testable layer. NEXT: needs an
  INTERACTIVE real-quaude login (opens a real browser / OAuth) to repro — likely
  either environment/onboarding state poisoned by the now-fixed 0-byte config, or a
  timing/`o_`-option nuance. Re-test login on a fresh quaude now that config
  persists before investing more. Workaround: the login URL is printed — open it
  manually.

- **quaude TUI leaves stale frames on screen (daily-driver report, 2026-07-15).**
  Previous commands/output persist after they should clear: a finished `/login`
  still shows near the bottom; `/doctor` shows "queued" after it already ran (and
  up-arrow could clear it). The repaint isn't ERASING prior lines — either the
  cursor-up + clear-to-EOL sequence isn't emitted/honored under the tjs tty shim,
  or the Ink diff-render redundantly repaints without clearing (cf. the M3
  render-parity note: tjs interactive render ~1.2MB vs node ~8KB/turn). Likely a
  node-shim `tty`/write or ANSI-erase gap. Repro: interactive quaude, run a slash
  command, watch it linger. Part of the M3 render-parity frontier but concrete.

### Platform wishlist (reachable-frontier tracker)

- **NetBSD: every arch** — in progress (task #8 above). The showcase of the
  build.sh path. **Buildable so far** (generic toolchain, local proof): m68k (CI),
  sparc64, alpha. **Grinding:** hppa, macppc, pmax (mipsel), sgimips (mipseb).
- **NetBSD hard-arch tier — toolchain builds, ENGINE needs upstream compiler work:**
  - **vax** (32-bit LE) — `vax--netbsdelf` toolchain builds, but the tjs engine
    compile FAILS: VAX has **non-IEEE floating point** (F/D/G format), and quickjs
    assumes IEEE. Confirmed 2026-07-14. Path (per the 2026-07-10 plan's "VAX
    contingency"): **a soft-float IEEE mode for GCC's VAX backend** so quickjs's
    IEEE-double bit patterns / NaN-boxing compile unchanged — a real GCC-backend
    patch (precedent in other backends), not a leg tweak. Bytecode donor = the
    i386 leg (32→32 LE). Deferred as a dedicated project; run
    docker-loop/netbsd-fleet.sh vax with the log-persist harness to capture the
    exact IEEE-assuming construct when we pursue it.
  - (Expect ia64, or1k, m68000/sun2 to land here too as the sweep reaches them.)
- **MorphOS** (PowerPC AmigaOS-family) — **tier-3, needs a libuv port.** Fits the
  mission (weird PPC boxes where native Claude can't run) and endianness is solved
  (canonical-LE on BE, proven). BLOCKER: MorphOS is non-POSIX (no epoll/kqueue,
  Amiga exec API), so txiki's **libuv has no MorphOS backend** — the same reason
  there is no modern Node.js for MorphOS. That's a "write a libuv platform"
  project, not a cross-toolchain file. NB the *hardware* MorphOS runs on is
  already reachable via NetBSD/macppc (PPC) and NetBSD/m68k (classic Amiga) — so
  the fleet covers the boxes without porting to the OS. Revisit only if a libuv
  backend appears or someone wants to write one.

## NEXT UP — Phase 3: TUI paints (M1) + human-verified turn (M2) + AGENTIC TOOL USE all work under tjs; M3 (render parity) next

### ▶ START HERE TOMORROW (session 2026-07-08 end)

**Landed today (15 commits, `e3e5a15`..`2d1f249`; tree clean):** UAF/SIGSEGV fixed
(ASAN); 5 interactive-path gaps (Intl polyfill, Intl-new-optional, setEncoding,
child.stdin Writable, +the persistent-shell stdin hang); **agentic tool use** (Bash
tool: memoryUsage/cpuUsage, fs.promises.open+O_*, tjs.spawn numeric-fd inherit). So
under tjs now: **M1 paint + M2 human turn + slash commands + Bash tool all work.** v0
API-surface gate shipped (`scripts/apicheck.mjs`). Full suite (with TUI-live-render):
**514/474 pass/2 fail/1 todo** — the 2 fails are STALE ws tests (see below), not tjs.
Endgame design (untracked): `docs/superpowers/specs/2026-07-08-api-surface-gate-design.md`.

**Recommended first move — the ws / bundled-deps decision (brick #1 of self-attesting binaries):**
1. Settle the shipped-binary deps contract: SEA `deps.tar` bundling is the only model
   for shipped binaries; a missing REQUIRED dep = broken build → **fail loud** (user's rule).
2. Revisit `8dc4947` (non-fatal `require('ws')` was a bring-up concession) — restore
   fail-loud-at-require for required deps, or scope the lazy stub behind a dev flag.
3. The 2 stale tests (`websocket.test.cjs`, `e2e-tui.test.cjs`) resolve as a
   CONSEQUENCE of that decision — do NOT touch them in isolation.

**Then / in parallel (ranked):**
- **apicheck v1 = the embeddable oracle:** recording-Proxy per-module coverage %,
  checked-in golden baselines + baseline manifest, and broaden the corpus to include
  **tool-use turns** (today's OVr bug was invisible to headless `-p` — the corpus MUST
  exercise tools). This artifact IS the future `clode selftest`.
- **`clode selftest`** (self-attesting binary): wire the corpus+baselines into a shipped
  `clode selftest [--json]` — a per-capability confidence map users run on their own box
  (offline, node-free, token-free). Delivery vehicle for the oracle principle; design doc.
- **M3 (render parity):** tjs interactive render ~1.2MB vs node ~8KB/turn (redundant
  full redraws). Last phase-3 milestone; non-fatal.
- **Upstream-txiki batch** (awaiting go-ahead): `txiki-spawn-fail-uaf`,
  `txiki-stream-write-sync-number`, `txiki-spawn-inherit-fd`, the quickjs-ng v-flag
  `\p{}` regexp bug, + the phase-2 batch (sync-fs, sync-spawn CLOEXEC, no-origin,
  netbsd, default-stack-size).
- **SPARC verify-next:** does the `-p` path instantiate any wasm (tokenizer), or is all
  wasm behind the TUI (Yoga)? If `-p` is wasm-free, headless-SPARC decouples from
  wamr-big-endian.
- Minor: `process.resourceUsage` still undefined (unneeded so far; add if a path hits it).

---

**AGENTIC TOOL USE WORKS (`d4e197d`, independently verified):** a real Bash-tool turn
runs a shell command and returns output under `CLODE_ENGINE=tjs`. Root cause was a
cluster of tool-path shim gaps (NOT the async-gen codegen bug): `process.memoryUsage`/
`cpuUsage` (broke ALL tools — the runner records an rss baseline before every call);
plus the Bash tool's fd-redirection (`fs.promises.open`+`O_*` constants, and REAL
numeric-fd inheritance in `tjs.spawn` via `txiki-spawn-inherit-fd.patch` → `UV_INHERIT_FD`,
rebuilt+re-signed; child_process fd passthrough). Suite 128/124 pass/0 fail/4 skip. Found
by subagent + watchdog verification (which caught an incomplete first fix and a
confabulated co-diagnosis — dogfood of the gate's verify-don't-relay principle).


**The interactive Claude Code TUI now RENDERS under `CLODE_ENGINE=tjs`.** The
tui-diff oracle went 13 → **1603 bytes** (host node 2062); the screen shows the
"Claude Code v2.1.202 / Opus" box, the `❯` prompt, "? for shortcuts", and
"Not logged in · Run /login". Full trail: `spike/quickjs/results/phase3-m1-tui-boot.md`.

How we got there (parallel subagent workstreams, 2026-07-08):
- Shim TTY layer (tasks 1–3, reviewed): real `tty.ReadStream`/`WriteStream` over
  `core.TTY` (isTTY, columns/rows, resize/SIGWINCH, `setRawMode`, async keystroke
  pump + paused-mode `readable`/`read()`, side-effect-free `isatty`) — `94905f5`..`6521c1f`, `e00506f`.
- Boot walls fixed via the node-vs-tjs render-byte differential (`efaf6d7`,
  `e00506f`): legacy `constants` module, `fs.utimes`/`lutimes`, `fs.Stats` Date
  accessors, `tty.WriteStream` cursor/erase methods, dynamic `import()` (→require),
  paused-mode stdin.
- **The paint blocker (root cause + fix, `bcf53eb`): a quickjs-ng libregexp bug —
  Unicode property escapes `\p{…}`/`\P{…}` under the `v` (unicodeSets) flag match
  non-members / miss members** (correct under `u`). Cascade: `string-width@≥7`
  `baseVisible("t")→""→codePointAt undefined` → `get-east-asian-width` throws
  during the REPL module's top-level init inside `launchRepl`; swallowed upstream
  so `ink.render()` is never called. Fix: the loader downgrades `v`→`u` on
  module-source regex literals that use `\p{}` but none of `v`'s exclusive features
  (semantic no-op on a correct engine). Char test `test/node-shim-vflag-regex.test.cjs`.
  Proper long-term fix belongs in quickjs-ng libregexp — **upstream candidate.**
- The **API method-level coverage inventory** (`spike/quickjs/results/phase3-api-coverage.md`)
  + 3 batches of proactive gap-fills (`17fe218`,`0b0723a`,`4f7add3`: assert,
  querystring, string_decoder, fs/util/url/crypto/zlib/stream.finished). Key result:
  the `-p PONG` and TUI paths fire **0 missing-method walls** — the real blockers
  were engine/behavioral bugs, not missing APIs (validates the hybrid strategy).
- The "TUI fetch hangs" theory was a **measurement artifact** (`7f0fa3a`): Ink
  patches `console.error` in its ctor, swallowing the trace logs; the fetch
  actually resolves 3/3 (proven via raw fd-2 writes). No fd-race/timer/TLS bug on
  the fetch path. One genuine hardening fix did land: `__tjs_spawn_sync` was leaking
  live fds into sync children — CLOEXEC fix `7b36cf5`.

### Loose ends
- **Shim suite now fully GREEN: 118 tests / 114 pass / 0 fail / 4 skip;** `-p PONG`
  + TUI render (1603 bytes) verified. The previously-red `child_process` ENOENT test
  was NOT "codegen fragility" — ASAN pinpointed a concrete **heap-use-after-free**:
  `tjs_spawn`'s spawn-launch-failure path freed the `uv_process_t` handle
  synchronously while libuv still owned it (a later `uv__run_closing_handles` wrote
  into freed memory). FIXED at the source: `txiki-spawn-fail-uaf.patch` (commit
  `e3e5a15`, upstream candidate) releases the handle via the async `uv_close` path
  instead of the direct free. So the "layout-sensitive SIGSEGV lottery" is closed.
- **M2 ACHIEVED (2026-07-08): human-verified interactive turn on a real console under
  `CLODE_ENGINE=tjs`** — "what is 6 + 7" → correct answer, TUI stayed coherent. Four
  tjs-only interactive gaps fixed en route (each traced via a bundle `ae.stack` probe
  in the extracted `cli.cjs`, fixed as a shim gap, locked by a node-parity test):
  `f2afbe8` **Intl polyfill** (`modules/intl.cjs` — quickjs-ng has no Intl; the loader
  only shimmed Segmenter, so `new Intl.NumberFormat` was `new undefined()`);
  `d39fd4d` **Readable.setEncoding** (hook/subprocess reader; now StringDecoder-backed);
  `4bed83a` **child.stdin as a real Node Writable** (hook runner writes stdin;
  fire-and-forget over getWriter since tjs child-stdin writes don't resolve);
  `f7da37e` **Intl legacy constructors new-optional** — the TUI calls
  `Intl.DateTimeFormat(...)` WITHOUT `new` (legal ECMA-402), ES6 `class` threw; this
  one appeared ONLY on a real console turn (headless `-p` never renders dates → live
  proof corpus coverage is the lever). Suite 124/120 pass/0 fail/4 skip.
  **Auth "Not logged in" was NOT a tjs bug** — earlier testing was over SSH (login
  Keychain locked → `security` can't read the subscription credential); on a real
  console (unlocked) auth + the turn work. **M3 (render parity)** is the remaining
  phase-3 milestone; the tjs interactive render is byte-heavy (~1.2MB vs node ~8KB/turn — redundant full
  redraws, non-fatal), an M3/efficiency item.
- **Agentic tool use (Bash tool) fixed** (`1222660`, tjs C, upstream candidate): the
  Bash tool feeds short commands to a PERSISTENT shell via stdin and every write hung
  — `mod_streams.c` returned `JS_TRUE` on the `uv_try_write` sync-complete path where
  the JS sinks (process.js/udp.js) expect a byte-count NUMBER, so they awaited an
  onwrite never scheduled. Fix: return the count. Data was delivered; only the
  write-ack was missing (also blocked close/EOF). This is the substrate for a coding
  agent running commands under tjs. `txiki-stream-write-sync-number.patch`.
- **Build-environment follow-ups** (bit the UAF rebuild — recorded in PINS.md): the
  ~42k AppleDouble `._*` sidecars must be purged before building; `build-tjs.mjs`'s
  strict `git apply` can't re-sequence the overlapping sync-fs/sync-spawn patches on
  an already-patched tree (GNU `patch --forward` works); and the binary needs a
  `codesign -s - --force` re-sign after copying off the build dir (else exec dies
  "code signing error"/SIGKILL). Worth hardening `build-tjs.mjs` for these.
- Upstream candidates grew: quickjs-ng `v`-flag `\p{}` regexp bug; the
  `txiki-spawn-fail-uaf` UAF; plus the phase-2 batch and `txiki-sync-spawn` CLOEXEC.
Plan: `docs/superpowers/plans/2026-07-08-phase3-tui-under-tjs.md`; design:
`docs/superpowers/specs/2026-07-08-universal-binaries-phase3-tui-design.md`.

## Endgame — automated API-surface gate (turn reactive handoff into a pre-ship gate)

**Goal:** given a new upstream binary → extracted `cli.cjs`, tell us BEFORE shipping
what the bundle needs and where tjs diverges from node — so agents polyfill from a
work-list instead of the user hand-reproducing breakage. Full design (untracked, on
disk): `docs/superpowers/specs/2026-07-08-api-surface-gate-design.md`.

Two axes (do not conflate): **presence** (is the API defined — enumerable via the
`wallProxy` `[wall]` misses) and **correctness** (defined but wrong — the v-flag
regexp / UAF / setEncoding class — only a node-vs-tjs behavior diff sees these).
Conclusive static enumeration is undecidable (computed dispatch); the reachable
endgame is empirical + regression-gated (how Bun/Deno do Node-on-non-Node), with the
**corpus as the only real lever** and every field miss becoming a permanent case.

- **v0 SHIPPED: `scripts/apicheck.mjs`** — seed corpus of `clode` invocations run
  under node AND tjs; reports the `[wall]` miss union (Axis 1), node-vs-tjs exit/
  deterministic-stdout divergences (Axis 2), and the cross-version require-target
  set-diff; exits non-zero as a CI gate. First run (2.1.204): **PASS — 0 walls, 0
  divergences**, 2.1.198→2.1.204 require-set unchanged.
- **v1 (next):** recording-Proxy hit-ledger for true per-module coverage %; checked-in
  baseline manifest + known-good outputs; broaden corpus (tool uses, slash commands,
  flags, hooks, MCP). **v2:** import deps'/Node's test suites as differential corpora;
  frame-level TUI render parity (folds into M3).
- **Oracle principle (first-class):** *where the reference oracle doesn't exist, the
  gate's golden-output baseline becomes the oracle.* `node`-differential only works on
  platforms that don't need tjs; on NetBSD/SPARC there's no `node` to diff against, so
  capture canonical/deterministic/normalized outputs (exit codes, crypto digests of
  fixed inputs, fixed-content frames) on a reference platform, check them in, and diff
  the exotic platform against the record. `node` moves UPSTREAM (re-mint the baseline
  per upstream bump), doesn't vanish. This makes v1's baseline manifest load-bearing,
  and it's exactly what catches big-endian divergences. Bonus: golden slice runs
  offline/token-free.
- **Platform reach (grounded):** tjs (portable C) reaches where Bun can't.
  NetBSD/aarch64 headless PROVEN (M4, same-endian OS port). SPARC = the endianness +
  strict-alignment phase change. The bundle uses wasm, but dominantly **Yoga (layout,
  TUI-only)** — so headless `-p` is likely wasm-free and SPARC-headless may be reachable
  before solving wamr-big-endian (the TUI needs it; wamr already works on aarch64, so
  the open Q is narrowly big-endian). Byte-match surface (createHash×90, DataView×73,
  Buffer.from×331) is what the oracle principle guards. VERIFY-NEXT: does `-p`
  instantiate any wasm (tokenizer)? Full notes in the design doc.
- **Activation policy (decided):** none of this touches the user hot path.
  `extract`/launch stay untouched (no marker, no log — CI notices new versions by
  diffing itself); users opt in only via explicit env flags (`CLODE_SHIM_TRACE`,
  future `CLODE_API_LEDGER`), off by default (residue when off = a load-time check,
  never per-call); dev/CI lean hard on the full gate out-of-band. Recording proxy is
  constructed only when its flag is set, never in correctness runs (it perturbs).
- Caution baked into the harness: THIS Claude Code session's env carries
  `CLAUDE_CODE_BRIDGE_SESSION_ID` (child bundle auths via the parent bridge) — fine for
  coverage/parity, but strip it to test real subscription auth.

## Hermetic test execution (npm + SEA) — [SPEC 1 + 2a + 2b SHIPPED; suite is now pure node:test]

Spec 1 (infra) SHIPPED 2026-07-03: `libexec/clode-paths.cjs` choke point (one
`CLODE_STATE_ROOT` knob seals npm + SEA), `CLODE_NODE` canonicalized in run-all
(shim footgun gone), per-file sandbox in `test_helper.bash`, preflight+postflight
guard (`test/hermetic-guard.cjs`), `CLODE_NO_WATCH=1` in the sandbox (no detached-
watcher teardown races). Design: `docs/superpowers/specs/2026-07-02-hermetic-testing-design.md`.

**Spec 2a (bats→node foundation + bulk) SHIPPED 2026-07-03:** `test/e2e.cjs` is a
constructed-clean node harness (`sandbox`/`runClode`/`mkProvider`/`fakeNpm`; every
spawn's env built from scratch — nothing from `process.env` — with `CLODE_DEPS`
pointed at a seeded no-`.deps-sig` store so `ensureDeps` takes its npm-free
user-managed opt-out and the bundle boots offline WITHOUT npm; the bash harness had
instead leaned on npm-on-PATH + an npm cache). The 16 plain-subprocess `.bats` files
were converted 1:1 to `node:test` (one node test per `@test`, positive AND negative
assertions preserved, matched to real launcher output) and deleted in-commit, and
`test_harness_isolation.bats` was dropped (invariant now structural). `ls test/*.bats`
is down to the 4 PTY/TUI files. Plan: `docs/superpowers/plans/2026-07-03-bats-to-node-2a.md`.
Note found en route: the plan's two selfupdate labels were swapped — `test_selfupdate`
(no underscore) is the extracted-bundle CACHE lifecycle; `test_self_update` (underscore)
is `clode update` via a `file://` releases fixture + signals digest.

**Spec 2b (PTY/TUI tail) SHIPPED 2026-07-03** (plan
`docs/superpowers/plans/2026-07-03-bats-to-node-2b.md`): the last 4 `.bats` are gone,
`test_helper.bash` is deleted, and `run-all.sh` runs node tests only — the suite is now
**pure `node:test`** (Windows-portable, no bash framework). What landed:
- `test/e2e-pty.cjs` — node:test PTY capture harness wrapping `tui-screen.cjs`
  (`makeWsWorlds`/`seedClaudeProfile`/`capture`); `seedClaudeProfile` is the minimal
  cwd-keyed `~/.claude.json` (onboarding + `projects[cwd]` trust) that gets a no-keystroke
  capture past onboarding + the trust prompt.
- `test_tui` → `e2e-tui.test.cjs` (all 4, incl. the once-quarantined #60) and
  `test_doctor_parity` → `e2e-doctor-parity.test.cjs` + `refresh-doctor-golden.sh`.
- `test_update` + `test_launcher` verify-and-deleted (coverage already in
  `e2e-keying`/`e2e-selfupdate`/`e2e-resolve`).

**Key discovery:** the TUI/doctor render tests are NOT hermetic — they spawn the REAL
Claude Code bundle (the fake fixture can't render the Ink welcome box; #60's ws fatal
only fires on real WebSocket construction). Worse, the real bundle **probes the macOS
login Keychain** and pops system dialogs. So both live-render files are gated behind
**`CLODE_LIVE_RENDER=1`** (opt-in) and SKIP in the default offline `npm test` — no
bundle spawn, no Keychain, no network. clode's ws-fail-loud *contract* stays covered
hermetically by `test/websocket.test.cjs`; the comparator by `doctor-parity.test.cjs`.

**Residual (small):**
- a Windows-portable (node-based) `fakeNpm` to replace the Spec 2a `.sh` shim
  (`test/e2e.cjs`);
- fold the `clode-run` update-guard `CLODE_CACHE` semantics decision if it recurs.

**Curate the live `/doctor` parity allowlist (`e2e-doctor-parity` test 2, currently
skipped).** The opt-in `CLODE_LIVE_RENDER=1` run (2026-07-03) showed the strict
native-vs-clode comparison reds on pure environment noise, not clode bugs. Want (user
decision): keep a STRICT comparison with a curated allowlist of areas we deem
unimportant, failing on any other diff — that's the upstream-`/doctor`-format drift
signal. To get there:
- **Kill wrapping noise:** give clode's capture the REAL render deps (string-width/
  strip-ansi/wrap-ansi), not the `seedRenderDeps` fakes, so line-wrapping matches native
  (a `makeWsWorlds` variant that copies/symlinks the real `~/.local/share/clode/node_modules`
  render deps + fake `ws`). The original bats used the real store for exactly this reason.
- **Normalize section-title status glyphs** (`⚠`/`✔`/`◯`/`✗`) in `doctor-parity.cjs`
  `parseScreen`, so a status flip (e.g. Diagnostics `✔`→`⚠` from a Keychain-cancel)
  doesn't cascade into mis-grouped "ADDED/DROPPED block" noise.
- **Extend the allowlist** to the volatile sections: `Updates` (version fetch / "Failed
  to fetch versions"), `Remote Control` (auth/session lines), and the macOS
  Keychain-writability warning in `Installation warnings`/`Diagnostics`.
- Then un-skip test 2. Validation needs live captures (Keychain dialogs each cycle), so
  batch it. Comparator logic itself stays covered by `doctor-parity.test.cjs`.

The suite is not hermetic: it leaks the real machine's state in and its own
fixtures out. Three symptoms observed in a single session on 2026-07-02:

1. **Fixtures leak OUT into the real store:** four `0.0.0-clode-test` stub deps
   (semver, string-width, strip-ansi, wrap-ansi) were seeded into
   `~/.local/share/clode/node_modules` by a pre-`4a99d2b` test run, breaking
   `clode-watch`'s real-semver test and degrading real clode runs (see the
   dedicated item below).
2. **Real environment leaks IN — provider on PATH:** `test_resolve.bats` #5
   ("no provider yields exit 1") depends on the ambient PATH/HOME; a real
   `~/.local/bin/claude` and/or the caller's node choice can defeat its
   isolation.
3. **Real environment leaks IN — node identity:** the same test passes only when
   `CLODE_NODE=/opt/pkg/bin/node` (a real binary) and fails under the default
   `command -v node` asdf *shim*, because the shim re-resolves under the test's
   minimal PATH. Correct execution silently depends on an env var the runner
   defaults wrong on this box.

**Want:** a deliberate design (own superpowers spec → plan) for test hermeticity
that:
- seals both directions — no test can read or write the real
  `~/.local/share/clode`, `~/.cache/clode`, `~/.local/bin`, or ambient PATH
  provider; every test runs against a private, disposable HOME/store/cache/PATH.
- **works identically for npm-layout AND SEA execution** (the two runtime shapes
  clode ships), so a test passing under one can't rot under the other.
- **is structurally hard to violate as tests are added** — e.g. a single enforced
  sandbox fixture/harness all tests inherit, plus a preflight/CI guard that fails
  if the real store shows `*-clode-test` deps or a test process escapes the
  sandbox — rather than per-test discipline that erodes.
- pins/handles the node identity explicitly (which node runs the suite) so
  correctness doesn't hinge on an unset env var.

Symptoms 1-3 are the concrete acceptance cases the design must close.

**Coverage temporarily quarantined (restore in the bats→node conversion):** hermeticity
work (2026-07-02) surfaced that `test_tui.bats` #58/#60 silently rode the dev's real
`~/.claude.json` (onboarding + per-project trust). #58 fixed by seeding onboarding in
the sandbox; **#60 ("TUI fails LOUD when the ws ext-dep is missing") is skipped** — its
repro needs a hermetic per-project *trust-state* fixture (Claude Code's real
`~/.claude.json` is ~76KB, keyed by `projects["<path>"]` trust flags). The conversion
must rebuild that as a golden fixture and un-skip #60. Also quarantined: the anti-hermetic
cases in `test_update`/`test_launcher`/`test_watch`/`test_doctor_parity`.

## Test-fake deps leaked into the REAL clode store

On 2026-07-02, four `0.0.0-clode-test` stub packages (`semver`, `string-width`,
`strip-ansi`, `wrap-ansi`) were found sitting in the user's real dep store at
`~/.local/share/clode/node_modules`, seeded by a test run *before* commit
`4a99d2b "fix(test): never seed fake deps into an inherited CLODE_DEPS store"`.
They made `clode-watch`'s `versionGt uses real semver` test fail (the fake
`compare()` can't order prereleases) and would silently degrade real clode runs
(e.g. a fake `string-width` returns wrong widths). Removed the four stubs by hand;
they self-heal on the next run.

- **Investigate:** confirm `4a99d2b` fully closes the seeding path — was that the
  only vector, or can any other test still write into an inherited/real
  `CLODE_DEPS`/`~/.local/share/clode`? Reproduce the pre-fix leak to be sure the
  fix covers it.
- **Prevent:** add a guard so a test can never mutate the real store — e.g. tests
  that need a fake-dep store must point `CLODE_DEPS` at a tmp dir (see the
  isolate-clode-runs guidance), and consider a CI/`run-all` preflight that fails
  if `~/.local/share/clode/node_modules/*/package.json` reports a
  `*-clode-test` version.

## Where's `gh auth login` in the bottom status line?

Open question, observed live: the bottom status line doesn't surface the expected
`gh auth login` hint. Likely the same class as the auto-update nudge — status-line
content the bundle computes that clode's environment (or a shim gap) changes.

- **Investigate:** reproduce, compare against native, and locate where the bundle
  builds that status-line item — is the hint suppressed, mis-evaluated (e.g. a
  `gh`/auth probe behaving differently under the Node host), or rendered and just
  not where expected?

## Store our versions more parallel to how upstream stores binary versions

Upstream keeps versioned binaries at `~/.local/share/claude/versions/<ver>` with a
`~/.local/bin/claude` symlink to the active one. clode's cache (`~/.cache/clode/<KEY>`)
keys on the provider binary — `<ver>` when the path encodes one, else
`<basename>-<size+mtime>` — and now also stores an `.extractor-sig` so a changed
extractor re-extracts. The two schemes aren't aligned: our `<KEY>` dirs don't map
cleanly onto upstream's `versions/<ver>` layout, and the basename-sig fallback is
opaque.

- **Want:** make clode's per-version storage mirror upstream's more directly (e.g.
  a `versions/<ver>` layout with an "active" pointer), so it's obvious which
  extracted bundle corresponds to which upstream version, easy to GC stale ones,
  and natural to diff/inspect side by side.
- **Relates to:** the extractor-fingerprint re-extract (cache validity now depends
  on `(binary, extractor)`), and the cache-key logic in `bin/clode` (`cache_key`).

## Proactively steer the model toward clode's update path (system-prompt nudge)

Idea, deferred. At launch, have `bin/clode` pass a short `--append-system-prompt`
line telling the model it's running under clode and to update via `"$CLODE_SELF"
update` (clode is not necessarily on PATH; `CLODE_SELF` is already exported), never
`claude update`. The flag feeds the bundle's shared system-prompt builder (`Kn1`),
so it reaches interactive sessions.

- **Why maybe-later:** the `PreToolUse(Bash)` update hook (in the
  complete-update-interception design) already denies model-issued `claude
  update`/`upgrade` with a just-in-time message pointing at the right command, which
  covers the common case. A proactive nudge would add value mainly by (a) reducing
  attempts up front and (b) catching *non-`claude`-named* update attempts the hook's
  regex won't match (e.g. `npm i -g @anthropic-ai/claude-code`).
- **Revisit if:** the model keeps reaching for upstream update paths despite the
  hook, or non-`claude` update attempts show up in practice.
- **Tradeoff:** `--append-system-prompt` is single-value/last-wins, so a user's own
  value would override clode's. If stacking is needed, the bundle also concatenates
  an `appendSystemPrompt` from settings inside `Kn1`.

## Reimplement the extraction toolchain in JavaScript (drop the Python dependency)

Port `libexec/extract-claude-js` (and, in time, `libexec/inspect-claude-bundle`)
from Python to JavaScript/Node. Worth doing on its own merits, and it removes a
blocker to single-binary deployment.

- **Why it's sensible independent of SEA:**
  - **Same runtime as the thing it processes.** The artifact is a JS bundle that
    clode already runs under host Node; carving/transforming it in that same Node
    avoids a language boundary in the middle of the pipeline.
  - **One fewer host dependency.** clode targets machines where toolchains are
    scarce (NetBSD/pkgsrc, old macOS, non-x86); requiring a new-enough `python3`
    cuts against that. Node is already required to run anything, so the extractor
    can lean on it instead. (Aligns with the portability mission in `LONG-TERM.md`.)
- **Why it also matters for SEA:** Node SEA packs JS + Node only, so a JS extractor
  is a hard prerequisite for the single-binary story below.
- **Port faithfully — same loud-failure contract.** Preserve, behavior-for-behavior:
  the text-marker carve (`carve_blocks`), the prelude, and every splice
  (`patch_autoupdater`, `patch_native_autoupdater`, the `/doctor` anchors) with their
  *exactly-one-match-or-fail-loud* discipline, plus `verify` (residual-NUL / import-meta
  checks). The `inspect-claude-bundle --strict` gate and its anchor set should move
  too (or stay the source of truth until ported). Keep `extract_if_needed`'s
  extractor-signature re-extract working across the language switch (the sig is over
  the extractor file — a rewrite naturally busts caches once).
- **Open question — translate the tests too?** The Python tests (`test/test_extract.py`,
  `test/test_inspect.py`) would naturally become Node tests alongside their subjects.
  Less clear for the **shell/bats** suites: they exercise the POSIX-sh launcher
  (`bin/clode`) directly, so until `bin/clode` is itself JS (the SEA work below),
  driving shell behavior from Node tests is awkward. Likely split: extractor/inspector
  tests → Node; launcher tests stay bats until the launcher moves. Revisit per-component
  as each is ported. Net goal where it lands: fewer test-host deps (no pytest; eventually
  no bats), one toolchain.
- **Relates to:** the "Port the toolchain to JS" prerequisite of the Node SEA entry
  below (this is the extractor half of it).

## Node SEA single-binary releases + a platform build matrix

The north-star packaging story: ship clode as a Node SEA (single executable
application) — clode's own logic *plus* an embedded Node runtime in one
self-contained binary — built in CI across an unusually broad OS/arch matrix. This
leans all the way into clode's identity: a single artifact that runs where Anthropic
ships nothing (old macOS, NetBSD/pkgsrc, non-x86, …), the run-everywhere counterpart
to upstream's Bun-compiled binary. The strategic framing lives in `LONG-TERM.md`
("Build a Node SEA"); this entry is the release-engineering half.

**STATUS 2026-07-03: Windows SEA build Plan A SHIPPED — `clode.exe` builds and runs; the
toolchain is now genuinely cross-platform (validated on Windows x64 AND Linux x64).**
The bats→node migration (Specs 2a/2b) shipped, so the test sources are bash-free (the
Windows trigger). "Plan A" (build + offline smoke, NO CI) — plan
`docs/superpowers/plans/2026-07-03-windows-sea-build.md` — is done:
- `platform-tag.cjs`: `win32 → windows` OS token + a `seaBin(repo, platform)` helper
  (`clode.exe` on win32).
- `build-sea.mjs`: rewritten to do **the same thing on every OS** rather than branch. The
  toolchain is now invoked via JS APIs / JS CLIs under `node` — no shells, no `.bin`/`.cmd`
  shims, no quote-stripping:
  - **npm** runs via its own `npm-cli.js` under `node` (not `npm`/`npm.cmd`+shell). This is
    what let the Windows `--define` quotes survive and sidesteps `cmd.exe`'s UNC-cwd refusal.
  - **esbuild** and **postject** are called through their **JS APIs** (`buildSync`, `inject`),
    not their CLIs. Key lesson: esbuild's published `bin/esbuild` is a NATIVE binary on POSIX
    but a node shim on Windows, so "run the bin under node" is portable on neither — the API is.
  - **signing** is extracted to `scripts/sea-sign.cjs <unsign|sign> <bin>`, a small Node CLI
    that owns all `codesign`/`signtool` platform branching, so `build-sea.mjs` issues one
    uniform call per phase.
  - **rename-aside before write** (uniform): a just-run binary can stay locked briefly
    (Windows image section / AV), so `buildBinary` renames the stale binary aside before
    writing — harmless on POSIX, fixes a rebuild-then-run EBUSY on Windows.
  - the only per-format branch left is postject's Mach-O segment name (macOS), passed as an
    API option.
- `sea-build`/`sea-smoke` tests locate the binary via `seaBin`; the POSIX-only exec-bit
  assertion was dropped (runnability is proven uniformly by actually executing the binary).
- **Validated:** fresh `CLODE_SEA=1 node --test --test-concurrency=1 test/sea-build.test.cjs
  test/sea-smoke.test.cjs` ran green on Windows x64 (Node 24) and Linux x64 (Node 24) — build +
  offline `--clode-version`/`--clode-help` pass; bundle-boot tests skip (no provider). Use
  `--test-concurrency=1`: the two files share one build artifact and must not race (latent on
  POSIX, fatal on Windows). Windows build must run from a real drive path, not a raw
  `\\wsl.localhost\…` UNC path (Node's module resolution + npm choke on a UNC base) — a normal
  `C:` checkout or a drive-mapped WSL tree (`net use Z: \\wsl.localhost\Ubuntu`) is fine.
### Code-signing & Smart App Control — decision memo (2026-07-04)

The question this answers: for the UNSIGNED `clode.exe`, *who* can't run it, on what basis we
believe that, how we'd learn we're wrong, and the cheapest signing path when/if it's worth paying.
**Current call: ship UNSIGNED.** Most Windows users run it today; revisit signing when a real
SAC-blocked user reports it (or when Windows-PE local testing on the dev box is worth ~$120/yr).

**Who is affected — is the unsigned binary blocked, warned, or clean?**
- ❌ **Hard-blocked (no bypass):** Windows 11 with **Smart App Control (SAC) in Enforcement**. SAC
  checks *all* executables regardless of how they arrived (download, copy, local build), so only
  signing fixes it — and only once reputation builds. There is no per-file "Run anyway" for SAC;
  the only escape is turning SAC off, which needs an OS reinstall to re-enable.
- ⚠️ **Bypassable warning ("Run anyway"):** Win10 / Win11-without-SAC when the file carries
  **Mark-of-the-Web** (browser/email download). One click, per file hash, until reputation accrues.
- ✅ **Runs clean, no signing needed:** Windows 10 (all), Windows Server, any Win11 with SAC
  Off/Evaluation, AND any Windows where the file has **no MOTW** — fetched via CLI (curl/wget/`gh`/
  winget/scoop), git, or copied. clode's dev audience skews heavily into this bucket.

**Why SAC is on on the dev box (and roughly who else it hits):** SAC auto-enables ONLY on a
clean/OEM Win11 install (never on a Win10→11 upgrade). It starts in Evaluation, silently watches
usage, then flips to Enforcement if the machine looks reputable (mostly-signed apps) or to Off if
it runs lots of unsigned software. The dev box (Win11 Home, clean/OEM) passed the "looks clean"
test *before* we started building unsigned binaries, so it locked to Enforcement; the user never
chose it. So the affected group ≈ "newish clean-install Win11 users who mostly run mainstream
software and got auto-enrolled" — a real, growing consumer slice, but it EXCLUDES Win10, Server,
Win11-upgraded-from-10, dev/power-user machines (usually evaluated Off), and all CLI/git installs.

**Basis / confidence:**
- *Adversarially verified* (deep-research, 3-of-3 vote, primary Microsoft sources): SAC "blocks
  execution of unsigned files unless the file has a positive reputation" and its checks "apply to
  all executable files, not just those downloaded from the Internet"; the ISG decides allow/block
  from hash+signing info, allowing only "known good" (signing is an INPUT, not authorization);
  "even when signed, a newly created binary could still show a warning until its hash or publisher
  certificate accumulates … positive reputation" (reputation is per file-hash+publisher); **EV
  certs no longer bypass SmartScreen** ("this behavior no longer exists"); reputation builds
  organically from download volume over weeks, no consumer submission mechanism. Sources:
  learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation;
  …/application-control/…/use-appcontrol-with-intelligent-security-graph;
  learn.microsoft.com/azure/artifact-signing/faq; knowledge.digicert.com EV-SmartScreen alert.
- *My-knowledge, NOT re-verified this run* (well-established MS docs — flagged so we don't overtrust):
  SAC auto-enables only on clean/OEM Win11; the Evaluation→auto-on/off logic; one-way (reinstall to
  re-enable); SmartScreen is MOTW-gated and CLI download tools usually don't set MOTW.
- *Local evidence:* dev box `VerifiedAndReputablePolicyState=1`; CodeIntegrity event 3033 blocked
  `clode.exe` from LOCAL disk (so it's the signing verdict, not the WSL/UNC path); confirmed on both
  UNC and `C:`. The `windows-latest` CI runner has SAC off, which is why CI builds+smokes green.

**How we'd know we're wrong (falsifiers to watch):**
- Unsigned `clode.exe` runs fine on a machine the user insists has SAC on → our block belief or the
  state read is wrong.
- A plain Windows 10 / Server user reports a HARD block (not a bypassable warning) → SAC/MOTW model wrong.
- Signing ships and SAC still blocks indefinitely with reputation never accruing → the "signing
  eventually clears SAC" belief needs revisiting (may require a Microsoft submission).
- A CLI/git/winget install triggers SmartScreen → the "CLI = no MOTW" assumption is off for that tool.
- SAC turns itself OFF on the dev box after repeated unsigned-build blocks → contradicts "enforcement
  is committed/one-way."
- Still unknown: what fraction of Win11 actually ships SAC-enforcing (not established this run) — the
  number that would size the affected population.

**Cheapest signing path when it's worth it (ranked):**
1. **Azure Trusted Signing** (Azure Artifact Signing) — ~$9.99/mo Basic (corroborated across the Azure
   pricing page + 2 blogs, not formally re-verified), cloud HSM, CI-native (`azure/trusted-signing-action`).
   **Individuals in US/Canada ARE eligible (verified, Azure FAQ).** Issues no EV — which no longer
   matters. Best default.
2. **SSL.com eSigner** — OV/IV $20/mo, EV $100/mo (verified); cloud, GitHub Action
   (`sslcom/actions-codesigner`). Fallback if Azure individual onboarding blocks you.
3. **Certum Open Source** — cheap for individuals BUT ships a PHYSICAL smartcard+reader → not
   CI-friendly; only good for local signing.
- Do NOT pay for EV to dodge SmartScreen (no longer works). Self-signed NEVER satisfies SAC.
- Reality at any price: signing gets clode *evaluated* instead of hard-blocked-as-unsigned, but
  per-(hash+publisher) reputation still ramps over weeks — no instant unlock.
- `scripts/sea-sign.cjs` is already structured to add a real `signtool sign` on Windows when creds
  are present; wiring is a small `release.yml` + `sea-sign.cjs` change behind a secret.
**Plan B slice 1 — Windows CI build job — SHIPPED (2026-07-04).** `release.yml`'s build matrix
now includes `windows-latest` (with a `defaults.run.shell: bash` so the existing bash steps run
under Git Bash); every leg runs the offline SEA smokes (`--test-concurrency=1`) after the build;
asset naming is `seaBin`-aware so the Windows asset is `clode-<ver>-windows-x64.exe`. Validated
by a green three-OS `workflow_dispatch` draft run (run 28701118207): `build (windows-latest)`,
`ubuntu-latest`, `macos-14` all succeeded and the draft carried
`clode-0.1.0-{linux-glibc2.28-x64, macos-14-arm64, windows-x64.exe}`. CI is where the Windows PE
is validated (the runner has no Smart App Control, unlike the dev box). Bug the CI pass caught +
fixed: `stageDeps` shelled out to `tar` with a `D:\…\deps.tar` path, and under `shell: bash` `tar`
is Git Bash's GNU tar, which read the drive-letter colon as a remote `host:path` ("Cannot connect
to D:"); fixed to archive via `tar -cf -` (stdout) with the staging dir as cwd — no colon-bearing
path args, uniform on GNU tar and bsdtar (commit 28be5c0).

**Plan B slice 2 — real bundle boot on Windows — SUCCEEDED (2026-07-04, spike on branch
`spike/windows-boot`, findings in `docs/superpowers/findings/2026-07-04-windows-boot-spike.md`).**
`clode.exe --version` boots the real Claude Code bundle on `windows-latest` CI → prints
`2.1.201 (Claude Code)`, and `sea-smoke.test.cjs`'s "boots the real bundle" + "reuses sea-deps"
tests pass there (4 pass / 1 skip). Unknown #1 answered YES: `npm i -g @anthropic-ai/claude-code`
delivers a real Bun-compiled `claude.exe` (~241MB); clode's byte-scan `bundle-carve` finds its
`@bun-cjs` blocks and extracts JS from the PE with ZERO extractor changes. The ONLY runtime code
fix needed was the `clode-sea.cjs` `tar -xf` → stdin+cwd change (commit `3f8b558`, mirrors the
build-side fix). Provider on Windows comes via **npm**, not `downloads.claude.ai` (no Windows
artifact — all platform keys 404).

**Plan B slice 3 — permanent per-commit SEA CI gate — SHIPPED (2026-07-04, commit `f87dc87`).**
`.github/workflows/ci.yml` runs on every push to `main` + every PR, matrix ubuntu/macOS/Windows:
build `clode.exe` → offline SEA smoke → npm-install the Claude provider → REQUIRED real bundle
boot (one `node --test sea-build+sea-smoke` run, `CLODE_CLAUDE_BIN` set, `-p` skipped offline).
Validated by a green 3-OS PR (#10) then a green `main` run: boot **ran and passed on all three**
(ubuntu found the nested `claude-code-linux-x64/claude`, macOS+Windows the `claude-code/bin/
claude.exe`; clode's byte-scan extractor carves PE or ELF). Provider located via `npm root -g`
(portable) — NOT `npm prefix -g/node_modules`, which is wrong on POSIX. This is the first-ever
bundle-boot coverage on any platform in CI, and the runtime-path half of the "don't silently break
a platform" safety net. `release.yml` untouched (standalone `ci.yml`). The windows-boot spike
workflow + branch are retired.

**Plan B slice 4 — Windows interactive TUI/session bringup — SUCCEEDED (2026-07-04, local
human-in-the-loop spike on the SAC-disabled dev box; findings in
`docs/superpowers/findings/2026-07-04-windows-tui-bringup.md`).** With SAC turned off
(`VerifiedAndReputablePolicyState=0x0`, the decided dev-box trade-off) the unsigned `clode.exe` built
from `main` runs a **fully working native-Windows Claude Code session** on a Pro/Max subscription
(no API key): `clode.exe --version` → `2.1.201`; the Ink/React **TUI renders + accepts input + runs
a turn** (user-driven); `-p "reply PONG"` round-trips through the subscription; **file + directory
tools work**. Provider isolated via `CLODE_CLAUDE_BIN` (resolution stays deferred). **Zero code
changes needed** — every probe passed on current `main`. Non-regression: WSL Linux suite unchanged
(the only 2 fails are the pre-existing `ugrep`-absent `grep shadow` env tests, unrelated). Benign
cosmetic-only noise: the `-p` "no stdin data received in 3s" launcher warning.

**Unknown #2 — the POSIX shell-shim / tool-use path — CHARACTERIZED: WORKS on Windows (2026-07-04).**
The make-or-break probe (`-p "Use the Bash tool to run exactly: echo HELLO123"`) returned `HELLO123`,
exit 0 — `bun-shim.cjs`'s entirely-POSIX shell machinery (`$SHELL -c -l` / `exec -a` / argv0-shadow /
shell-snapshot) **functions natively on Windows** through the real Bun `claude.exe` provider. The
spike's central hypothesis (that it would break and need a porting slice) was wrong; **no shell-shim
port is required to reach basic tool use.** (Earlier this line read "UNTESTED; only a real `-p`
session (needs an API key) would exercise it" — resolved: a Pro/Max *subscription* `-p` session
exercised it and it works.)

**Plan B remaining:**
- **code-signing** (only matters for SAC-Enforcement Win11 users — see the "Code-signing & Smart
  App Control" decision memo above; deferred until a real SAC-blocked user reports it).
- **Windows provider resolution — native-installer layout DONE (2026-07-04, commits `e69f753` +
  `4cd28cf`; findings `docs/superpowers/findings/2026-07-04-windows-provider-resolution.md`).**
  `clode.exe --version` now boots on native Windows with **no `CLODE_CLAUDE_BIN`**: resolver step 5
  derives HOME via `clode-paths.homeDir` (`os.homedir()` fallback) and tries leaf names
  `claude`/`claude.exe`, so it finds the native installer's `~/.local/bin/claude.exe` (a plain copy;
  POSIX symlinks, Windows copies). Uniform, no platform branch. Still deferred:
  - **npm `$basedir` sh-shim** (`followWrapper` can't follow the quoted `$basedir`-relative exec
    target; npm is now upstream-de-emphasized "Advanced" — `CLODE_CLAUDE_BIN` bridges meanwhile);
  - **WinGet** layout;
  - step 3's **`providers/current`** join (hardcodes `/claude` + POSIX separator) → belongs to the
    provider fetch/update slice below.
- **Windows provider fetch/update — DONE (2026-07-05, commits `0a3e4e3`..`afccf9f`; findings
  `docs/superpowers/findings/2026-07-05-windows-provider-fetch-update.md`).** `clode update` works on
  native Windows: `providers/current` is now a **pointer file** (a tiny text file with the version)
  behind the single `clode-current.cjs` seam — no symlink, no privilege needed; uniform on every
  platform; the path still contains `/providers/<ver>/` so the shared-per-version cache key holds.
  The downloaded platform is a **fixed arbitrary container** (`linux-x64`) that clode carves the JS
  out of (never runs); the download URL uses the manifest's self-describing `binary` name while the
  store keeps the canonical `claude`. Verified live on Windows: `clode update` fetched linux-x64
  2.1.201, wrote a pointer-file `current`, and `clode.exe --version` (no `CLODE_CLAUDE_BIN`) resolved
  via step 3 through the pointer and booted. Characterized win32 vs linux carves: same program, byte
  differences are only cosmetic (minifier names, embedded-doc CRLF-vs-LF, Bun VFS prefix); linux ==
  macOS byte-for-byte. (The earlier "no Windows artifact" note was the wrong endpoint —
  `downloads.claude.ai/claude-code-releases/<ver>/<plat>/` serves every platform, `binary=claude.exe`
  for win32.) Legacy symlink `current` self-heals on next update. Still deferred: **auto-fetch on
  missing provider**, **WinGet**, **npm `$basedir` sh-shim resolution**.
- **full `node --test` (non-SEA) suite green on Windows** — being done in cause-based slices:
  - **Slice 1 — cross-platform runner + path/format — DONE (2026-07-05, commits `5fe5457`..`8cb4952`;
    findings `docs/superpowers/findings/2026-07-05-windows-test-runner.md`).** `test/run.mjs` (a node
    orchestrator) replaces the bash `run-all.sh` — `npm test` → `node test/run.mjs`, identical on every
    OS (CLODE_NODE=execPath, platform-tagged NODE_PATH via `path.delimiter`, PTY-harness install via
    `npm-cli.js` under node, hermetic guard `require()`d in-process around fs-discovered `test/*.test.cjs`,
    dotfiles excluded to match the POSIX glob). `harness-preflight` smoke spawns node not `/bin/sh`.
    Path/format fixed: `cacheKey` matches markers on either separator; resolve step 5 uses `path.join`;
    `platformTag` regex + `clode-paths`/`clode-watch` asserts tolerate backslashes. **Verified:** node-pty
    1.1.0 installs prebuilt on Windows + ConPTY spawns headlessly; POSIX suite unchanged (378/337/**fail 2**
    ugrep-baseline/39); Windows now RUNS the whole suite — **pass 300 / fail 35 / skip 43**, with all the
    path/format tests green. **No skips added.** The remaining 35 Windows failures are the honestly-deferred
    buckets below.
  - **Slice 2 — symlink fixtures — DONE (2026-07-05, commits `59faed4`..`8e4a26a`; findings
    `docs/superpowers/findings/2026-07-05-windows-symlink-fixtures.md`).** No skips: the two *incidental*
    symlink fixtures (e2e-resolve `~/.local/bin/claude`, clode-watch real-`semver`) became `fs.cpSync`
    copies (uniform, privilege-free); the two *symlink-semantics* tests (resolve `5`/`5b`) were rewritten
    to inject a mock `fsm` that simulates the symlink, testing clode's readlink+anchor logic on every
    platform without a real OS symlink. Windows EPERM-symlink failures **18 → 2** (the 2 are the deferred
    PTY `makeWsWorlds` node symlink); Windows suite **fail 35 → 28**; POSIX unchanged (378/337/fail 2/39).
    Newly surfaced (was masked by the buildFixtures EPERM crash): the **e2e `claude on PATH last`** test
    fails on Windows for a *non-symlink* reason — `whichClaude`/PATH resolution + exec of a bare `claude`
    fixture file on Windows (no `.exe`, X_OK semantics). Folded into the resolution/PATH work below, not
    symlinks. The `followWrapper` POSIX exec-wrapper tests (~4) remain — assess POSIX-only vs npm-shim.
  - **Windows PATH provider (`whichClaude`) + `claude`-on-PATH exec:** step 6 (`claude` on PATH) uses a
    bare `claude` name + `accessSync(X_OK)`; on Windows a PATH provider is `claude.exe`/`claude.cmd` and
    X_OK differs. Surfaced by the e2e `claude on PATH last` failure. Small; pairs with the npm-shim slice.
  - **Slices 3–5 (combined) — mostly DONE (2026-07-05, commits `d323459`..`b515e09`; findings
    `docs/superpowers/findings/2026-07-05-windows-suite-remainder.md`).** Principle: fix portability bugs;
    mock POSIX-shell/tool LOGIC uniformly (no gratuitous skips); capability-gate only real-shell/tool
    integration. **POSIX is now fully green (`fail 0`)** — the 2 long-standing `ugrep`/`bfs` baseline fails
    are fixed (the argv0-shadow tests source under `bash`, not dash, which couldn't parse `function name{}`).
    **Windows failures 28 → 9.** Landed: `followWrapper` path.win32.isAbsolute; `e2e-dist` node file-scan
    (no `grep`); `runBundle` signal-integration gated to POSIX; snapshot-rewrite real-`sh` integration gated
    (logic covered by pure-string tests); inspect applet-version injectable-spawn mock; `clode-deps` fake-npm
    injectable-spawn mock; `whichClaude` PATHEXT + `6b` mock; `writeUpdateGuardSettings` JSON.stringify escape
    + `clode_update` exec-bit POSIX-gate; `makeWsWorlds` node copy (PTY/TUI now 2 pass/0 fail/4 live-render-skip
    on Windows — the PTY "wildcard" was just the symlink).
  - **Windows suite — final 9 residuals — DONE (2026-07-05). Suite is now GREEN on both platforms:
    Windows `pass 329 / fail 0 / skip 50`; Linux (WSL) `pass 340 / fail 0 / skip 39` (the 11-skip delta is
    the Windows-gated set).** What landed:
    - **`warnAppletSkew` ×3** (`snapshot-rewrite.test.cjs`): made `warnAppletSkew(shadows, spawn=_rawSpawnSync)`
      accept an injectable spawn (mirrors `hostAppletVersion`); the tests inject a `mockSpawn(code, stderr)`
      instead of writing a `#!/bin/sh` stub (unrunnable on Windows).
    - **`writeUpdateGuardSettings` test**: dropped the byte-for-byte assertion (the runtime `JSON.stringify`
      escapes backslashes on Windows) — the `JSON.parse` + `command`-field checks already present cover it.
    - **`rewritten grep shadow` ×2** (`e2e-argv0_shadow.test.cjs`): gated `BASH_SKIP` to also skip on `win32`
      (POSIX-shell-under-bash with POSIX paths / stub applets has no Windows analog; logic covered by the
      pure-string `rewriteSnapshot` tests).
    - **`e2e claude on PATH last`**: the actual root cause was NOT the leaf name (X_OK is ignored on Windows
      so a bare `claude` file resolves fine) but the **test hardcoding `:` as the PATH separator** — split on
      `path.delimiter` (`;` on Windows) mashed `pathDir` into the next entry. Fixed both PATH joins in
      `e2e-resolve.test.cjs` to use `path.delimiter`. (Test 3 only passed before because it resolves via step 5
      first.)
    - **`e2e-deps` ×2** (`auto-install`, `changed manifest`) — the BACKLOG's "clode-deps state quirk" guess was
      wrong: these are the **launcher-level `e2e-deps.test.cjs`** tests (same test *names* as the unit file),
      and they fail because `fakeNpm` emitted a `#!/bin/sh` shim clode can't spawn on Windows. Root cause is a
      **real product bug**: clode-deps spawns `CLODE_NPM` directly, and Windows Node rejects direct `spawnSync`
      of a `.cmd`/`.bat` with `EINVAL` (CVE-2024-27980 hardening) — so real `npm.cmd` would fail too. Fixed in
      product code (`clode-deps.cjs` `npmInvocation`): on win32 a `.cmd`/`.bat` npm is routed through
      `cmd.exe /d /s /c` (the Windows parallel of the sh launcher invoking npm); POSIX / `.exe` spawn verbatim.
      Made `fakeNpm` cross-platform (a `.cmd`+paired `.cjs`, node invoked by absolute path since the sandbox
      PATH carries no node) and gave the sandbox a `ComSpec` on win32 (the OS-shell constant, parallel to
      `/bin/sh` being reachable via the POSIX sandbox PATH). The e2e now genuinely drives npm to completion on
      Windows — closing a real `npm.cmd`-on-Windows capability gap, not just the test.
  - **Next: add a Windows CI leg** to `ci.yml` (now genuinely green, 0 residuals).
- **Windows (and Linux/macOS) arm64** — the npm registry ships `*-arm64` Bun providers; the SEA
  build matrix is x64/darwin-arm64 only.
  (macOS SEA build+smoke+boot is now continuously verified every commit by `ci.yml`, so the old
  "re-verify on a Mac someday" caveat is retired.)

**STATUS 2026-06-30: the JS-port prerequisites are DONE — SEA is now the next actionable frontier.**
`clode` is fully JS+sh→JS: the extractor/inspector/signals are `.cjs`, the inline
snippets are node, the test harness is JS, AND `bin/clode` is now a
`#!/usr/bin/env node` launcher (the sh is deleted; `libexec/clode-main.cjs` +
`clode-*.cjs` modules; bundle run via spawn-child+signal-forward). So "Port the
toolchain to JS" below is COMPLETE. Remaining SEA work is the release-engineering:
vendor the runtime ext-deps into the blob, per-target `postject` injection + Node
build matrix, pin the embedded Node ahead of the bundle floor, replace curl/wget
(already done — `clode-net` uses `fetch`). SEQUENCING (user-set): Node SEA for
Mac+Linux first; convert bats→Node only when aiming at Windows (bats won't run
there); then Windows SEA; QuickJS the further frontier.

- **What it unlocks:** a zero-dependency install — `curl` one binary and run. No
  host Node (clode carries its own), no Python, no npm, no curl/wget. Reaches hosts
  that have no Node, or one too old for the bundle's creeping Node floor.
- **Prerequisites (the real work):**
  - **Port the toolchain to JS.** Node SEA packs JS+Node only, so the Python
    extractor (`libexec/extract-claude-js`) and the shell launcher (`bin/clode`)
    have to be reimplemented in JS to be SEA-packable. Drops the Python dependency
    as a side effect. This is the big one and gates everything else. (The extractor
    half is broken out above as "Reimplement the extraction toolchain in JavaScript"
    — worth doing on its own, ahead of SEA.)
  - **Vendor runtime deps** (`ws`, `yaml`, `string-width`, `strip-ansi`,
    `wrap-ansi`, `semver`) into the SEA blob/assets instead of `ensure_deps`'
    npm-install-on-first-run.
  - **Per-target injection.** SEA blob injection (`postject`) runs against a target
    Node binary and doesn't cross-compile freely, so the matrix needs a runner or
    cross toolchain per target. Exotic targets (NetBSD, legacy macOS, non-x86) may
    have no official Node build — supplying custom Node builds for them is precisely
    the "matrix the likes of which the world has never seen" flex.
  - **Pin + track the embedded Node** against the bundle's required major (today
    >= 24, creeping); the SEA's Node must stay ahead of it.
  - **Replace curl/wget** in the update path with Node's built-in `fetch` so the
    last external tool dependency drops too.
- **Keeps the runtime model:** the SEA still fetches upstream JS into the provider
  store and extracts+runs it under the embedded Node; `clode update` /
  re-extract-on-change are unchanged. The SEA changes *how clode itself is shipped*,
  not how it runs Claude Code.
- **Gating:** "once everything's working really well" (per `LONG-TERM.md`) — the
  shim coverage, the extract-time durability gate, and the JS port want to be solid
  first.
- **Next step beyond SEA — QuickJS for true any-platform native builds.** Node SEA
  still needs a Node binary per target, so the reachable set is bounded by where Node
  itself builds. The further reach is to implement enough of the Node API surface that
  the app (clode's own JS toolchain, once ported, plus the extracted bundle) runs under
  **QuickJS**, which compiles to a native binary essentially anywhere — no per-target
  Node required. The cost shifts to us: with QuickJS, providing the Node APIs the
  bundle + toolchain use becomes *our* job (the same kind of host-API gap-filling the
  `bun-shim` already does for `Bun.*`, one layer down). Sequencing: JS toolchain port →
  Node SEA → QuickJS. Strategic framing + a Node-compat-layer pointer live in
  `LONG-TERM.md` ("Build a Node SEA"). Phase 1 (technology qualification) ran
  2026-07-05/06: **GO — build the phase-2 node-compat port on quickjs-ng (engine) +
  txiki.js (IO layer); 27 of 62 Node-API keys are provided natively, 30 shimmable, 4
  need scoped C, 1 hard (degrades to a stub), 0 architectural blockers, and the
  North-Star bytecode memory path measured on darwin/aarch64 fits the mac68k-class ceiling (mac68k itself unmeasured, qemu boot gap)** — see
  `docs/superpowers/specs/2026-07-05-universal-binaries-phase1-report.md`.

## node-shim Linux portability (first surfaced by the s390x BE oracle, 2026-07-09)

The release-matrix s390x-musl leg is the FIRST time the node-shim suite runs
against a **Linux** tjs (the pinned binary is darwin; the qemu guests are
NetBSD). The BE oracle (run 29065977866) proved the engine is big-endian-clean
(url characterization + crypto KAT + Buffer semantics all green), but surfaced
darwin assumptions baked into the shim that a Linux target exposes. These are
Linux-portability debt, NOT big-endian bugs — their own TDD workstream, and
they'll matter for the eventual Linux-NATIVE (non-emulated) legs too:

- **os.constants.signals is a hardcoded darwin table.** The shim returns
  darwin signal numbers (SIGBUS=10) where Linux differs (SIGBUS=7); host-node
  diff fails on Linux. Fix: per-platform signal tables (linux / darwin /
  netbsd / the BSDs) in libexec/node-shim/modules/os.cjs (or constants.cjs).
  TDD: characterize against host node per-platform.
- **bun:ffi `suffix` hardcodes the macOS 'dylib'.** Should be platform-aware
  (.so on Linux + the BSDs, .dylib on darwin, .dll on Windows) —
  libexec/bun-shim.cjs BUN_BUILTINS['bun:ffi'].suffix. The bunshim test also
  hardcodes the macOS extension; fix both.
- **Audit for other hardcoded darwin assumptions** now that a Linux target
  exists: library extensions, default paths, any os.constants.* /
  process.* / signal / errno tables, DYLD_* vs LD_* env handling. Sweep
  libexec/node-shim/** and libexec/bun-shim.cjs.

Not matrix-blocking (the BE oracle scopes these out and is non-blocking); the
published Linux builders are musl-static and smoke green (PONG + attest). This
is about node-shim FIDELITY on Linux, which the shim-fidelity gate should grow
to cover once a Linux tjs is a first-class local build target.
