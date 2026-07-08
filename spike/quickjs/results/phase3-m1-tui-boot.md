# Phase 3 · M1 — booting the interactive Ink TUI under tjs: walls fixed + the current frontier

**Status (2026-07-08): IN PROGRESS — not yet painting.** The real Claude Code Ink
TUI, launched under `CLODE_ENGINE=tjs`, now starts and runs its whole async
startup (keychain, git, `fetch HEAD api.anthropic.com`, dozens of timers) under
the phase-3 TTY shim, but **does not yet paint its first frame**. Four hard walls
were found and fixed (committed); one frontier remains. This doc is the handoff.

## Method — the render-byte differential

The decisive oracle: run the SAME staged bundle (`2.1.202` `cli.cjs`) under a
probe-answering PTY (node-pty + `@xterm/headless`, the `tui-screen.cjs` harness
shape) under **host node** vs **tjs+loader**, and compare raw output bytes.
- Host node: ~2062 bytes → renders the "Claude Code" welcome box.
- tjs: started at **13 bytes** (terminal-init escapes only), no paint.

Each wall was a hard failure (a thrown `TypeError` surfaced as an
`unhandledRejection`, or a silent hang) that aborted startup before first paint.
Fixing each moved the byte count and exposed the next. Minified stack frames were
mapped by exploiting quickjs-ng's `new Function` +2 line offset (`<input>:290` =
module source line 288) to locate the failing call in `cli.cjs`.

## Walls fixed (committed `efaf6d7`, with characterization tests)

1. **`constants` (legacy module) was an unimplemented wallProxy.** The bundle's
   very first move is `constants.hasOwnProperty(...)`; the proxy threw
   `not implemented`. Fixed: `libexec/node-shim/modules/constants.cjs` — a real
   flat darwin constants object (231 keys: errno/signal/fs/dlopen), generated from
   host node. Render 13 → 170 bytes.
2. **`fs.utimes`/`lutimes` were missing** (`TypeError: not a function`). The bundle
   runs a temp-dir **mtime-precision probe**: `mkdir → fs.utimes(path, o, o, cb) →
   fs.stat → a.mtime.getTime()`. Implemented over `tjs.utime`/`tjs.lutime` (Node
   passes Date or numeric **seconds**; tjs wants **ms**). `futimes` is documented
   best-effort (no fd-based utime primitive in this tjs). Render 170 → 219 bytes.
3. **`fs.Stats` exposed only `size`/`mode`/`mtimeMs`** — no `.mtime` Date, so the
   probe's `a.mtime.getTime()` threw `cannot read property getTime of undefined`.
   Added `atime`/`mtime`/`ctime`/`birthtime` (Date + `*Ms`) and the standard
   numeric fields (`dev`/`ino`/`nlink`/`uid`/`gid`/`rdev`/`blksize`/`blocks`),
   plus `isBlockDevice`/`isCharacterDevice`/`isFIFO`/`isSocket`. DIVERGENCE
   (documented): FSS.stat surfaces only a whole-second `mtimeMs`, so the other
   times are approximated as `mtime` and sub-second precision isn't observable
   (the probe reads "second" resolution — safe/conservative).
4. **`tty.WriteStream` lacked the readline cursor/erase methods** the bundle calls
   during render: `cursorTo` (2×), `clearLine` (10×), plus `moveCursor` /
   `clearScreenDown`. Added them emitting the standard ANSI (`ESC[..G`/`ESC[..H`,
   `ESC[{0,1,2}K`, `ESC[0J`), each returning true + firing the optional callback.

Tests: `test/node-shim-tui-boot-walls.test.cjs` (4 rows, node-vs-tjs where the
value is platform-shared). Full shim suite green (95 pass / 4 skip / 0 fail).
`test/e2e-tui-tjs.test.cjs` is the opt-in M1 boot assertion scaffold
(`CLODE_TJS` + `CLODE_LIVE_RENDER`), currently red on the frontier below.

