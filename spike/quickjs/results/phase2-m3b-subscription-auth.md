# Phase 2 · M3b — live SUBSCRIPTION round-trip under tjs: walls, fixes, and the one remaining native bug

**Status (2026-07-07): NOT yet reaching a live `PONG` via subscription.** The entire
subscription-auth chain now works under the patched tjs **except one native
libuv/tjs bug** (Wall #1 below). Everything else that blocked it is fixed and
committed. This doc is the handoff for closing Wall #1.

**Goal:** `CLODE_ENGINE=tjs`-style boot of the real Claude Code bundle, authenticated
by the macOS **subscription** (Keychain/OAuth, NO `ANTHROPIC_API_KEY`), completing a
non-interactive `-p 'say PONG'` round-trip against `api.anthropic.com`.

**Why subscription and not API key:** this dev box has no API key; it authenticates via
a Pro/Max OAuth credential in the login Keychain (`security find-generic-password -s
"Claude Code-credentials"`). The API-key path bypasses the Keychain entirely and was the
plan's original gated finale; the subscription path is what a real user of clode-under-tjs
hits, and it exercises far more of the shim (sync+async spawn, execa, real fetch).

---

## The decisive oracle (use this to know when Wall #1 is closed)

**Host node** running the SAME staged bundle prints `PONG`; **tjs** does not (yet).
This differentiator is the ground truth — the bundle logic, bun-shim, and the
subscription flow are all correct; only tjs-side plumbing differs.

```bash
export CLODE_PROVIDER_BIN="$HOME/.local/share/claude/versions/2.1.202"
SCRATCH=$(mktemp -d)
node libexec/extract-claude-js.cjs "$CLODE_PROVIDER_BIN" "$SCRATCH/cli.cjs"
cp libexec/bun-shim.cjs "$SCRATCH/bun-shim.cjs"

# HOST NODE ORACLE — always prints "PONG", exit 0 (reference):
env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL NODE_PATH="$PWD/node_modules" \
  ~/.local/bin/timeout 90 node "$SCRATCH/cli.cjs" -p 'say PONG' < /dev/null

# TJS — currently prints "Not logged in · Please run /login" on MOST runs
# (Wall #1); the target is a reliable "PONG":
env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL NODE_PATH="$PWD/node_modules" \
  ~/.local/bin/timeout 90 build/tjs/tjs run libexec/node-shim/loader.cjs \
  "$SCRATCH/cli.cjs" -p 'say PONG' < /dev/null
```
Add `CLODE_SHIM_TRACE=1` to see the child-process spawn burst and the failing
`security` read. (No `timeout` on macOS — use `~/.local/bin/timeout`.)

**Acceptance for Wall #1:** the tjs boot prints `PONG`, exit 0, reliably (≈10/10 runs).

---

## What's already fixed (committed on `main`)

The auth chain was blocked by a *series* of walls; each was root-caused and fixed. In
boot order:

1. **Sync keychain read walled (`spawnSync`).** The bundle's synchronous keychain
   reader hit the shim's `spawnSync` wall (no sync loop pump; Worker+Atomics ruled out —
   `Atomics.wait` can't block the tjs main thread). **Fixed** with a C primitive
   `__tjs_spawn_sync` (`posix_spawn`+`poll`), mirroring `__tjs_fs_sync`:
   - `spike/quickjs/patches/txiki-sync-spawn.patch` (commits `0f71eb5`, `44e89db`)
   - shim `spawnSync`/`execSync`/`execFileSync` over it: `d14ee29`
   - upstream doc: `6cbc935`
   - **Note:** this was real+valuable but turned out NOT to be the actual auth blocker
     (the async keychain read is the gate). Lesson: end-to-end verify the fix resolves
     the *symptom* before building a milestone on a hypothesis.

2. **Async `child.stdout`/`.stderr` weren't collectable by execa.** The bundle's async
   keychain read (`F1 → Tl().readAsync → xbs → Or("security") → execa`) collects stdout
   via get-stream, which **requires `[Symbol.asyncIterator]`** — the old bare-EventEmitter
   `wrapReadable` had none (nor `.pipe()`), so execa never started and the read returned
   null → "Not logged in". **Fixed**: `child.stdout`/`.stderr` are now real `stream.cjs`
   `Readable`s (async-iterator + pipe + buffer-until-consumed). Commit **`7ce7a89`**
   (`libexec/node-shim/modules/{child_process,stream}.cjs` + 3 TDD rows). Isolated
   Keychain read now byte-identical to host node; suite 90/91.

3. **libwebsockets sent an unconditional `Origin` header → API CORS 401.** Once auth
   succeeded, the real POST to `api.anthropic.com` was rejected with 401 "CORS requests
   are not allowed for this Organization". Traced to `httpclient.c:721`
   (`cci.origin = uri->host`), set on every `fetch()`; not suppressible from JS.
   **Fixed**: `spike/quickjs/patches/txiki-no-origin-header.patch` sets `cci.origin = NULL`
   for the generic HTTP client (WebSocket handshakes use a different path). Commit
   **`738b631`**. Verified via httpbin.org/headers: no `Origin` after the patch.

The four committed txiki patches (build via `node scripts/build-tjs.mjs`): `txiki-sync-fs`
(pre-existing), `txiki-default-stack-size` (pre-existing), `txiki-sync-spawn`,
`txiki-no-origin-header`. All reverse- and forward-apply clean.

---

## Wall #1 (REMAINING): a native libuv/tjs fd-race under concurrent spawn

**Symptom.** Under the bundle's startup burst of ~8–10 **concurrent** child spawns
(git ×~4, ps, rg ×~3, the IDE-detection `ps aux | grep`, the session-start hook), a
*later* `security find-generic-password` spawn's stdout stream fires an **immediate
zero-byte EOF** — the very first `reader.read()` returns `{done:true, 0 bytes}` *before*
the child's real `exit` (which arrives tens of ms later with the real 471 bytes / exit 0).
The two **early** `security` spawns (at boot, before the burst) read correctly. A sibling
spawn in the same burst (`/bin/sh -c "ps aux | grep …"`) was independently observed to
exit with **signal 141 (SIGPIPE)**.

Because the bundle's `xbs()` calls execa with `preserveOutputOnError:false`, that
spurious empty/early-closed stream trips execa's internal `Promise.all([exit,stdout,…])`,
execa flags the child `.failed`, and `$n()` **discards whatever was read and returns
code=1** — so "code=1, empty stdout" is a *consequence* of the spurious EOF, not a
separate bug. Result: the credential read fails → the composite store returns `{}` → no
`claudeAiOauth.accessToken` → "Not logged in".

**Root cause (traced to source).** The premature end is `handle.onread(data === null) →
controller.close()` in `src/js/core/stdio.js` (`StdioReadableStream`/`ProcessReadableStream`,
the non-`file` branch) — i.e. **libuv delivers a spurious `UV_EOF`** on the child's stdout
pipe. The stdout pipe is a per-child `new core.Pipe()` created in `src/js/core/process.js`
`spawn()` (the `opts.stdout === 'pipe'` branch), wired into `uv_spawn` via
`UV_CREATE_PIPE | UV_WRITABLE_PIPE` in `src/mod_process.c` (stdio setup ~lines 343–380,
`uv_spawn` ~line 396). The premature-EOF + sibling-SIGPIPE pair is the textbook signature
of an **fd-inheritance leak across concurrent `uv_spawn` calls**: one child's stdout
write-end leaks into another child, so when the parent closes a read-end the *wrong* child
sees EOF (or SIGPIPE). It only manifests under the real burst's specific spawn/timing mix.

**Assessment: this is native (libuv/tjs), not shim-fixable.** The JS shim cannot prevent
libuv from delivering a spurious `UV_EOF`, and `tjs.spawn` exposes no non-pipe output
capture (only `pipe`/`inherit`/`ignore` — see `mod_process.c`), so there's no clean
JS-level dodge.

### What was tried and did NOT work (don't repeat)
- **Throttling concurrently-ACTIVE `reader.read()` to 1** (semaphore around the drain
  loop): no change — same immediate-empty-read signature. So it's not "too many active
  reads".
- **Throttling concurrently-LIVE spawned children (1–4)**: helped in *one* run (got the
  boot all the way to the CORS 401, proving the credential-read half is sound) but was
  **unreliable** (1/2/3/4 all failed most runs) AND reintroduced the `destroy()` SIGSEGV
  (see below). Reverted.
- **Synthetic reproduction**: concurrent `/bin/echo` up to 40-way, mixed `git`/`ps`/`sh`/
  `find` + concurrent `fetch`, sequential churn up to 40 spawns — **none reproduced it**.
  The trigger needs the bundle's exact spawn/stdio mixture (pipe + inherit + ignore,
  spawns firing during active reads of other pipes).

