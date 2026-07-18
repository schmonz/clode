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
  build.sh path. **PUBLISHED (12, 2026-07-18):** amd64, arm64, sparc, m68k,
  sparc64, alpha, hppa, macppc, pmax (mipsel), sgimips (mipseb), sh3el (SuperH),
  earmv7hf (32-bit ARM).
  The `-a MACHINE_ARCH` composite input (2026-07-18) unlocked multi-arch ports
  (evbarm/sbmips/evbsh3 abort `build.sh -m` without it). Walls below.
- **NetBSD hard-arch tier — three distinct wall classes (batch-3 diagnoses,
  2026-07-18, run 29654544915), all left soft-fail onboarding:**
  - **i386** (32-bit LE x86) — toolchain builds; **quickjs** compile FAILS at
    `cutils.h:678` in the `JS_X87_FPCW_SAVE_AND_ADJUST` macro (x87 FPU control-word
    save — only compiled on 32-bit x86): `a label can only be part of a statement
    and a declaration is not a statement` (C: declaration after a label). A small
    carried quickjs patch (statement/`{}` after the label) should clear it — the
    cheapest wall here, and it's the bytecode donor for vax.
  - **riscv64** (64-bit LE) — toolchain builds; **libuv** `src/unix/async.c:422`
    fails to ASSEMBLE: `unrecognized opcode '0x0100000f'` (a `fence`/`pause`-class
    instruction the netbsd-10 riscv assembler predates). Try a `-march`/`-mno-*`
    toolchain flag or a small libuv patch; toolchain-version-bound, not our code.
  - **mips64eb** (64-bit BE) — **NOT an engine wall.** NetBSD `build.sh
    distribution` fails building the sbmips userland (`usr.sbin/crash` →
    `unknown type name 'bool'`) at the `netbsd-10` pin. A NetBSD-src/sbmips issue;
    try a different src pin or a newer branch. The engine never got a chance.
  - **vax** (32-bit LE) — dropped from the fleet (was a leg, removed 2026-07-18):
    toolchain builds, but quickjs assumes IEEE floats and VAX has **non-IEEE** F/D/G
    format. Real fix = a soft-float IEEE mode for GCC's VAX backend (a GCC-backend
    project, not a leg tweak); bytecode donor = the i386 leg once i386 lands.
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

## Phase 3 — TUI + human turn + agentic tool use under tjs: SHIPPED (2026-07-08)

M1 (TUI paints), M2 (human-verified interactive turn), slash commands, and the
AGENTIC Bash tool all work under `CLODE_ENGINE=tjs`. Trail: `e3e5a15`..`2d1f249`
+ later; detail in `spike/quickjs/results/phase3-*.md`. Landmarks:
- **TUI paints** via a real tty layer (`94905f5`..`6521c1f`, `e00506f`) + the paint
  blocker fix `bcf53eb`: a quickjs-ng libregexp bug where `\p{}` under the `v` flag
  mis-matches (the loader downgrades `v`→`u`; **upstream candidate**).
- **M2 human turn** via the Intl polyfill + 3 stream gaps (`f2afbe8` Intl,
  `d39fd4d` setEncoding, `4bed83a` child.stdin Writable, `f7da37e` Intl new-optional).
- **Agentic Bash tool** (`d4e197d`): process.memoryUsage/cpuUsage + real numeric-fd
  inherit; plus the persistent-shell sync-write byte-count fix (`1222660`,
  `txiki-stream-write-sync-number.patch`).
- **Spawn UAF** at the launch-failure path (`e3e5a15`, `txiki-spawn-fail-uaf.patch`);
  CLOEXEC fd-leak into sync children (`7b36cf5`); ws/bundled-deps fail-loud (`45306cb`).
- Key finding: the `-p` and TUI paths fire **ZERO** missing-method walls — the
  blockers were engine/behavioral bugs, not missing APIs (validates the hybrid gate).

**Still open from Phase 3:**
- **M3 (render parity)** — tjs interactive render is byte-heavy (~1.2MB vs node ~8KB/
  turn, redundant full redraws); non-fatal, the last phase-3 milestone.
- **apicheck v1 → `clode selftest`** — v0 shipped (`scripts/apicheck.mjs`); v1 = the
  embeddable oracle (recording-Proxy coverage %, checked-in golden baselines, a corpus
  that exercises TOOL-USE turns), then wire it into a shipped `clode selftest [--json]`.
- **Upstream-txiki batch** (awaiting go-ahead): the spawn/stream/CLOEXEC patches + the
  quickjs-ng `v`-flag regexp fix + the phase-2 batch (sync-fs, sync-spawn CLOEXEC,
  no-origin, netbsd, default-stack-size).
- Minor: `process.resourceUsage` still undefined (add when a path needs it).

## Endgame — automated API-surface gate: v0 SHIPPED

**Goal:** given a new upstream `cli.cjs`, tell us BEFORE shipping what the bundle needs
and where tjs diverges from node — a work-list, not user-reproduced breakage. Two axes:
**presence** (`[wall]` misses) and **correctness** (defined-but-wrong, e.g. the v-flag
regexp/UAF — only a node-vs-tjs behavior diff sees these). Static enumeration is
undecidable; the endgame is empirical + regression-gated, **corpus as the only real
lever**. Design (untracked): `docs/superpowers/specs/2026-07-08-api-surface-gate-design.md`.

- **v0 SHIPPED: `scripts/apicheck.mjs`** — seed corpus run under node AND tjs; reports the
  `[wall]` miss union, node-vs-tjs exit/stdout divergences, and the cross-version
  require-target set-diff; CI gate (first run 2.1.204: 0 walls, 0 divergences). v1/v2
  tracked under Phase 3 above.