## Walls fixed, round 2 (committed `e00506f`, with characterization tests)

5. **Dynamic `import()` rejected under the loader** (`could not load`). quickjs's
   native `import()` uses tjs's ESM loader, blind to the shim's CJS registry, so
   the bundle's **~58** `await import("fs")` / `import("path")` startup calls
   (config read via `frt`, realpath/mkdir) all threw. Routed `import(` → a global
   `__tjsDynImport` that resolves via `require()` and returns an ESM-interop
   namespace (named exports + `default`). NOTE: kept a **global**, not a
   per-module `new Function` arg — the extra eval parameter perturbed the pinned
   tjs codegen enough to **resurface a latent exit-time SIGSEGV** in the
   child_process ENOENT path (the documented quickjs-ng heap-layout fragility;
   the ENOENT handling itself was correct, only teardown crashed). Tradeoff:
   `import()` resolves from the loader root, not the importing module's dir —
   fine for the bundle's bare specifiers; a relative `import()` is a future wall.
6. **`tty.ReadStream` was flowing-only** (the shim's base Readable `push` →
   immediate `'data'`, no buffer, no `.read()`, no `'readable'`), but **Ink reads
   stdin in PAUSED mode** — an `'readable'` listener + `.read()` loop (the
   bundle's `suspendStdin`/`resumeStdin` add/remove `'readable'` listeners).
   Confirmed with a node-vs-tjs probe: paused `read()` returned bytes under node,
   nothing under tjs. Rewrote `ReadStream` to own both modes with an internal
   byte queue; the persistent utf8 decoder is preserved across both.

Both are REQUIRED for any interactive use, but **neither paints** — the render is
still 13 bytes, and React still commits an empty tree in exactly ~4 scheduler
ticks (unchanged by these fixes). So the paint gate is a **React Suspense wait**
on a promise these don't resolve.

## RE-DIAGNOSIS (2026-07-08, deeper instrumentation): it's an EVENT-LOOP WEDGE, not a Suspense wait

Timer-fire instrumentation overturned the Suspense theory. Over a 22-second run
the bundle **schedules 21 timers** (delays 0/1500/3000/5000/10000/600000 ms) but
**only 4 ever fire** — and those 4 are all the `delay=0` ones (the React scheduler
ticks) that ran during the initial startup burst. Every `delay≥1500` timer is
armed and never fires. So the libuv event loop stops making progress after the
first burst; "React commits an empty tree then idles" is a *symptom* of the loop
wedging, not a Suspense boundary.

Evidence:
- **CPU profile:** ~70–79% for the first ~6 s (heavy work / spin), then drops to
  **0%** and stays there while the process remains alive — classic "spun, then
  parked."
- **Timers:** 4 of 21 fire (all `delay=0`); no `delay≥1500` timer fires in 22 s,
  though the loader's setTimeout wrapper arms them via native `setTimeout`.
- **A single pending `fetch`** (`HEAD api.anthropic.com`) never completes in-app —
  yet the identical fetch standalone under tjs returns 404 in **75 ms**. So the
  pending fetch is a *symptom* of the wedged loop, not the cause.
- **Native stack (macOS `sample`) at the 0% wedge:** main thread in
  `uv_run → uv__io_poll → kevent`, with `read` syscalls recurring across every
  sample and occasional `uv__run_timers`/`js__evlib_timer_cb`.
- **Ruled out:** the stdin pump (gating it off — `CLODE_NO_PUMP` — changed
  nothing: still 4 fires, still no paint), Suspense/import()/paused-stdin (all
  fixed, none changed the wedge), and `spawnSync` (none is called at startup).

This is precisely the phase-2 take-stock's **#1 named TUI risk**: quickjs-ng drains
the entire microtask queue before returning to libuv, and `setImmediate` is
polyfilled as `setTimeout(0)`, so an event-loop / microtask-vs-timer ordering
divergence can starve the timer phase. The recurring `read` in the native stack is
a lead (cf. the phase-2 gate-3 finding that a `qjs -c` standalone busy-spins
`poll + read(→0)` on EOF'd stdin — there is an upstream repl-eof-spin patch for a
sibling case).

### Next steps (event-loop level — a distinct, native-leaning investigation)
1. **Find the microtask/read loop that starves libuv.** Instrument `queueMicrotask`
   / `Promise` job counts and correlate with the CPU spike; identify the recurring
   `read` fd in the native stack (dtrace/lldb on the tjs loop, or log every
   `__tjs_fs_sync`/libuv read).
2. **Check the `setImmediate`=`setTimeout(0)` polyfill under sustained load** — if
   React or a stream reschedules via a path that never yields to the timer phase,
   timers starve. A truer `setImmediate` (a check-phase primitive, or a
   MessageChannel-backed macrotask) may be required — a tjs-level change.
3. The un-minified bundle is available for reference at
   `<scratchpad>/deminify/cli.pretty.js` (753k lines, js-beautify; var names still
   minified) — use it to decode a hot function once the native `read`/loop is
   localized.

## (SUPERSEDED) Earlier theory: React commits an empty tree, then Suspends forever

After the four fixes, tjs no longer errors and runs its full startup, but stalls
at **13 bytes forever** (25s+), silently — no error, no `[wall]`, no missing-method
access on the stdio streams. What's established:

- **Exactly one `process.stdout.write`** happens (the 13-byte terminal-init:
  `ESC7 ESC[r ESC8 ESC[?25h`). Node writes the same 13 bytes, then **continues**
  with `ESC[?25l ESC[?2004h ESC[?1004h ESC[?2031h …` (terminal-mode setup) and the
  render. tjs stops after the first write.
- **React's scheduler runs only ~4 ticks then goes idle** (4 `setImmediate`→
  `setTimeout(0)` fires, all fired, then no more). So Ink mounts and React
  commits, but the committed frame produces no further writes — consistent with
  the app root rendering `null`/empty on first commit and an async init (a
  `useEffect`) never resolving to flip it to content under tjs.
