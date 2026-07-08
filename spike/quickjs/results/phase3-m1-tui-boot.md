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

## The frontier (REMAINING): Ink commits but paints nothing

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
0. **Prime suspect — stdin suspend/resume semantics.** Our `tty.ReadStream`
   `pause()` is an inherited no-op and `resume()`/`setRawMode` (re)start the pump;
   Ink's `suspendStdin`/`resumeStdin` may depend on real pause/resume flow-control
   or on `process.stdin` emitting/withholding data in a way the pump diverges
   from. Instrument `suspendStdin`/`resumeStdin` (and Ink's `pause`/`resume`) to
   see which call the startup blocks in, and whether it awaits a stdin/`readable`
   event our pump never emits.
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

## Pointers
- Fixes: `libexec/node-shim/modules/{constants,fs,tty}.cjs`; tests
  `test/node-shim-tui-boot-walls.test.cjs`, `test/e2e-tui-tjs.test.cjs`.
- Shim TTY layer (phase-3 tasks 1–3): `spike/quickjs/results/` history +
  `docs/superpowers/plans/2026-07-08-phase3-tui-under-tjs.md`.
- Oracle bundle: the staged `2.1.202` `cli.cjs` (M3b scratch) or any resolved
  provider; `build/tjs/tjs`.