- **Oracle principle (load-bearing for exotic platforms):** where `node` doesn't exist to
  diff against (NetBSD/SPARC), capture canonical/deterministic outputs (exit codes, crypto
  digests, fixed frames) on a reference platform, check them in, and diff the exotic
  platform against the record — this is what catches big-endian divergence, and it makes
  v1's baseline manifest load-bearing.
- **Harness caution (still live):** this session's env carries `CLAUDE_CODE_BRIDGE_SESSION_ID`
  (child bundle auths via the parent bridge) — strip it to test real subscription auth.

## Hermetic test execution — SHIPPED (Spec 1 + 2a + 2b, 2026-07-03); suite is pure node:test

The suite now seals both directions (no test reads/writes the real store/cache/PATH;
private disposable HOME per test) and is structurally enforced — one `CLODE_STATE_ROOT`
choke point (`libexec/clode-paths.cjs`) plus the `test/hermetic-guard.cjs`
preflight/postflight guard. Spec 2a/2b converted every `.bats` file to `node:test` and
deleted `test_helper.bash`, so `run-all.sh` runs `node:test` only (Windows-portable, no
bash framework). Live-render TUI/doctor tests spawn the REAL bundle (which probes the
macOS Keychain and pops dialogs), so they're gated behind `CLODE_LIVE_RENDER=1` and skip
by default. Designs/plans: `docs/superpowers/{specs,plans}/2026-07-0{2,3}-*`.

**Still open (one item):** curate the live `/doctor` parity allowlist —
`e2e-doctor-parity` **test 2 is skipped**. A STRICT native-vs-clode comparison reds on
environment noise, not clode bugs; the goal (user decision) is a curated allowlist of
ignorable areas (Updates, Remote Control, Keychain warnings) that fails on anything else
— the upstream-`/doctor`-format drift signal. Needs: give clode's capture the REAL render
deps (kill wrapping noise), normalize status glyphs in `doctor-parity.cjs parseScreen`,
extend the allowlist, un-skip. Validation needs live captures (Keychain dialogs each
cycle) — batch it. (Related: un-skip `test_tui` #60, TUI-fails-loud-on-missing-ws, once
its hermetic per-project trust-state fixture is rebuilt.)

## RESOLVED (2026-07-18 sweep): Test-fake deps leaked into the REAL clode store

Both halves closed. **Investigate:** `4a99d2b` ("never seed fake deps into an
inherited CLODE_DEPS store") closed the seeding vector. **Prevent:** the guard the
item asked for now exists — `test/hermetic-guard.cjs` `preflight(dataStore)` reads
every `node_modules/*/package.json` and refuses to run if any version contains
`clode-test`. (History: on 2026-07-02, four `0.0.0-clode-test` stubs — `semver`,
`string-width`, `strip-ansi`, `wrap-ansi` — had leaked into
`~/.local/share/clode/node_modules` and broke `clode-watch`'s real-semver test.)

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

## RESOLVED (2026-07-18 sweep): Reimplement the extraction toolchain in JavaScript

Done 2026-06-30. `1f229d6` ported `extract-claude-js` to JS (byte-identical across
7 goldens), `17540d7` dropped Python from the runtime (bin + libexec are node+sh
only), and `262705a` dropped it from the test runner — clode is now **python-free**.
The extractor and inspector are `libexec/extract-claude-js.cjs` /
`libexec/inspect-claude-bundle.cjs`, preserving the exactly-one-match-or-fail-loud
carve/splice/verify contract. (The old bats-vs-node test split question is moot: the
suite is now pure `node:test` and `bin/clode`'s launcher role largely gave way to the
tjs/native builder path.)

## Node SEA single-binary releases + a platform build matrix

> **SUPERSEDED (2026-07-18 sweep) — retained for reference.** The SEA packaging
> approach below was retired in favour of the tjs-engine cross-build matrix
> (`scripts/tjs-legs.mjs`, ~44 legs across the OS/arch fleet); `scripts/build-sea.mjs`
> is gone, and even the Windows-only SEA holdout was later dropped for MSVC-native
> tjs. What survives as clode's Node path is `naude` (`scripts/build-naude.mjs`), a
> different thing. **Still-live within this section:** (1) the **code-signing / SAC
> decision memo** below is a lasting reference — its "ship unsigned" decision applies
> to the tjs binaries too; (2) one concrete open item — Windows `signtool` wiring in
> `release.yml` behind a secret (`sea-sign.cjs` stub exists), deferred until a user is
> actually SAC-blocked. Everything else here (SEA build steps, Windows-SEA Plan B
> slices, the 2026-06-30 JS-port prereq status) is historical.

_(Superseded SEA build details — north-star framing, the Windows SEA "Plan A"
build/smoke, `build-sea.mjs`/`sea-sign.cjs`/`platform-tag.cjs` mechanics — removed;
the approach was retired for the tjs matrix per the banner. The code-signing /
SAC decision memo below is kept as lasting reference.)_

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

_(Superseded — the Windows-SEA "Plan B" bringup (CI build job, real-bundle boot, the
per-commit SEA gate, interactive TUI/session, POSIX-shim tool-use, provider
resolution/fetch, arm64) and the 2026-06-30 JS-port-prerequisites + QuickJS-ng "GO"
status all removed. That work either shipped-then-retired with Node SEA or became the
tjs cross-build matrix we now ship (`scripts/tjs-legs.mjs`). Phase-1 engine report:
`docs/superpowers/specs/2026-07-05-universal-binaries-phase1-report.md`. The one
surviving open item — Windows `signtool` wiring — is noted just above and in the
section banner.)_

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