### Candidate fixes (for the fresh native session)
1. **Audit `core.Pipe` fd creation + `uv_spawn` stdio wiring** (`src/mod_process.c`,
   `src/mod_streams.c`/wherever `core.Pipe` lives) for a **CLOEXEC / fd-ordering window**
   when spawns fire back-to-back before prior pipes are fully read. libuv normally guards
   inheritance with CLOEXEC; check whether tjs creates the pipe fds without CLOEXEC before
   `uv_spawn` dups them, or reuses/frees a `uv_pipe_t` across spawns. Likely a small tjs
   patch (set CLOEXEC on the pipe fds, or fix ordering) — and an **upstream txiki.js
   candidate**. Check the pinned libuv version's known spawn/pipe fd-race issues too.
2. **Tighten the repro first** (cheap, high-value): mimic the bundle's exact stdio mix —
   spawn several children with `{stdout:'pipe', stderr:'pipe', stdin:'ignore'}` while
   *actively reading* another child's pipe, interleaving pipe/inherit/ignore. If a
   synthetic repro is found, bisecting the native fix becomes tractable.
3. **Fallback (also native):** patch `tjs.spawn` to support file-redirect stdio
   (`stdout` → a temp-file fd), then have the shim's async `spawn()` capture output via a
   temp file instead of a pipe, sidestepping the pipe race. Larger change; only if (1) is
   intractable.

