# Phase 2 · M3 — headless `-p 'say PONG'` round-trip under tjs (PROOF)

**Milestone claim:** the REAL, unmodified Claude Code 2.1.202 bundle, booted
under the patched `build/tjs/tjs` via the node-shim loader (`tjs → node-shim →
bun-shim → cli.cjs`), completes one non-interactive Anthropic Messages
round-trip against a LOCAL MOCK — it prints `PONG`, exits 0, and the mock
records a real `POST …/v1/messages`. No TUI, no branded wall, no bare error,
no hang. Proven fully OFFLINE against the mock (no key). The gated LIVE finale
(Task 5) is left for a key-holder.

- Host node: `node` v26.3.0 (pkgsrc) — reference oracle (`test/node-shim-roundtrip-oracle.test.cjs`).
- tjs: `build/tjs/tjs` — pinned txiki.js v26.6.0 + quickjs-ng v0.15.1, **three**
  patches (`js_exepath`, `__tjs_fs_sync`, `txiki-default-stack-size` 4MB). **No
  new patch and NO stack bump were needed for M3.**
- Date: 2026-07-07. Platform: darwin/arm64.

---

## Inputs

- **Provider:** Claude Code **2.1.202 (darwin-arm64)**, `CLODE_PROVIDER_BIN`
  → `~/.local/share/claude/versions/2.1.202` (243,631,376 bytes). Extracted via
  `libexec/extract-claude-js.cjs` → `cli.cjs` + `bun-shim.cjs` beside it,
  `NODE_PATH=$PWD/node_modules` (feross Buffer + ext-deps).
- **Mock:** `test/mock-anthropic-helper.cjs` — a local `node:http` server
  answering `POST …/messages` with a canned streaming-SSE Messages response
  whose only assistant text is `PONG`. **HTTP (plain), not https** — see below.
- **tjs provenance:** unchanged from M2 (three patches). `build/` gitignored;
  reproducible from the committed patches via `scripts/build-tjs.mjs`.

---

## Rung A — offline mock round-trip (the milestone)

Command (module-level, exactly as M2 drove the staged bundle), env
`ANTHROPIC_BASE_URL=<mock http url>`, `ANTHROPIC_API_KEY=sk-ant-mock` (dummy,
mock ignores it), `NODE_PATH=$PWD/node_modules`, stdin `/dev/null`:

```
build/tjs/tjs run libexec/node-shim/loader.cjs <staged>/cli.cjs -p 'say PONG'
```

Verbatim result (pristine extract, no injected probes; 3/3 runs identical):

```
[out] PONG
exit=0
MOCK REQUESTS: ["HEAD //","POST /v1/messages?beta=true"]
```

The host-node oracle (`node cli.cjs -p 'say PONG'` against the same mock) prints
`PONG`, exit 0, same `POST /v1/messages?beta=true` — the tjs run reproduces the
oracle's visible response and request. **The round-trip actually happened** (the
mock recorded the Messages POST; it is not a short-circuit).

### http vs https (the base-URL wall-walk decision)

**HTTP (plain) — no TLS needed.** The bundle's SDK honors `ANTHROPIC_BASE_URL`
and issues `POST http://127.0.0.1:<port>/v1/messages?beta=true`; txiki's native
`fetch` accepts `http://127.0.0.1` and reads the SSE body without a CA. The
https/self-signed fallback in the mock harness was **not** exercised.

### api.anthropic.com eval-POST note (flagged, not a differentiator)

During startup the bundle makes a `POST https://api.anthropic.com/api/eval/sdk-…`
(Statsig/telemetry) that **ignores `ANTHROPIC_BASE_URL` and hits the REAL
internet.** It returns 200 and its body is fully read under BOTH host node and
tjs, so it is NOT the round-trip differentiator — but it means the offline path
is not strictly hermetic w.r.t. that one telemetry call.

---

## Walls hit + fixes (the M3 wall-walk)

`--version` (M2) was a clean early-exit. `-p` drives the full async pipeline:
context spawns, session/message loading, system-prompt assembly, the Messages
`fetch` + SSE read. The boot HUNG silently; the METHOD was: boot with
`CLODE_SHIM_TRACE`/`ya`-marker/`Ie`-error instrumentation, compare the marker
sequence against the host-node oracle, localize the exact divergent primitive,
fix it test-first against host node, repeat. Seven walls, in the order the boot
hit them:

