# Phase 3 · API method-level coverage matrix — bundle vs the tjs node-shim

**Status (2026-07-08):** method-level inventory built, dynamic wall-traces run,
three faithful batches implemented and committed, all gates green. This document
is the ranked punch-list. It complements the runtime paint/fetch investigations
in `phase3-m1-tui-boot.md` (those own the remaining TUI stall + native fd-race;
this doc owns the *breadth* of the Node-API surface).

## Method

1. **Static, method-level.** `scratchpad/inventory/method-inventory.cjs` binds
   every local identifier the beautified bundle assigns from `require("<mod>")`
   (incl. `P(require(...))` ESM-interop wraps and `require("m").Member` forms),
   then tallies `<local>.<member>` accesses per module across all 753k lines of
   `scratchpad/deminify/cli.pretty.js`. Minified locals are reused across
   modules, so raw counts are **upper bounds** (over-count, never under-count) —
   the goal is to never MISS a required method.
2. **Noise filtered against the real host surface.** A member counts as a *real*
   gap only if **host node exposes it** on that module (`dump-host-surface.cjs`)
   AND **the shim does not** (`dump-shim-surface.cjs`, run under the tjs
   snapshot). This drops junk like `fs.push`/`fs.db` (reused local names) and
   keeps only genuine Node API names.
3. **Dynamic corroboration.** Both live paths were run under `CLODE_SHIM_TRACE=1`
   and every distinct `[wall] ns.prop` collected:
   - headless `-p 'say PONG'` against the local mock Anthropic
     (`scratchpad/inventory/wall-trace-p.cjs`): **exit 0, prints PONG, ZERO walls.**
   - interactive TUI via the node-pty harness
     (`scratchpad/inventory/wall-trace-tui.cjs`): startup runs, **ZERO walls**
     (the TUI paint stall is a *render-path* issue, not a missing-method wall —
     see `phase3-m1-tui-boot.md`).

   **Conclusion: the shim already covers every method the two exercised paths
   touch.** The static gaps below are therefore *proactive* — they de-risk
   commands/paths not exercised by `-p PONG` or TUI-startup (file writes via
   streams, http servers, crypto signing, readline prompts, etc.), so future
   paths stop discovering missing APIs one crash at a time.

## Module require-count (bundle, all forms)

| module | refs | | module | refs | | module | refs |
|---|---|---|---|---|---|---|---|
| path | 477 | | events | 18 | | dns | 5 |
| fs | 414 | | https | 16 | | timers | 5 |
| crypto | 186 | | assert | 13 | | module | 4 |
| os | 123 | | async_hooks | 12 | | querystring | 3 |
| util | 67 | | readline | 12 | | perf_hooks | 3 |
| child_process | 59 | | tls | 11 | | http2 | 7 |
| stream | 54 | | zlib | 11 | | string_decoder | 7 |
| url | 45 | | tty | 8 | | vm | 7 |
| net | 40 | | http | 24 | | v8 / inspector / constants / worker_threads | 1 each |
| process | 30 | | buffer | 28 | | | |

## Implemented this phase (3 commits, all with characterization tests)

Batch 1 (`17fe218`) — **three absent builtins the bundle requires + fs/util methods**
- **`assert`** (was wallProxy; 13 refs): `ok`/`equal`/`strictEqual`/`deepStrictEqual`
  (+ `not*`), `throws`/`doesNotThrow`/`rejects`/`doesNotReject`, `match`/`doesNotMatch`,
  `ifError`/`fail`, `AssertionError` (`code: ERR_ASSERTION`), `assert.strict`.
  Deep-eq via `util.isDeepStrictEqual`.
- **`querystring`** (was wallProxy; 3 refs): `parse`/`stringify`/`escape`/`unescape`
  (+ `encode`/`decode`), repeated-key arrays, `maxKeys`.
- **`string_decoder`** (was wallProxy; 7 refs): `StringDecoder` with multibyte
  boundary buffering over a streaming `TextDecoder` (utf8/utf16le) + latin1/ascii/
  hex/base64.
- **`fs`**: `appendFile(Sync)`, `writeSync`, `write`/`read` (cb), `rmSync`,
  `mkdtemp(Sync)`, `chmod`/`symlink` (async+promises), `link` (async via `tjs.link`),
  `fsync`/`fdatasync`/`fsyncSync`/`fdatasyncSync` (documented best-effort no-op — no
  sync flush primitive).
- **`util`**: `formatWithOptions`, `callbackify`, `stripVTControlCharacters`,
  `TextEncoder`/`TextDecoder` re-exports.

Batch 2 (`0b0723a`) — **url legacy + crypto + zlib constants**
- **`url`**: legacy `parse`/`format`/`resolve`/`domainToASCII` over WHATWG URL,
  full legacy Url field shape; host-locked for absolute/auth/relative/WHATWG inputs.