---

## Secondary finding worth flagging: a tjs `destroy()` SIGSEGV

Adding the single line `this.readable = false;` **inside `Readable.destroy()`** in the
shim's `libexec/node-shim/modules/stream.cjs` **deterministically SIGSEGVs (exit 139) /
SIGBUSes (138) the pinned tjs build**, independent of logic, sensitive to unrelated
code/comment changes in the same file (bisected blind; lldb changes timing enough to mask
it). The identical assignment in
`push(null)` is safe; only `destroy()`'s copy crashes. Worked around by NOT flipping
`readable` in `destroy()` (consumers gate on `.destroyed`/`'close'`, not `.readable`) —
documented inline in `stream.cjs`. This is real codegen/heap-layout fragility in the
pinned quickjs-ng/tjs build and can bite future shim work in non-obvious ways; worth a
native look and an upstream report.

---

## Pointers
- Shim fixes: `libexec/node-shim/modules/child_process.cjs`, `…/stream.cjs`;
  characterization rows in `test/node-shim-child-process.test.cjs`.
- Patches + provenance: `spike/quickjs/patches/txiki-*.patch`, `spike/quickjs/PINS.md`.
- Running log with per-step detail: `.superpowers/sdd/progress.md` (+ `task4b-report.md`)
  — gitignored scratch, present on the dev box.
- Prior milestone evidence: `spike/quickjs/results/phase2-m3-roundtrip.md` (offline mock
  round-trip, PONG under tjs).
- Provider binary: `~/.local/share/claude/versions/2.1.202` (darwin-arm64, 2.1.202).