1. **`setTimeout(...).unref()` — timer handles** (commit `a8e485a`).
   txiki `setTimeout`/`setInterval` return a bare **number**; the bundle
   pervasively uses the Node idiom `setTimeout(...).unref()` (its DataDog
   flush timer `w1m`, ×54 in one trace), which throws `TypeError: not a
   function`. Loader now returns a Node-shaped Timeout/Immediate handle
   (`ref`/`unref`/`hasRef`/`refresh` + `Symbol.toPrimitive`→id); `clearTimeout`/
   `clearInterval` accept the handle or a raw number.
   Test: `test/node-shim-timers-handle.test.cjs`.
   DIVERGENCE: `ref`/`unref` do NOT change loop liveness (txiki exposes no
   per-timer ref control) — no-ops returning the handle; `hasRef` tracks the
   last call.

2. **`process.exitCode` default** (commit `a460330`).
   The shim defaulted it to `0`; Node's default is `undefined`. The bundle
   guards `if (process.exitCode !== undefined) { /* graceful shutdown */ return }`
   right after startup — a `0` default fired it and **silently returned the -p
   action before the Messages POST** (the single largest blocker: no error, just
   an early return that let commander settle). Changed to `undefined`; `exit()`
   already falls back through `?? 0`.
   Test: `test/node-shim-core.test.cjs` (process.exitCode row).

3. **`events.setMaxListeners` (module-level)** (commit `a460330`).
   Only the EventEmitter *instance* method existed. The bundle's
   AbortController helper (`Jl`) calls the **module-level**
   `require('events').setMaxListeners(n, abortSignal)` (Node 15+) → `TypeError:
   not a function` → crashed session loading (`Stu`) before the round-trip.
   Added module-level `setMaxListeners`/`getMaxListeners` (accepts EventEmitters
   and EventTarget/AbortSignal).
   Test: `test/node-shim-core.test.cjs` (events.setMaxListeners row).

4. **`stream` `.destroy()`** (commit `f5eddfe`).
   The bundle's execa-style get-stream cleanup (`Q2n`) calls `stream.destroy()`
   on consumed/child streams → `TypeError: not a function`. Added `destroy(err)`
   (marks `destroyed`, emits `'close'`, idempotent) to Readable/Writable, plus
   `.destroy()` on the child_process stdout/stderr wrappers.
   Test: `test/node-shim-stream.test.cjs`, `test/node-shim-child-process.test.cjs`.

5. **`child_process` `shell:true`** (commit `f5eddfe`).
   The bundle spawns single command STRINGS with `{shell:true}` — `ps aux |
   grep …` (IDE detection) and the `"…/run-hook.cmd" session-start` hook. The
   shim ENOENT'd on a literal `"ps … | grep …"` path. Now routes through
   `/bin/sh -c "<command>"` like Node.
   Test: `test/node-shim-child-process.test.cjs` (shell row).

6. **`fs.watchFile`/`unwatchFile`/`watch`** (commit `f5eddfe`).
   The bundle installs a config-file watcher at startup (`mLt`) →
   `TypeError: not a function`. Added the three functions with node-shaped
   handles.
   Test: `test/node-shim-fs-watch.test.cjs`.
   DIVERGENCE: they register but never FIRE change events (this tjs build has no
   wired fs-watch) — fine for a one-shot `-p` (config is read once at startup).

7. **`os.release`/`version`/`hostname`/`networkInterfaces`/`endianness`/`machine`**
   (commit `f5eddfe`).
   The system prompt's environment block does `os.type() + ' ' + os.release()`
   (`j_o`); missing `os.release` threw and **crashed the query session**
   (surfaced as an `error_during_execution` result) before the Messages POST.
   Added the missing os surface.
   Test: `test/node-shim-path.test.cjs` (os.release/hostname row).
   DIVERGENCE: `release()`/`version()` return `''` — this tjs build exposes no
   uname/kernel-release API (`tjs.system` has cpus/loadAvg/networkInterfaces/
   uptime/userInfo only). It is an informational system-prompt suffix only.

### Non-walls confirmed during the walk (recorded, not fixed)