- **Not** a stdio-write problem: a fixture writing 100 KB through the real
  `tty.WriteStream` under a PTY writes all bytes cleanly (isTTY/columns correct).
- **Not** `MessageChannel`: tjs lacks it, but the bundle's React scheduler picks
  the `setImmediate` branch first (`typeof setImmediate === 'function'`), so it's
  unused here (a minimal MessageChannel shim changed nothing — reverted).
- **Not** a probe-response hang: the same PTS/xterm harness renders node fine.

### Precise locus (2026-07-08, instrumented)
The exact startup timeline under tjs, from stdin/write instrumentation:
`process.stdin.setRawMode(true)` → the input pump starts → **one**
`process.stdout.write` of the 13-byte reset (`ESC7 ESC[r ESC8 ESC[?25h`) → **hang**.
The pump receives **zero bytes** (the app never sends a capability query, so the
PTY/xterm has nothing to auto-reply to — stdin-starvation is a *symptom of* the
hang, not its cause). Node, at this same point, continues with the terminal-mode
setup block (`ESC[?25l ESC[?2004h ESC[?1004h ESC[?2031h ESC[>1u …`) and paints.
The code locus is Ink's terminal manager — `enterAlternateScreen()` /
`exitAlternateScreen()` and their `suspendStdin()` / `resumeStdin()` +
`this.pause()`/`this.resume()` calls (found in `cli.cjs` near the
`\x1B[?1049h…\x1B[?25h\x1B[2J\x1B[H` alt-screen writes). The app enters raw mode,
writes the first reset, then awaits something in this enter-interactive path that
never resolves under tjs — while React, having committed an empty first tree,
sits idle (~4 scheduler ticks, no further state update to re-render).

