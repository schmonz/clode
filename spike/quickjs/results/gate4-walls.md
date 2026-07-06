# Gate 4 — boot-attempt wall log

Ladder: libexec/clode-net.cjs -> libexec/extract-claude-js.cjs -> newest ~/.cache/clode/*/cli.cjs
Each run appended in order; loader-vs-txiki API mismatches were fixed before rung 1 (see cjs-loader.js header comment) and are NOT logged as walls — only genuine node-API gaps are.

## rung: libexec/clode-net.cjs  (demo: node:url NOT yet shimmed)
```
BOOT-STOP /Users/schmonz/Documents/shared-trees/clode/libexec/clode-net.cjs: WALL: node:url.fileURLToPath
--- WALL LOG (first-touch order) ---
WALL 1: node:url.fileURLToPath
```

## rung: libexec/clode-net.cjs  (after: node:url.fileURLToPath + node:url.pathToFileURL shimmed)
```
BOOT-OK /Users/schmonz/Documents/shared-trees/clode/libexec/clode-net.cjs
--- WALL LOG (first-touch order) ---
(no walls hit)
```

## rung: libexec/extract-claude-js.cjs  (demo: static require() preloader NOT yet added; shebang-strip fix already applied)
```
BOOT-STOP /Users/schmonz/Documents/shared-trees/clode/libexec/extract-claude-js.cjs: WALL: require(./bundle-carve.cjs) — not statically preloadable (computed id, or resolve failed)
--- WALL LOG (first-touch order) ---
WALL 1: require(./bundle-carve.cjs) [unresolved-relative]
```

## rung: libexec/extract-claude-js.cjs  (after: static preload added — FALSE POSITIVE found: naive regex matched require(__dirname+...) text INSIDE the PRELUDE template-literal constant, eagerly+wrongly ran libexec/bun-shim.cjs, mis-attributing WALL node:fs.readSync to this rung)
```
GET node:fs readSync while loading /Users/schmonz/Documents/shared-trees/clode/libexec/bun-shim.cjs
BOOT-OK /Users/schmonz/Documents/shared-trees/clode/libexec/extract-claude-js.cjs
--- WALL LOG (first-touch order) ---
WALL 1: node:fs.readSync
```

## rung: libexec/extract-claude-js.cjs  (after: preloader now blanks backtick template-literal bodies before scanning — false positive fixed)
```
BOOT-OK /Users/schmonz/Documents/shared-trees/clode/libexec/extract-claude-js.cjs
--- WALL LOG (first-touch order) ---
(no walls hit)
```

---

# Final ladder run (finished loader, all fixes applied)

## rung: /Users/schmonz/Documents/shared-trees/clode/libexec/clode-net.cjs
```
BOOT-OK /Users/schmonz/Documents/shared-trees/clode/libexec/clode-net.cjs
--- WALL LOG (first-touch order) ---
(no walls hit)
```

## rung: /Users/schmonz/Documents/shared-trees/clode/libexec/extract-claude-js.cjs
```
BOOT-OK /Users/schmonz/Documents/shared-trees/clode/libexec/extract-claude-js.cjs
--- WALL LOG (first-touch order) ---
(no walls hit)
```

## rung: /Users/schmonz/.cache/clode/2.1.198/cli.cjs
```
BOOT-OK /Users/schmonz/.cache/clode/2.1.198/cli.cjs
> NOTE: BOOT-OK here means only that the synchronous top-level returned. Failures in async continuations, timers, and unhandled rejections after that point are NOT captured by this determination — this same run then dies on the uncaught fs/promises rejection shown below (i.e., an effective boot stop for the async phase).
--- WALL LOG (first-touch order) ---
WALL 1: require(string-width)
WALL 2: require(strip-ansi)
WALL 3: require(wrap-ansi)
WALL 4: require(semver)
WALL 5: require(yaml)
WALL 6: require(ws)
WALL 7: node:fs.realpathSync()
WALL 8: require(fs/promises)
Error: WALL: require(fs/promises)
    at req (/Users/schmonz/Documents/shared-trees/clode/spike/quickjs/boot/cjs-loader.js:261:15)
    at <anonymous> (<input>:85:214)
    at <anonymous> (<input>:39:1270)
    at <anonymous> (<input>:91:373)
    at <anonymous> (<input>:39:1270)
    at <anonymous> (<input>:95:1856)
    at <anonymous> (<input>:39:1270)
    at <anonymous> (<input>:35980:3084)

```

---

## Loader fixes found along the way (NOT walls — API/behavior mismatches between the brief's starter loader and the pinned txiki v26.6.0 checkout, or bugs in this loader's own static analysis; fixed in cjs-loader.js, not logged as registry stubs)

1. **`tjs.args` index.** Under `tjs run boot/cjs-loader.js <target>`, `tjs.args` is
   `[tjsBinaryPath, 'run', <this file>, <target>, ...extra]` — target is index 3,
   not 2 (the brief's code assumed no `run` subcommand slot).
2. **`tjs.cwd` / `tjs.exePath` / `tjs.pid` are values, not functions.**
   `src/js/core/index.js` copies the property descriptor from `core` as-is —
   `tjs.cwd()` throws `TypeError: not a function`.
3. **`tjs.platform` does not exist.** `mod_sys.c` sets `TJS__PLATFORM` on an
   internal namespace that `src/js/core/index.js`'s curated `exports` list never
   re-copies onto the public `tjs` global. `navigator.platform` (present via
   `src/js/polyfills/navigator.js`) is the closest real signal and is used
   instead (`MacIntel` → darwin, `Linux …` → linux, `Win32` → win32, …).
4. **`tjs.stdout` / `tjs.stderr` have no `.write()`.** They're WritableStreams;
   you must `getWriter()` once and call `writer.write(bytes)`.
5. **Leading shebang breaks `new Function(...)`.** `extract-claude-js.cjs` (and
   the cached `cli.cjs`) start with `#!/usr/bin/env node`. Node's module loader
   strips this before compiling; `new Function` does not, and QuickJS parses
   the bare `#` as an invalid private-name token (`invalid first character of
   private name`). Fixed by stripping a leading `#!` line before compiling.
6. **Static require() scanner false-positive on template-literal text.** The
   preloader's regex-based scan for `require('./x')` / `require(__dirname +
   '/x')` initially scanned the RAW module source, including inside backtick
   template literals. `extract-claude-js.cjs`'s `PRELUDE` constant is literal
   *text* (destined for the extracted bundle) that itself contains
   `require(__dirname + '/bun-shim.cjs')`, `require('url')`, and
   `require('child_process')` — the naive scanner matched this as if
   extract-claude-js.cjs itself required those, eagerly (and wrongly) loading
   and *executing* `libexec/bun-shim.cjs`, which mis-attributed a real wall
   (`node:fs.readSync`) to the wrong rung. Fixed by blanking backtick
   template-literal bodies before scanning (see rung-2 log entries above for
   the before/after).
7. **wallProxy walls on GET, not CALL — too pessimistic.** bun-shim.cjs's very
   first statement, `const _readSync = fs.readSync;`, just saves a reference
   before monkey-patching it — never calls it. A get-throws proxy treats that
   as "touched" and stops immediately, without ever learning whether the API
   is actually exercised. Redesigned `wallProxy` to vivify a per-property
   *stub function* on first GET (no wall) that walls only when *invoked*, and
   added a `set` trap so monkey-patches (`fs.readSync = fn`) stick. This is a
   loader-quality fix, not a stub, and materially changed how far rung 3 got
   (from 2 walls to 8).

## Annotated wall list (hand-added; contract: `WALL <n>: <api> — <where hit> — assessment: …`)

First-touch order across the whole ladder. "fixed" walls got a real (if
partial) implementation added to the `shims` registry and the ladder was
re-run past them; the rest are where each rung's exploration actually stopped.

- **WALL 1: `node:url.fileURLToPath`** — `libexec/clode-net.cjs` top-level
  destructure (`const { fileURLToPath } = require('node:url')`) —
  assessment: shimmable-JS — **fixed** (built on the global `URL`, which tjs
  does expose). `pathToFileURL` added alongside it since the extracted
  bundle's own prelude needs it too (see WALL entries in rung 3).
- **WALL 2: `node:fs.readSync` / `node:fs.realpathSync`** — `libexec/bun-shim.cjs`
  (and, as `realpathSync`, somewhere inside the 18MB `cli.cjs` bundle itself)
  — assessment: **hard**. tjs has *zero* synchronous filesystem primitives
  (the C core has internal statSync/mkdirSync used only by its bootstrap, not
  exported to the tjs global, and not the walled operations — readSync/readFileSync/realpathSync
  exist nowhere) (`tjs.readFile`/`stat`/`realPath`/etc. are all `libuv`-async-only, per
  `src/js/core/index.js`); CJS `require()` semantics assume synchronous fs.
  A real fix needs a blocking bridge (tjs does expose `Worker` +
  `SharedArrayBuffer` + `Atomics`, so `Atomics.wait`-on-a-worker is possible
  in pure JS — not impossible, but real engineering, not a stub). **Not
  fixed** — this is the wall that most changes the shape of the future
  node-shim effort (see report).
- **WALL 3: `require(process)`** (bare `require('process')`, distinct from
  the ambient `process` identifier the CJS wrapper already injects) — inside
  a bundled sub-module of `cli.cjs` — assessment: shimmable-JS — **fixed**
  (aliased `node:process` to the exact same shared `process` object every
  module's wrapper function already receives, matching real Node where both
  paths return the identical object).
- **WALL 4: `require(string-width)`** — `libexec/bun-shim.cjs`'s
  `_extResolve('string-width')` (try/caught internally, non-fatal) —
  assessment: shimmable-JS — real fix is vendoring the actual (small) npm
  package; not a <15-min stub here. Not fixed.
- **WALL 5: `require(strip-ansi)`** — same call site, `_extResolve('strip-ansi')`
  — assessment: shimmable-JS — same as WALL 4. Not fixed.
- **WALL 6: `require(wrap-ansi)`** — same call site,
  `_extResolve('wrap-ansi')` — assessment: shimmable-JS — same as WALL 4.
  Not fixed.
- **WALL 7: `require(semver)`** — `libexec/bun-shim.cjs`'s
  `try { _semver = require('semver'); } catch(_){}` — assessment:
  shimmable-JS — same as WALL 4 (vendor the package). Not fixed.
- **WALL 8: `require(yaml)`** — `libexec/bun-shim.cjs`'s
  `try { _yaml = require('yaml'); } catch(_){}` — assessment: shimmable-JS
  — same as WALL 4. Not fixed.
- **WALL 9: `require(ws)`** — `libexec/bun-shim.cjs`'s WebSocket
  compatibility fallback — assessment: shimmable-JS, and notably tjs already
  has a native global `WebSocket` (`src/js/polyfills/ws.js`) that could
  plausibly stand in for the `ws` package directly rather than requiring a
  vendored port — worth a real look in phase 2, but not a <15-min stub here.
  Not fixed.
- **WALL 10: `node:crypto.randomUUID()`** — inside `cli.cjs` (deep,
  minified call site) — assessment: shimmable-JS — **fixed** (the global
  WebCrypto object tjs exposes already has `crypto.randomUUID()`, so this is
  a one-line alias).
- **WALL 11: `require(fs/promises)`** — inside `cli.cjs` (deep, minified,
  reached from an unguarded async continuation — this is an *uncaught*
  wall, unlike most of bun-shim.cjs's try/caught ones, so it's an effective
  boot stop (async-phase) for the bundle rung) — assessment: shimmable-JS. Unlike the
  sync-fs family, `fs/promises` maps cleanly onto tjs's native async I/O
  (`tjs.readFile`/`writeFile`/`stat`/`readDir`/`makeDir`/… are already
  promise-based) — this is a genuinely *good* sign for the node-shim's
  eventual feasibility. But the module's full method surface (encodings,
  flags, `FileHandle`, …) is more than a 15-minute stub. **Stopped here** —
  this is the ladder's natural stopping point per the timebox.

## Gate evaluation

No **architectural** wall was hit (nothing where "no compat layer can
provide it" — even the toughest wall, sync fs, has a known-possible if
expensive path via `Worker` + `Atomics.wait`, since tjs exposes both).
Everything found is **hard** (sync fs) or **shimmable-JS** (everything
else) — real, sizeable work for a phase-2 node-shim, but not a re-plan
trigger.

**Tally:** 10 shimmable-JS / 0 needs-C / 1 hard / 0 architectural = 11 entries
