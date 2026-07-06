# Gate 2 — gap matrix (Node surface × txiki.js / bare quickjs-ng)

Classifications: `provided` / `shimmable-JS` / `needs-C` / `hard`.
Every claim cites txiki source (`spike/quickjs/vendor/txiki.js`, pinned at
`1a230d3`, tag v26.6.0), its `website/docs/`, or the darwin-arm64 probe
(`gate2-probe-darwin-arm64.md`). Ref counts are copied verbatim from
`gate2-inventory.json` (generated 2026-07-06 against bundle
`cli.cjs@2.1.198`).

## Gate verdict — no re-plan trigger

**No row below is `hard` with no plausible path.** The three
life-or-death scrutiny rows (tty raw+winsize+SIGWINCH, child
spawn+inherit+signals, fetch TLS proxy/custom-CA) are all **`provided`**
by txiki natively — this is the single biggest finding of this gate.
The worst finding is `inspector` (Node's V8 Inspector Protocol), which
is genuinely `hard` to replicate faithfully (no engine-level debug
protocol under quickjs-ng) — but it has exactly 1 bundle reference,
almost certainly a feature-detection guard, and degrades gracefully to
a stub/no-op. It is **not** an architectural blocker for the port and
does not stop the ladder. Everything else that is not natively
`provided` resolves to `shimmable-JS` (pure-JS wrapper over a primitive
txiki already exposes) or `needs-C` (a plausible, scoped native-binding
addition — e.g. extending `mod_fs.c`'s two existing `*Sync` functions,
or flipping an already-vendored build flag like `LWS_WITH_HTTP_BROTLI`).

## Methodology caveat

The inventory scanner (Task 4) only catches `require()`, import-from,
dynamic `import()`, and `?.`-chained globals; it **misses
backtick-quoted requires** (an obfuscation/lazy-load pattern that is
npm-only today, i.e. absent from the current bundle but not guaranteed
absent from future versions), **non-literal dynamic imports** (e.g.
`import(someVariable)`), and its `BUILTINS` list **omits
`node:test` and `node:sqlite`** (both zero-ref today, but if the CLI
ever grows a test runner or embedded-DB dependency this matrix will
need re-running). Ref counts below should be read as a lower bound.

## Modules

| Node API | kind | toolchain refs | bundle refs | txiki has | class | evidence |
|---|---|---|---|---|---|---|
| **fs (sync variants!)** | module | 15 | 452 | Every public `tjs.*` fs op (`readFile`, `stat`, `mkdir`, `readDir`, `copyFile`, `unlink`, `rename`, `symlink`, …) is Promise-returning; there is no public sync fs surface. | needs-C | `src/js/core/index.js:48-57` exports only the async names. `src/mod_fs.c:1695` labels `mkdirSync`/`statSync` `/* Internal */` (lines 1696-1697) — two sync primitives exist at the C layer already but are deliberately not exposed to JS. Extending this internal set to cover `readFileSync`/`writeFileSync`/`existsSync`/`readdirSync` is a scoped native-binding job (libuv has sync variants for all of these), not an engine limitation — hence `needs-C`, not `hard`. A CLI that does synchronous startup I/O (reading config/package.json before the event loop is even relevant) will stall on this until it's built. |
| **child_process spawn+inherit+signals** | module | 13 | 61 | `tjs.spawn()` defaults to inheriting all three std streams, supports `"pipe"`/`"ignore"` per-stream, and reports `{ exit_status, term_signal }`; `proc.kill(sig)` and `tjs.kill(pid, sig)` accept named POSIX signals (`SIGTERM` default, `SIGKILL`, etc.). | provided | Default inherit: `src/mod_process.c:164-171` (`UV_INHERIT_FD` on fds 0/1/2). Per-stream pipe/inherit/ignore: `src/mod_process.c:323-374`. Kill by name: `src/mod_process.c:88-105` (`tjs_process_kill`) and `:503-520` (`tjs_kill`); signal-name→number table in `src/utils.c` (`tjs_getsig`/`tjs_getsignum`). Exit reporting: `src/mod_process.c:121-129` (`uv__exit_cb`, `term_signal`). Confirmed live: probe `exercise.spawn OK {"exit_status":0,"term_signal":null}` under tjs. `AsyncDisposable` auto-SIGTERM-on-scope-exit: `website/docs/guides/child-processes.md` ("Automatic cleanup"). The Node-shaped `ChildProcess` (EventEmitter, `.stdio` array, `execSync`/shell parsing) is not literally present — that's a JS wrapper over an already-complete native primitive, which is why the *module* row below is scored `shimmable-JS` rather than `provided`; the underlying capability this scrutiny row exists to check is unconditionally there. |
| **tty raw mode + winsize + SIGWINCH** | (fs/tty/process composite) | — | 8 (tty) | `stream.setRawMode(bool)` toggles `TTY_MODE_RAW`/`TTY_MODE_NORMAL`; `stream.width`/`.height` read `getWinSize()`; `SIGWINCH` is a named, listenable signal. | provided | Raw mode: `src/js/core/stdio.js:110-118` (`setRawMode`) calling `core.TTY`'s native mode setter; probe confirms `exercise.tty-raw OK tjs.stdin.setRawMode` (tjs) vs `ABSENT process.stdin.setRawMode` under bare Node control and `ABSENT no tty API found` under qjs. Winsize: `src/mod_streams.c:800` (`tjs_tty_getWinSize`), exposed as `.width`/`.height` getters in `src/js/core/stdio.js:196-210`. SIGWINCH: registered in the signal-name table at `src/utils.c:361-362` (`#ifdef SIGWINCH … [SIGWINCH] = "SIGWINCH"`), wired through the generic `tjs.addSignalListener('SIGWINCH', fn)` path in `src/js/core/signal.js:20-33`. All three legs (mode, size, resize notification) that a TUI needs are present with no native-binding gap. |
| **fetch TLS (proxy, custom CA)** | (fetch/net/tls composite) | — | 11 (tls) | Outbound `fetch`/`XMLHttpRequest`/`WebSocket`/HTTP-import traffic transparently honors `http_proxy`/`https_proxy`/`all_proxy`/`no_proxy` (with SOCKS5 and embedded-credential `Proxy-Authorization`); TLS CA trust is configurable process-wide via `--tls-ca`/`TJS_CA_BUNDLE`/`SSL_CERT_FILE`, and per-socket via a `ca` option on raw TLS connections. | provided | Proxy env-var parsing and per-scheme vhost routing: `src/lws-utils.c:196-679` (`tjs__parse_proxy_url`, `tjs__create_client_vhost`, `no_proxy` matching); documented end-to-end in `website/docs/guides/http-proxy.md` ("txiki.js automatically reads standard proxy environment variables… applies to `fetch()`, `XMLHttpRequest`, `WebSocket`, and HTTP module imports"). CA bundle precedence: `src/js/run-main/index.js:32-36` (`--tls-ca > TJS_CA_BUNDLE > SSL_CERT_FILE > embedded bundle`), documented in `website/docs/cli.md:161-163`. Per-socket custom CA for raw sockets: `src/mod_tls.c:1015-1027` (`ca` option → `mbedtls_x509_crt_parse` → `mbedtls_ssl_conf_ca_chain`). This is the second major finding of this gate: clode's proxy-heavy fetch usage (`fetch` 44 refs, `https`/`tls` 29 combined refs in the bundle) is not a gap at all. Caveat: no HTTP CONNECT-tunnel *inspection*/MITM story is needed since the underlying stack is mbedtls + libwebsockets (not curl), and there is no `NODE_EXTRA_CA_CERTS`-style *additive* CA (txiki's CA config *replaces* the embedded Mozilla bundle rather than appending to it) — a shimmable-JS concat-then-`--tls-ca` step would be needed if the bundle relies on additive trust. |
| assert | module | — | 13 | `tjs:assert` exists but with a different (`assert.eq`-style) API, not Node's `assert(value)`/`.strictEqual`/`.deepEqual`. | shimmable-JS | `website/docs/features/standard-library.md` lists `tjs:assert` ("Assertion functions for testing") with a distinct shape. Node's own `assert` module is pure comparison-and-throw logic with no native dependency — trivial to reimplement from scratch in JS rather than adapt. |
| async_hooks | module | — | 12 | Not present in any form (no context-propagation primitive, no async-resource lifecycle hooks). | shimmable-JS | No hits for `async_hooks`/`AsyncLocalStorage`/`AsyncResource` anywhere in `src/js/` or `website/docs/`. A `AsyncLocalStorage`-only subset (the overwhelmingly common real-world use of this module, e.g. per-request context) is buildable in pure JS via `WeakMap`s and explicit `run()`/`getStore()` wrapping without engine hooks — that covers the likely 12 refs. Full `async_hooks` fidelity (init/before/after/destroy tied to *every* async resource, matching V8's instrumentation) is not achievable without engine-level hooks quickjs-ng doesn't expose, so treat full-fidelity as an unshippable stretch goal, not the baseline claim. |
| buffer | module | — | 29 | No `Buffer` class or `node:buffer` module. | shimmable-JS | `grep` for `Buffer`/`class Buffer` across `src/js/` and `web-platform-apis.md`'s API table returns nothing. This is the same gap browsers have always had; the standard fix (a `Uint8Array` subclass replicating Node's `Buffer` API, à la the `feross/buffer` npm package) is pure JS with zero native dependency and is a well-worn path. |
| console | module | — | 1 | Full `Console` Web API including `table`, `group`/`groupEnd`, `count`/`countReset`, `time`/`timeEnd`, `assert`. | provided | `src/js/polyfills/console.js:38` (`consoleObj.assert`), `:61` (`table`), `:214-247` (`count`/`group`/`time` family). Listed in `website/docs/features/web-platform-apis.md` ("Console"). Minor Node-only formatting details (`%o`/`%O` inspect-depth nuances) would need a thin `util.inspect`-backed wrapper, not a new capability. |
| constants | module | — | 1 | No aggregated `constants` module, but the underlying raw values (`TTY_MODE_RAW`/`TTY_MODE_NORMAL`, `FS_SYMLINK_DIR`/`FS_SYMLINK_JUNCTION`, `STDIN_FILENO`, signal numbers) already exist as native constants on other objects. | shimmable-JS | `src/mod_streams.c:1027-1028` (`TJS_UVCONST(TTY_MODE_NORMAL/RAW)`), `src/mod_fs.c:1671-1672` (`TJS_UVCONST(FS_SYMLINK_DIR/JUNCTION)`). Node's `constants` module is itself just a values-bag re-export; assembling one from txiki's existing native constants is pure JS. |
| crypto | module | 1 | 191 | `tjs:hashing` provides native MD5/SHA-1/224/256/384/512/512-224/512-256 and all four SHA-3 variants; the global `crypto.subtle` implements all twelve `SubtleCrypto` methods (digest, encrypt/decrypt, sign/verify, generateKey, deriveBits/Key, import/exportKey, wrap/unwrapKey) across AES-CBC/CTR/GCM/KW, RSA-OAEP, RSASSA-PKCS1-v1_5/PSS, ECDSA, Ed25519, ECDH, X25519, PBKDF2, HKDF. | shimmable-JS | `src/js/stdlib/hashing.js:5-16` (`supportedHashes` map) + `src/mod_hashing.c:37-60` (mbedtls-backed digest sizes). Web Crypto table: `website/docs/features/web-platform-apis.md` ("Web Crypto (SubtleCrypto)" section, full algorithm table). Node's `crypto.createHash('sha256').update(x).digest('hex')` surface is a thin synchronous-looking JS wrapper over `tjs:hashing`'s already-synchronous `Hash` class (`src/js/stdlib/hashing.js:19-53`) — no native gap. Node-specific low-level APIs with no WebCrypto equivalent (classic `DiffieHellman` custom-group support, `X509Certificate` object introspection, `createCipheriv` with Node's exact opaque-IV/auth-tag streaming semantics) would need custom JS shims on top of the same mbedtls primitives, still no new native surface — hence `shimmable-JS` overall, not `needs-C`. |
| dns | module | — | 5 | `tjs.lookup()`/`core.getaddrinfo` covers `dns.lookup()`; there is no resolver-protocol implementation (`dns.resolve4`, custom nameservers). | shimmable-JS | `src/js/core/lookup.js:3-25` (`lookup()` wraps `core.getaddrinfo`). No `resolve`/`nameserver` hits anywhere in `src/`. `dns.resolve*` needs raw DNS-packet construction/parsing over UDP — doable entirely in JS (as npm's pure-JS `dns-packet` does) using the already-native `UDPSocket` (`src/js/core/direct-sockets/udp.js`), so no new C surface, just protocol-level JS work. |
| events | module | — | 17 | No `EventEmitter`; `EventTarget`/`CustomEvent` (Web Platform) are present instead. | shimmable-JS | `web-platform-apis.md` lists `EventTarget` as supported; `event-target.js`/`event-target-polyfill.js` implement it. Node's own `events` module is pure JS in Node itself (no V8-internal dependency) — a compatible `EventEmitter` is a standard, well-tested shim (e.g. the `events` npm package used in every browser bundle today). |
| http | module | — | 27 | No `http.request`/`http.createServer`; instead `fetch`/`Response`/`Request` (client) and `tjs.serve()` (a `Deno.serve`-shaped fetch-handler HTTP/HTTPS+WebSocket server, honoring the same proxy env vars). | shimmable-JS | `website/docs/guides/serve.md` ("txiki.js includes a high-performance HTTP/HTTPS server… module that default-exports a `fetch` handler"); `src/js/core/httpserver.js:12` (`Server` class). Building Node's callback/EventEmitter-shaped `http.request`/`http.IncomingMessage`/`ServerResponse` API on top of `fetch`+`tjs.serve()` is a JS adaptation layer over a fully native, already-proxy-aware transport — no missing native primitive. |
| http2 | module | — | 7 | Not present; the vendored libwebsockets is built with HTTP/2 explicitly disabled. | needs-C | `CMakeLists.txt:391` (`set(LWS_WITH_HTTP2 OFF CACHE BOOL "" FORCE)`). lws itself supports h2 (it's a compile-time flag, not a missing dependency), so this is a rebuild-and-rewire job, not an architectural gap — `needs-C`, scoped to flipping the flag and exposing an h2 client API from JS. |
| https | module | — | 18 | Same transport as `http` (fetch/serve), TLS-terminated via mbedtls; same proxy/CA story as the fetch-TLS scrutiny row above. | shimmable-JS | See fetch-TLS row evidence (`src/lws-utils.c`, `src/mod_tls.c:1015-1027`, `website/docs/guides/http-proxy.md`). Node's `https.request`/`https.Agent` shape needs the same JS adaptation as `http`, not new native transport work. |
| inspector | module | — | 1 | No debug-protocol / V8 Inspector Protocol equivalent exists or is documented anywhere in txiki. | hard (non-blocking) | No `inspector` hits in `src/js/`, `website/docs/`, or the mod_*.c sources. This is genuinely `hard`: a faithful Chrome DevTools Protocol server requires engine-level debugger hooks quickjs-ng does not expose in the way V8 does. It does **not** trigger the gate's re-plan condition: 1 reference in an 18.4MB bundle is almost certainly a `require('inspector')` guarded by a try/catch or a `--inspect`-flag check, and a stub module (throwing, or exposing a no-op `Session`) is a legitimate, low-risk degradation — the CLI's core TUI/spawn/fetch functionality does not depend on it. |
| module (createRequire) | module | 5 | 4 | No CommonJS `require`/`module`/`exports`; txiki is ESM-only (import maps, HTTP imports, import-attribute JSON/text/bytes loading), and there is no `vm`-level context to build `createRequire` on top of without also solving the `vm` gap below. | shimmable-JS | `website/docs/guides/modules.md`: "txiki.js uses standard ES modules… Import maps let you remap specifiers." No `require(`/`CommonJS`/`cjs` hits in `website/docs/`. Given clode's bundle is a single pre-bundled `cli.cjs` file (not a `node_modules` resolution problem), a minimal CJS-loader shim — read the file, wrap in `(function(module,exports,require,__dirname,__filename){...})`, evaluate with `new Function(...)`, and resolve the handful of `require()` targets actually used (mostly the Node builtins already being shimmed elsewhere in this matrix) — is standard, pure-JS bundler-output technique (this is what most CJS-in-browser shims do) and does not require a native `vm` context. |
| net | module | 1 | 39 | No `net.Socket`/`net.Server`; `TCPSocket`/`TCPServerSocket` (WHATWG Direct Sockets shape) exist natively. | shimmable-JS | `src/js/core/direct-sockets/tcp.js`; `website/docs/features/web-platform-apis.md` lists "Direct Sockets… TCP, TLS, UDP and Unix pipe sockets" with a link to `website/docs/guides/networking.md`. Node's EventEmitter/Duplex-stream-shaped `net.Socket` is a JS wrapper over the already-native, already-async TCP primitive — no new native surface needed. |
| os | module | 3 | 120 | Renamed/reshaped equivalents of every commonly-used `os.*` field exist under `tjs.system`/`tjs` core exports: `cpus`, `loadAvg`, `networkInterfaces`, `uptime`, `userInfo`, `homeDir`, `hostName`, `tmpDir`, plus `core.platform`. | shimmable-JS | `src/js/core/system.js:5-33` (`cpus`→`core.cpuInfo`, `loadAvg`→`core.loadavg`, `networkInterfaces`, `uptime`, `userInfo`). `src/mod_os.c:501` (`homeDir`), `:536` (`hostName`), `:539` (`tmpDir`). `src/mod_sys.c:194` (`platform` string). A 1:1 naming shim (`os.cpus()` → `tjs.system.cpus`, etc.) is pure JS. |
| path | module | 16 | 508 | `tjs:path` is effectively a ported copy of Node's `path` module: exports both `posix` and `win32` objects with `join`/`resolve`/`normalize`/`relative`/`dirname`/`basename`/`extname`/`parse`/`format`, and a platform-default export. | provided | `src/js/core/path.js:169` (`win32` object), `:1102` (`posix` object), `:1556` (`export default platformIsWin32 ? win32 : posix`), `:1553-1554` (`posix.win32 = win32; posix.posix = posix` cross-links matching Node's own `path.win32`/`path.posix` shape). This is effectively the same module, not a reimplementation risk. |
| perf_hooks | module | — | 3 | Global `performance.now()` (Web Platform `Performance`) exists; no `PerformanceObserver`/`monitorEventLoopDelay`/`perf_hooks` module wrapper. | shimmable-JS | `src/js/polyfills/performance.js:12,45` use `globalThis.performance.now()`. `perf_hooks`'s `{ performance }` re-export is a one-line JS wrapper; `PerformanceObserver` for user/mark-measure entries is buildable in pure JS on top of the existing `performance.mark`/`measure` Web API surface. |
| process | module | — | 30 | See the `process` global row — same underlying object, `require('node:process')` is just a re-export of the global in Node too. | (see global row) | Combined ref total across `process` module+global: toolchain 177, bundle 3200. |
| querystring | module | — | 3 | No dedicated module, but the native `URLSearchParams` (with `Symbol.iterator` added) covers standard query-string parse/stringify. | shimmable-JS | `src/js/polyfills/url.js:6` (`const NativeURLSearchParams = core.URLSearchParams`), `:40` (`globalThis.URLSearchParams = NativeURLSearchParams`). Node's `querystring` module has some non-standard quirks (array/dup-key handling, custom escape) needing a thin JS layer atop `URLSearchParams`, not new native code. |
| readline | module | — | 15 | `tjs:readline` provides interactive line-editing/ANSI color primitives via `createInterface`, but with a different (non-EventEmitter-`line`-event) shape than Node's `readline`. | shimmable-JS | `src/js/stdlib/readline/readline.js:1319-1323` (`function createInterface(options) { … } export { createInterface, ReadlineInterface };`). Listed in `website/docs/features/standard-library.md` (`tjs:readline` — "Interactive line editing and ANSI colors"). A Node-shaped wrapper over this (or a from-scratch implementation directly on the stdin `ReadableStream`, already provided per the tty scrutiny row) is pure JS. |
| stream | module | — | 54 | No Node `Readable`/`Writable`/`Transform`/`Duplex`; WHATWG `ReadableStream`/`WritableStream`/`TransformStream` (Streams API) are native. | shimmable-JS | `website/docs/features/web-platform-apis.md` lists "Streams API" as supported; used throughout `src/js/core/fs.js`, `stdio.js`, `process.js` (`ProcessReadableStream extends ReadableStream`). Node's own ecosystem answer to "Node streams on WHATWG streams" is the pure-JS `readable-stream` npm package — same technique applies here, no native gap, though backpressure/`objectMode` semantics are real engineering work (not just a name-swap). |
| string_decoder | module | — | 7 | No dedicated module, but `TextDecoder` (native, supports `{ stream: true }` for multi-byte boundary carry-over) covers the core use case. | shimmable-JS | `web-platform-apis.md` lists the "Encoding API" (`TextEncoder`/`TextDecoder`) as supported; probe confirms `global.TextDecoder OK` under tjs. Node's `string_decoder` module solves exactly the incremental-multi-byte problem `TextDecoder({ stream: true })` already solves — a thin wrapper, not new logic. |
| timers | module | — | 5 | `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` are native globals; `setImmediate`/`clearImmediate` are absent. | shimmable-JS | Probe: `global.setTimeout OK` under tjs. No `setImmediate` hits in `src/js/`. `setImmediate` is commonly shimmed as `setTimeout(fn, 0)` (with the well-known ordering caveat versus real macrotask-queue semantics) — pure JS, no native gap. |
| tls | module | — | 11 | `TLSSocket`/`TLSServerSocket` (Direct Sockets) provide raw TLS client/server sockets over mbedtls, with per-socket custom CA/cert/key/ALPN/SNI/`verifyPeer` options. | shimmable-JS | `src/js/core/direct-sockets/tls.js`; native option plumbing in `src/mod_tls.c:1016-1113` (`ca`, `cert`/`key`, `verifyPeer`, `alpn`, `sni`). Node's `tls.TLSSocket`/`tls.connect` EventEmitter shape is a JS wrapper over an already-complete, already-configurable native primitive. |
| tty | module | 0 | 8 | `stream.isTerminal`/`.setRawMode()`/`.width`/`.height` exist on the stdio streams (see the tty scrutiny row); no `tty.WriteStream`/`ReadStream` classes or `tty.isatty()` free function. | shimmable-JS | `src/js/core/stdio.js:98-118` (`isTerminal`, `setRawMode`), `:196-210` (`width`/`height`). A `tty` module shim (classes extending the Node `net.Socket`/stream shim, plus `isatty(fd)` reading `.isTerminal`) is pure JS over an already-native primitive — this module row is `shimmable-JS` even though the underlying capability it wraps is fully `provided` (see scrutiny row above). |
| url | module | 3 | 52 | WHATWG `URL`/`URLSearchParams` are native; no legacy `url.parse`/`url.format`/`url.resolve`. | shimmable-JS | `src/js/polyfills/url.js` wraps `core.URL`/`core.URLSearchParams`. Node's legacy `url` module functions are themselves implemented in terms of the WHATWG `URL` class in modern Node — same JS-only adaptation applies here. |
| util | module | 1 | 63 | `tjs:utils` stdlib module exists ("Utility functions for formatting and inspecting values") — a direct conceptual analog, though not a literal `node:util` API match. | shimmable-JS | `website/docs/features/standard-library.md` lists `tjs:utils`. Node's `util.inspect`/`format`/`promisify`/`inherits`/`deprecate` are themselves pure-JS in Node's own codebase (no V8-internal dependency for the commonly-used subset) — reimplementable directly, optionally reusing `tjs:utils` as a starting point. |
| v8 | module | 1 | 1 | `tjs.engine.compile`/`.serialize`/`.deserialize` (`engine.js`) cover the structured-clone-style (de)serialization half of Node's `v8` module; there is no heap-statistics/heap-snapshot equivalent (that's V8-specific instrumentation). | shimmable-JS | `src/js/core/engine.js:5-24` (`compile`, `serialize`, `deserialize` wrapping `core.compile`/`core.serialize`/`core.deserialize`). `v8.getHeapStatistics()`/heap snapshots have no quickjs-ng equivalent surfaced anywhere searched; that half would be `needs-C` (quickjs-ng does expose some internal memory-usage instrumentation, e.g. `JS_ComputeMemoryUsage`, that isn't currently bound to JS) if ever required — noted as a sub-gap, not blocking the overall `shimmable-JS` call since the serialize/deserialize half (the common real-world use) is already native. |
| vm | module | 1 | 7 | No `vm.Script`/`vm.createContext`/sandboxed-realm API exposed to JS, even though the underlying engine capability (`JS_NewContext`, a distinct QuickJS realm per context) is already used internally for Workers. | needs-C | `src/vm.c:423` (`ctx = JS_NewContext(rt)`) — used to give each Worker its own context, but not exposed as a general-purpose JS API for arbitrary sandboxed `vm.Script` execution. Since the engine already supports multiple contexts per runtime (it's exercised today for Workers), exposing a scoped `tjs.engine.newContext()`-style binding is a plausible, contained native-binding addition — `needs-C`, not `hard`. |
| worker_threads | module | — | 1 | Web `Worker` (structured-clone `postMessage`) is native; Node's specific `parentPort`/`workerData`/`receiveMessageOnPort`/`MessageChannel` shapes are not. | shimmable-JS | `src/js/polyfills/worker.js` (`class Worker extends EventTarget`, native `core.Worker`). `SharedArrayBuffer`/`Atomics` are also natively available at the engine level (see globals table), so even shared-memory-flavored `worker_threads` patterns are buildable in JS on top of native primitives — no new native surface needed. |
| zlib | module | — | 11 | `CompressionStream`/`DecompressionStream` cover `gzip`/`deflate`/`deflate-raw` natively (via bundled `miniz`); Brotli is compiled out of the vendored libwebsockets by an explicit build flag. | shimmable-JS (gzip/deflate) + needs-C (brotli) | `website/docs/features/web-platform-apis.md`: "CompressionStream / DecompressionStream — Formats: gzip, deflate, deflate-raw". Implementation: `src/mod_miniz.c:37-486` (gzip header/trailer handling, `mz_deflate`/`mz_inflate`). Brotli: `deps/libwebsockets/CMakeLists.txt:185` (`LWS_WITH_HTTP_BROTLI … OFF`) — the library is already vendored with brotli support, just disabled; flipping it on is `needs-C` (a build-flag change plus exposing a JS binding), not a missing dependency. Node's *synchronous* `zlib.gzipSync`/`.deflateSync` calls hit the same async-stream-vs-sync-API tension as the `fs` scrutiny row above: `CompressionStream` is Streams-API/async by construction, so a truly synchronous zlib call needs either buffering through an async wrapper (fine if the bundle awaits it) or the same sync-over-async technique flagged for `fs`. |

## Globals

| Node API | kind | toolchain refs | bundle refs | txiki has | class | evidence |
|---|---|---|---|---|---|---|
| fetch | global | 3 | 44 | Native `fetch()`, transparently proxy-aware. | provided | See fetch-TLS scrutiny row. Probe: `global.fetch OK` (tjs), `ABSENT` (qjs). |
| Buffer | global | 13 | 548 | Not present. | shimmable-JS | See `buffer` module row — same gap, same fix (`Uint8Array` subclass). |
| process | global | 177 | 3170 | `tjs` exposes `args`, `env`, `exit`, `pid`, `ppid`, `cwd`/`chdir`, `exePath`, `hostName`, `version`, signal listeners, and stdio streams — but as a differently-shaped `tjs.*` global, not a `process.*` object with `process.stdout`/`process.on('SIGINT')` conventions. | shimmable-JS | `src/js/core/index.js:26-58` (exports list: `chdir`, `cwd`, `exePath`, `exit`, `pid`, `ppid`, `env`, `args`, `version`, etc.), `:178-198` (`tjs.stdin`/`stdout`/`stderr` getters). This is the single highest-volume shim in the whole matrix (3170 bundle refs) — a `process` global object assembled from `tjs.*` equivalents, forwarding `process.on('SIGINT'/'SIGWINCH'/…)` to `tjs.addSignalListener`. Pure JS, no missing native primitive, but by far the largest single piece of adaptation-layer engineering in this port. |
| WebSocket | global | 2 | 19 | Native `WebSocket` + `WebSocketStream`, both proxy-aware, both supporting custom handshake headers (non-standard extension). | provided | `website/docs/features/web-platform-apis.md` lists `WebSocket`/`WebSocketStream` with the headers extension documented in the same file's "Extensions" section. Probe: `global.WebSocket OK` (tjs). |
| URL | global | 1 | 316 | Native WHATWG `URL`. | provided | `web-platform-apis.md` lists `URL`. Probe: `global.URL OK` (tjs). |
| crypto | global | 2 | 51 | Native `crypto.getRandomValues`/`randomUUID`/`.subtle`. | provided | `web-platform-apis.md` "Web Crypto (SubtleCrypto)" section. Probe: `global.crypto OK` (tjs). |
| AbortController | global | — | 14 | Native, includes static `AbortSignal.abort()`/`.timeout()`/`.any()`. | provided | `web-platform-apis.md` row for `AbortController`/`AbortSignal`; `src/js/polyfills/abort-controller.js`. Probe: `global.AbortController OK` (tjs). |
| AbortSignal | global | — | 51 | Same as above. | provided | Same evidence as `AbortController`. |
| TextEncoder | global | — | 21 | Native, plus streaming `TextEncoderStream`. | provided | `web-platform-apis.md` "Encoding API" row. |
| TextDecoder | global | — | 16 | Native, plus streaming `TextDecoderStream`, `{ stream: true }` supported. | provided | Same row; used internally at `src/js/core/process.js:98`. |
| URLSearchParams | global | — | 26 | Native (`core.URLSearchParams`). | provided | `src/js/polyfills/url.js:6,40`. Probe: `global.URLSearchParams OK` (tjs). |
| queueMicrotask | global | — | 17 | Native. | provided | `web-platform-apis.md` lists `queueMicrotask`. Probe: `global.queueMicrotask OK` even under bare qjs. |
| structuredClone | global | — | 12 | Native. | provided | `src/js/polyfills/structured-clone.js`; `web-platform-apis.md` lists it. Probe: `global.structuredClone OK` (tjs), `ABSENT` (qjs). |
| setImmediate | global | — | 47 | Absent. | shimmable-JS | No hits in `src/js/`. Standard `setTimeout(fn, 0)`-based shim, pure JS (ordering-vs-real-Node caveat noted under the `timers` module row). |
| performance | global | — | 321 | Native `Performance` (`.now()`, `.mark()`/`.measure()` per Web Platform API). | provided | `web-platform-apis.md` lists `Performance`; `src/js/polyfills/performance.js`. Probe: `global.performance OK` (tjs and even bare qjs). |
| navigator | global | — | 19 | Native `navigator.userAgentData` only (WICG UA-Client-Hints), not a full Node-side `navigator` shim (this is normally a browser-only global; the bundle likely feature-detects it or reads `navigator.userAgent`). | shimmable-JS | `web-platform-apis.md`: "Navigator.userAgentData". `src/js/polyfills/navigator.js` (205 lines) — implements more than just `userAgentData` per its size; a thin extension covering whatever specific `navigator.*` field the bundle reads (likely `userAgent`/`platform` feature-detection) is pure JS. |
| ReadableStream | global | — | 6 | Native (Streams API), used pervasively internally (`fs`, `process`, `stdio`). | provided | `web-platform-apis.md` "Streams API" row; `src/js/core/fs.js:30`, `src/js/core/process.js:43`. Probe: `global.ReadableStream OK` (tjs), `ABSENT` (qjs). |
| TransformStream | global | — | 3 | Native (Streams API). | provided | Same "Streams API" row; used by `src/js/polyfills/compression-streams.js` and `text-encode-transform.js`. |
| Blob | global | — | 5 | Native. | provided | `web-platform-apis.md` lists `Blob`; `src/js/polyfills/blob.js` (255 lines). Probe: `global.Blob OK` (tjs), `ABSENT` (qjs). |
| FormData | global | — | 2 | Native. | provided | `web-platform-apis.md` lists `FormData`; `src/js/polyfills/form-data.js` (306 lines). |
| Headers | global | — | 37 | Native (Fetch spec `Headers`). | provided | `web-platform-apis.md` "fetch" row includes the full Fetch API surface; `src/js/polyfills/http-client.js` uses `Headers`-shaped request/response objects throughout. |
| Request | global | — | 10 | Native (Fetch spec). | provided | Same fetch-spec evidence; used in `website/docs/guides/serve.md`'s `fetch(request)` handler example. |
| Response | global | — | 55 | Native (Fetch spec). | provided | Same evidence; `Response` constructed directly in the `tjs.serve()` example. |
| Worker | global | — | 2 | Native (structured-clone messaging). | provided (Web-Worker shape only) | `src/js/polyfills/worker.js`; `web-platform-apis.md` lists "Web Workers". Node's distinct `worker_threads`-flavored API is the `shimmable-JS` gap tracked in the `worker_threads` module row, not here — the *global* `Worker` constructor itself is fully native. |
| SharedArrayBuffer | global | — | 2 | Native — this is a JS-engine (quickjs-ng) language feature, not a txiki-specific API. | provided | `deps/quickjs/quickjs.c` contains `SharedArrayBuffer` support (confirmed via `grep -l SharedArrayBuffer deps/quickjs/*.c` matching `quickjs.c`). Not part of the tjs/qjs probe's global list, but present at the engine level regardless of which wrapper (tjs) sits on top. |
| Atomics | global | — | 3 | Native (quickjs-ng engine feature). | provided | `deps/quickjs/quickjs.c` contains 59 `js_atomics`/`Atomics` symbol references. |
| FinalizationRegistry | global | — | 1 | Native (quickjs-ng engine feature). | provided | `deps/quickjs/quickjs.c` contains 11 `FinalizationRegistry` references. |
| WeakRef | global | — | 5 | Native (quickjs-ng engine feature). | provided | `deps/quickjs/quickjs.c` contains 38 `WeakRef` references. |

## LLRT prior-art cross-check

[LLRT](https://github.com/awslabs/llrt) (AWS Labs' Rust/QuickJS Lambda
runtime, a shipping product optimized for cold-start) is explicit that
it is "**NOT** a drop-in replacement for Node.js, nor will it ever be,"
and its compatibility matrix marks `node:http`, `node:https`, `node:tls`
as **unsupported** (`http`/`https` "planned") and `node:http2`,
`node:inspector`, `node:v8`, `node:vm`, `node:worker_threads`,
`node:querystring`, `node:readline`, `node:repl`, `node:sqlite`,
`node:test`, `node:cluster`, `node:dgram`, `node:diagnostics_channel`,
`node:wasi` as flat-out **unsupported**, full stop — no planned date.
That is a striking point of *agreement* with this matrix on the
hardest rows: `inspector`, `v8` (heap side), `vm`, `http2`, and
`worker_threads` (Node-shaped) all land as `hard`/`needs-C`/
`shimmable-JS`-with-caveats here too. It validates that these are
genuinely the awkward corners of running Node-surface code on a
non-V8 engine, not an artifact of txiki specifically.

The interesting **divergence** is `tls`/`https`/`net`: LLRT marks these
**unsupported** (with `http`/`https` merely "planned"), while this
matrix finds txiki.js already has full raw TCP/TLS/UDP direct-sockets
support (custom CA, ALPN, SNI, `verifyPeer`) *and* transparent,
env-var-driven HTTP(S) **proxy** support baked into its `fetch`/
`WebSocket`/serve stack — a feature LLRT doesn't appear to have at all
(no proxy mention found in its README). Two plausible readings: (a)
LLRT is a Lambda runtime, where raw sockets/proxies are simply out of
scope for its target workload (short-lived, direct-invoked functions
behind AWS's own networking), so its omission is a product-scope
choice rather than an engine limitation; or (b) txiki.js, as a
general-purpose CLI/server runtime, had to solve proxy/TLS-trust
because *that's* the workload it targets — much closer to clode's own
shape (a TUI that spawns children and fetches through corporate
proxies) than Lambda's is. Either way, the fact that a second,
independently-engineered QuickJS-family runtime chose to leave `tls`
fully unsupported while txiki.js implemented it in full is a signal
that this was a genuinely nontrivial engineering investment — and one
that, per this gate, txiki.js already made for us.

## Self-review

- Every module and global key present in `gate2-inventory.json`
  (toolchain ∪ bundle) has exactly one row above; no `…` cells remain.
  Tally: 33 module rows (`fs`, `child_process`, `assert`, `async_hooks`,
  `buffer`, `console`, `constants`, `crypto`, `dns`, `events`, `http`,
  `http2`, `https`, `inspector`, `module`, `net`, `os`, `path`,
  `perf_hooks`, `process`, `querystring`, `readline`, `stream`,
  `string_decoder`, `timers`, `tls`, `tty`, `url`, `util`, `v8`, `vm`,
  `worker_threads`, `zlib`) + 28 global rows (`fetch`, `Buffer`,
  `process`, `WebSocket`, `URL`, `crypto`, `AbortController`,
  `AbortSignal`, `TextEncoder`, `TextDecoder`, `URLSearchParams`,
  `queueMicrotask`, `structuredClone`, `setImmediate`, `performance`,
  `navigator`, `ReadableStream`, `TransformStream`, `Blob`, `FormData`,
  `Headers`, `Request`, `Response`, `Worker`, `SharedArrayBuffer`,
  `Atomics`, `FinalizationRegistry`, `WeakRef`) = 61 distinct rows,
  plus 3 explicit composite scrutiny rows called out separately per the
  brief's template (their ref counts are cross-referenced into the
  underlying module rows rather than double-counted in the tally
  below).
- Classification tally (61 module/global rows; the `process` module
  row is counted with its global row's `shimmable-JS` verdict since
  they're the same underlying object; `zlib`'s composite verdict is
  counted under `needs-C` since the brotli half is the real gap):
  **provided 27** (modules: `child_process`, `console`, `path`;
  globals: `fetch`, `WebSocket`, `URL`, `crypto`, `AbortController`,
  `AbortSignal`, `TextEncoder`, `TextDecoder`, `URLSearchParams`,
  `queueMicrotask`, `structuredClone`, `performance`, `ReadableStream`,
  `TransformStream`, `Blob`, `FormData`, `Headers`, `Request`,
  `Response`, `Worker`, `SharedArrayBuffer`, `Atomics`,
  `FinalizationRegistry`, `WeakRef`) · **shimmable-JS 29** (modules:
  `assert`, `async_hooks`, `buffer`, `constants`, `crypto`, `dns`,
  `events`, `http`, `https`, `module`, `net`, `os`, `perf_hooks`,
  `process`, `querystring`, `readline`, `stream`, `string_decoder`,
  `timers`, `tls`, `tty`, `url`, `util`, `v8`, `worker_threads`;
  globals: `Buffer`, `process`, `setImmediate`, `navigator`)
  · **needs-C 4** (`fs` sync, `http2`, `vm`, `zlib`/brotli half)
  · **hard 1** (`inspector`, explicitly flagged non-blocking).
  27 + 29 + 4 + 1 = 61.
- Ref counts were copied verbatim from `gate2-inventory.json`;
  spot-checked `fs` (toolchain 15 / bundle 452), `crypto` (toolchain 1 /
  bundle 191), and `process` — toolchain has *no* `process` module ref
  (only 177 global refs), while bundle has both 30 module refs and
  3170 global refs; the module row cross-references the global row
  rather than re-deriving a separate count, and the combined bundle
  total (30 + 3170 = 3200) is stated once, in the `process` module row.
- Every row cites a file path (txiki source or `website/docs/`) or the
  probe transcript; no row rests on unstated priors.