- **`crypto`**: `createHmac('sha256')` (RFC2104 over internal sha256),
  `timingSafeEqual`, `randomFillSync`, real host-identical `constants`, encoding-aware
  `createHash`. `getHashes()` **honestly** returns `['sha256']` (documented
  divergence — reports only what we implement so feature-detection never selects an
  algorithm we'd throw on).
- **`zlib`**: hoist the `Z_*`/`ZSTD_*`/mode-enum constants to the module top level
  (the exact set host exposes there — excludes `BROTLI_*`); throw-on-construct
  `Gzip`/`Inflate`/… classes so `typeof zlib.Inflate === 'function'` matches.

Batch 3 (this commit) — **stream.finished + this matrix**
- **`stream`**: top-level callback-form `finished(stream[, opts], cb)` (fires once,
  returns a cleanup fn); promises form already existed.

Tests: `node-shim-newmods`, `node-shim-fs-extra`, `node-shim-api-batch2`,
`node-shim-stream-finished`. Full shim gate **112 pass / 4 skip / 0 fail**;
headless `-p PONG` exit 0, zero walls.

## Ranked REMAINING gaps (not yet implemented — proactive, none dynamically hit)

Ranked by access-count × likelihood-of-being-load-bearing. **None** of these fire
on `-p PONG` or TUI-startup; each is a candidate for a future path.

### Tier A — needs-investigation (behaviorally subtle / needs native support; do NOT stub)
- **`crypto` asymmetric + KDF** — `pbkdf2Sync`(5)/`pbkdf2`(3), `createPrivateKey`(4)/
  `createPublicKey`(2), `createSign`(3)/`createVerify`(3)/`sign`(1),
  `X509Certificate`(4), `KeyObject`(1). No native OpenSSL in this tjs. `pbkdf2` is
  buildable over the internal sha256 (PBKDF2-HMAC-SHA256) IF a path needs it;
  signing/X509 need real asymmetric crypto → genuine native work. **Left as walls
  (fail-loud) — a wrong stub would silently corrupt security-sensitive output.**
- **`vm.runInContext`(17) / `createContext`(4)** — `vm` is a SEALED module with
  `Script`/`runInThisContext` only. True multi-context isolation needs a tjs
  primitive; `runInThisContext`-style aliasing would be a *divergent* context model.
  Characterize intended semantics before implementing.
- **`fs.truncate`(3)/`ftruncate`, `statfs`(1), `linkSync`(1), `fchmodSync`(1)** —
  no matching sync primitive in `__tjs_fs_sync` (only 17 sync ops; `tjs.statFs`/
  `tjs.link` are async-only). `truncate` grow/shrink needs a real ftruncate.
  `statfs` could wrap `tjs.statFs` (async) — shape needs verifying first.
- **`worker_threads.parentPort`(1)** — needs a real worker/message-port primitive;
  tjs Worker+Atomics is dead for sync ops (see memory `tjs-atomics-cant-block-main`).

### Tier B — faithful but non-trivial (moderate build; safe to implement when a path needs it)
- **`fs.createWriteStream`(13) / `createReadStream`(8) / `ReadStream`** — stream-back
  fd I/O over the existing `stream` Readable/Writable + FSS read/write. Faithful and
  high-value; deferred only for scope. `fstat`(1) is trivial (alias `fstatSync`
  cb-form).
- **`stream.Duplex`(6)** — a Readable+Writable base. The existing `Transform`
  already models the Readable+writable-face pattern; a `Duplex` base in the same
  spirit is doable but its full-duplex ordering needs characterization vs host
  (deps subclass it, e.g. `net.Socket`). Implement with a node-vs-tjs test, not by
  guessing.
- **`http`/`https` `.request`(10/8) + `createServer`(6/1), `net.createServer`(9),
  `http.IncomingMessage`** — client `request` and server `createServer`. The app's
  real API traffic goes through `fetch` (covered), so these back deps/local servers
  (e.g. OAuth loopback, MCP stdio-over-http). `net.createServer` needs a tjs listen
  primitive; verify one exists before building.
- **`child_process.fork`(1) / `ChildProcess`(2)** — `fork` is `spawn` of node with an
  IPC channel; IPC needs a message primitive. Low ref-count.
- **`readline.createInterface`(12)** — interactive line editor. The TUI uses Ink, not
  readline, so these are likely the non-interactive `readline` used to read a stream
  line-by-line (e.g. parsing a child's stdout). A minimal `createInterface` over an
  input stream emitting `'line'` is faithful and worth doing when a path needs it.
- **`perf_hooks.monitorEventLoopDelay`(1)** — a histogram over loop-delay sampling;
  low value, feature-detected.

## Artifacts
- Inventory tooling + data: `scratchpad/inventory/` — `method-inventory.cjs`,
  `method-inventory.json`, `dump-{shim,host}-surface.cjs`, `shim-surface*.json`,
  `host-surface.json`, `wall-trace-{p,tui}.cjs`, `PROGRESS.md`.
- Shim modules touched: `libexec/node-shim/modules/{assert,querystring,string_decoder,
  fs,util,url,crypto,zlib,stream}.cjs`.
- Tests: `test/node-shim-{newmods,fs-extra,api-batch2,stream-finished}.test.cjs`.