### Next steps for closing the frontier
The signature is now unambiguous: **React commits an empty tree (~4 scheduler
ticks) and goes idle** — no error, no wall, no missing method, stdin + import()
both working. That is the textbook shape of a **Suspense boundary stuck on a
thrown promise that never resolves** (the bundle uses `Suspense` 47×). The app
root renders its fallback (null) and waits for an initial async resource; under
node it resolves and re-renders the welcome, under tjs it never does.
1. **Find the suspended promise.** Instrument to catch the promise a component
   throws for Suspense (React calls `.then` on it). Candidates for a startup
   Suspense resource: an initial config/context load, an MCP/tool init, or a
   data source read via a Suspense-integrated cache (`use()` / a resource
   wrapper). The `security` keychain read returned **exit 44 (not found)** in the
   minimal harness (vs the credential existing) — worth checking whether an auth
   resource suspends and never settles under tjs.
2. **App-source insight would shortcut this.** The blocker is now in the bundle's
   own React tree, not a shim primitive; the render-byte differential got us here
   but can't see inside a suspended component. A minimal Ink+Suspense repro, or
   the un-minified startup source, would localize the resource fast.
3. (superseded) The earlier stdin suspend/resume suspicion is CLOSED — paused-mode
   `read()` now works and did not change the paint behavior.
1. **Find the un-resolving async init.** Instrument which promise/`useEffect`
   never settles between "startup done" and "first content paint". The app root
   renders null until some initial state is set; that state's source completes
   under node but not tjs. Likely candidates to probe: terminal-size / capability
   negotiation the app awaits, a config/onboarding load, or an
   `await`-in-effect over an API the shim resolves differently.
2. A **minimal Ink repro** would isolate Ink/React-from-app, but ink/react are
   bundled-only (not in `node_modules`) — would need to vendor a tiny Ink app.
3. Re-check event-loop **ordering** the render depends on (the phase-2 take-stock
   named `setImmediate`/microtask ordering as the top TUI risk): confirm the
   `setImmediate`→`setTimeout(0)` polyfill delivers the React scheduler's
   continuation turns the way V8-node does (the 4-ticks-then-idle is the clue).

## Update (2026-07-08, deep event-loop investigation): the loop is NOT the cause

A focused investigation (dtrace on the live parked process + JS-level fault
isolation) **disproves the "event-loop wedge / microtask-vs-timer starvation"
theory** that was the top suspect, and re-characterizes the stall. Verified
findings, in order of confidence:

1. **The libuv loop is healthy — it does NOT wedge or starve.** dtrace on the
   parked process (`uv__io_poll:entry/return`, `uv__run_timers`, `uv__hrtime`)
   shows the loop **cycling normally**: the clock advances, `uv__io_poll` returns
   on schedule, `uv__run_timers` runs every iteration, driven by the lws evlib
   heartbeat (`tjs__evlib_timer_cb`, an unref'd `uv_timer` re-armed by
   `lws_service_adjust_timeout` every ~1.9 s). The process sits at CPU ~0 because
   it is **correctly idle**, blocked in `kevent` with a finite timeout, waiting
   for work — not spinning, not frozen. The earlier "21 scheduled / 4 fired"
   reading is the loop legitimately idling once the startup burst drains.
2. **`setImmediate`/microtask ordering is NOT the problem.** Minimal repros under
   `tjs run loader.cjs`: a self-rescheduling `setImmediate` storm does **not**
   starve a `setTimeout(fn,1500)` (timer fires on time); an unbounded microtask
   chain starves timers under **host node too** (expected, not tjs-specific);
   `fetch`+timers+`setImmediate` all interleave correctly. So next-step #3 above
   (the phase-2 "top TUI risk") is **CLOSED** — the polyfill delivers turns fine.
3. **The paint failure is DETERMINISTIC (6/6 runs stall at exactly 13 bytes),
   not a race.** So it is a semantic divergence in the render path, not timing.