- **`child_process` IS exercised** and works: `security` (Keychain), `git`,
  `ps`, and the `shell:true` context spawns all launch and their `wait()`
  resolves; stream `'end'` fires. NOT a blocker.
- **`spawnSync` still walls loudly** (the `git ls-files` tracked-check). This
  tjs build has no synchronous event-loop pump reachable from JS (DIVERGENCE B
  in `child_process.cjs`), so `spawnSync` throws its branded wall. The bundle
  CATCHES it and proceeds — the `-p` round-trip does NOT depend on a working
  `spawnSync`. Left throwing (a real spawnSync via Worker+Atomics stays
  deferred).
- **No stack bump needed.** The 4MB `TJS__DEFAULT_STACK_SIZE` from M2 cleared
  the full `-p` pipeline; no `RangeError`. The worker-thread ~512KB C-stack
  caveat was therefore not re-triggered (the round-trip is main-thread-only;
  `worker_threads` is unused).
- **`ws`/WebSocket NOT reached.** `-p` is HTTP+SSE; no WebSocket USE occurred.
- **native `fetch` + SSE read** works under tjs unmodified (no `net`/`tls`/
  `http`/`https` module wall on the plain-http path).

---

## Rung B — LIVE finale

**Awaiting a key-holder run.** Task 5's gated finale (`CLODE_LIVE_ROUNDTRIP=1`
+ real `ANTHROPIC_API_KEY` against `api.anthropic.com`) was intentionally not
run here (no key; the entire wall-walk used the mock per the plan). The finale
harness (`test/node-shim-roundtrip.test.cjs` + `scripts/m3-live-roundtrip.sh`)
is the remaining Task-5 deliverable. Paste the finale transcript + timing here
when run — no key, no headers, timing + visible response only.

---

## Divergences (each with a characterization test)

- **Timer `ref`/`unref` are no-ops** (loop-liveness not modeled) — timers-handle test.
- **`fs.watchFile`/`watch` register but never fire** — fs-watch test.
- **`os.release()`/`version()` return `''`** (no uname API) — path test.
- **`stream.destroy()` is the observable destroyed/`'close'` contract only**
  (no underlying-resource abort) — stream test.
- **`child_process.spawnSync` walls** (no sync loop pump; carried from M2) —
  child-process test.
- Carried, unchanged: `stream` flowing-mode subset, `vm` global-context,
  `require.main` synthesized (M2 evidence).

---

## Suite tally

`node --test test/node-shim-*.test.cjs` (with tjs) → **79 tests, 77 pass, 0
fail, 2 skip** (the 2 skips are the pre-existing provider-bin-gated
extractor/oracle rows; they PASS when `CLODE_PROVIDER_BIN` is set). All 7 new
M3 characterization rows are green. No regression: `--version` still prints
`2.1.202 (Claude Code)`, exit 0.

Note: `test/websocket.test.cjs`'s `require("ws")` fail-loud row is **red on
clean HEAD 38f13a3 as well** (verified by stashing all M3 changes) — a
pre-existing failure, NOT introduced by M3.

---

## M4 gates (surfaced, not fixed)

- Build the patched tjs in the NetBSD/aarch64 guest (pkgsrc gcc12+; the
  `js_exepath` NetBSD patch already relevant).
- `navigator.platform`/arch derivation in the guest (the hardcoded `arm64` in
  `modules/process.cjs`, and `os.arch`/`os.machine`).
- darwin-specific paths in `child_process`/spawn (`/bin/sh`, `/bin/echo`) and
  the shell-string `shell:true` path.
- A real `os.release()`/`uname` primitive (currently `''`) — a guest that
  needs it, or any path that parses the OS version, re-opens this wall.
- Worker-thread C-stack caveat stays dormant (no stack bump landed;
  main-thread-only). Revisit only if a path needs `worker_threads` or a
  deeper stack.

## Phase-3 gates

- TUI/raw-mode/Ink (`createRoot`/`showSetupScreens` — the `-p` path SKIPS the
  interactive render block; the interactive path will need it).
- `ws`→WebSocket (untouched by `-p`).
- A real synchronous `child_process.spawnSync` (Worker+Atomics), if a path
  genuinely needs it.
- `Bun.Terminal`/PTY.