4. **The paint is NOT gated on `fetch HEAD api.anthropic.com`.** Faking that
   request in the loader (resolve a synthetic 200, or reject fast) leaves the
   paint at 13 bytes — the connectivity check is a red herring for the paint.
5. **The render never *attempts* the frame write.** Instrumenting the shim's
   `writeSyncFd`: under tjs there is **exactly one** `fd=1` write (the 13-byte
   `ESC7 ESC[r ESC8 ESC[?25h`), no throw, no `EAGAIN`. So it is not a stdout
   flush/backpressure problem — the code that would write the frame simply never
   runs. The Ink renderer object *is* constructed (those 13 bytes come from its
   constructor), but the first frame is never committed. This is consistent with
   the "empty first tree / stuck Suspense" theory above, refined: the stall is
   between Ink construction and first-frame commit, upstream of any capability
   query, and independent of the loop and the fetch.

### The fetch is separately broken (same native fd-race as M3b, distinct symptom)
The `fetch HEAD api.anthropic.com` does hang under the TUI (but, per #4, that is
not why the paint stalls). `lsof` + dtrace of the live process show: **DNS
resolves fine** (`sendto`/`recvfrom` on the UDP resolver fd succeed), a TCP
`connect()` is attempted and then **retried rapidly** (5× on one fd in ~1 ms),
the connection is *"closed before established"*, and by the parked state **no TCP
socket survives — only the UDP DNS socket lingers**. This is the exact
`libwebsockets` "closed before established" signature and matches the **native
fd-race documented in `phase2-m3b-subscription-auth.md`** (concurrent `uv_spawn`
pipe fds leaking/colliding with other sockets under the bundle's startup burst).
The TUI drives a *heavier* concurrent-spawn burst than `-p`, overlapping the
fetch's connect/TLS window — so the same latent race now clobbers the lws socket.
Not reproducible synthetically (fetch + 8-way spawn bursts, tight interleaving,
busy→idle transitions all succeed) — it needs the bundle's exact spawn/stdio mix,
exactly as M3b found. Candidate fix is the same: a tjs C patch to set `CLOEXEC`
on spawn pipe fds / fix the fd-ordering window in `src/mod_process.c` +
`uv_spawn`.

### Where the paint hunt is blocked (for the next session)
App-side bisection of the render path is **obstructed by the minified bundle**:
(a) Ink patches `console`/`stderr` in its constructor, swallowing logs; (b) the
bundle's internal `require("fs")` throws in module scope, so file-logging from
injected probes silently fails; (c) **minified names collide across modules**
(`Idt`, `Fta`, etc. are reused), so stack-frame names cannot be mapped to source
anchors — markers injected immediately before a statement do not fire even though
the statement demonstrably runs, because the *running* copy is a different
module's same-named function. A reliable in-runtime logger exists
(`globalThis.__tjs_fs_sync.write(2, …)`, or an env-gated loader hook) and fires
from bundle top-level, but not from the mis-identified inner anchors. **Next
session: get an un-minified (or source-mapped) startup bundle, or a vendored
minimal Ink+React-concurrent app**, to localize the un-resolving initial render
without fighting name collisions. The `use()`/Suspense-resource theory (item #1
under "Next steps" above) remains the leading candidate, now with the loop and
the fetch both ruled out as causes.

## Pointers
- Fixes: `libexec/node-shim/modules/{constants,fs,tty}.cjs`; tests
  `test/node-shim-tui-boot-walls.test.cjs`, `test/e2e-tui-tjs.test.cjs`.
- Shim TTY layer (phase-3 tasks 1–3): `spike/quickjs/results/` history +
  `docs/superpowers/plans/2026-07-08-phase3-tui-under-tjs.md`.
- Native fd-race (the fetch symptom): `spike/quickjs/results/phase2-m3b-subscription-auth.md`.
- Oracle bundle: the staged `2.1.202` `cli.cjs` (M3b scratch) or any resolved
  provider; `build/tjs/tjs`.
