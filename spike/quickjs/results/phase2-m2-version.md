# Phase 2 · M2 — real bundle `--version` under tjs (PROOF)

**Milestone claim:** the REAL, unmodified Claude Code 2.1.202 bundle — extracted
from the actual 240MB darwin-arm64 native binary, not a synthetic fixture — boots
under the patched `build/tjs/tjs` via the node-shim loader and `--version` prints
the exact version string, byte-identical to host node, exit 0. No branded wall,
no bare error, no hang.

- Host node: `node` (v26.3.0 / pkgsrc) — reference oracle.
- tjs: `build/tjs/tjs`, patched with `__tjs_fs_sync` (M1) and the new
  `TJS__DEFAULT_STACK_SIZE` 1MB→4MB fix (this milestone) + `libexec/node-shim/loader.cjs`.
- Date: 2026-07-07.

---

## Inputs

- **Provider:** Claude Code **2.1.202 (darwin-arm64)**. Resolved via
  `libexec/clode-update.cjs` `clodeUpdate("latest")`, fetched store-isolated
  (`XDG_DATA_HOME=$(mktemp -d)`, `CLODE_FETCH_PLATFORM=darwin-arm64`); real
  `~/.local/share/clode` confirmed untouched (absent) both before and after.
  `claude` binary: 243,631,376 bytes.
- **Extraction:** `libexec/extract-claude-js.cjs` → `cli.cjs` (22,096,087 bytes)
  + `bun-shim.cjs` staged beside it, `NODE_PATH=$PWD/node_modules`.
- **`build/tjs/tjs` provenance:** quickjs-ng v0.15.1 + txiki.js v26.6.0
  (see `spike/quickjs/PINS.md` for exact commits/tags), with three patches applied:
  1. `patches/quickjs-ng-js_exepath-netbsd.patch` (M1/gate3, unrelated to this milestone).
  2. `patches/txiki-sync-fs.patch` — adds `__tjs_fs_sync` (M1 gate, sync POSIX fs for CJS interop).
  3. `patches/txiki-default-stack-size.patch` — raises the Release
     `TJS__DEFAULT_STACK_SIZE` from txiki's stock 1MB to 4MB (**new this milestone**,
     see "Wall 1" below). Rebuilt via `node scripts/build-tjs.mjs`.
  `build/` is gitignored; the binary is reproducible from the three committed patches.

---

## Rung A — real extraction at scale (closed synthetic-only gate)

M1's evidence file (`phase2-m1-toolchain.md`) proved the extractor's code paths
only on a synthetic Bun `--compile` fixture, and explicitly named "full 240MB
real-native-binary extraction under tjs" as an M2 entry gate. Task 1
(`4638293`, `test(node-shim): real-binary extraction at scale under tjs`) closed
it: run against the REAL 243MB darwin-arm64 `claude` binary (not a fixture),
`libexec/extract-claude-js.cjs` under tjs produces output byte-identical to the
node oracle, and the real anchor checks (`doctor`/`autoupdater` hook detection)
**match with no "NOT applied" warnings** — confirming the extractor's carve +
`import.meta` rewrite + PRELUDE-prepend logic holds at real scale, not just on
the minimal synthetic case M1 exercised.

---

## Rung B — `--version` under tjs (the milestone)

### Verbatim boot output (Task 5, `781e178`)

Default stack, pre-fix (the stock txiki 1MB release default):
```
$ build/tjs/tjs run libexec/node-shim/loader.cjs $SCRATCH/cli.cjs --version
RangeError: Maximum call stack size exceeded
```

Final acceptance — rebuilt 4MB binary, real `loader.cjs`, no flags:
```
$ build/tjs/tjs run libexec/node-shim/loader.cjs $SCRATCH/cli.cjs --version
2.1.202 (Claude Code)
tjs-exit=0
$ node $SCRATCH/cli.cjs --version
2.1.202 (Claude Code)
node-exit=0
diff(tjs stdout, node stdout) → BYTE-IDENTICAL (cmp: identical)
hexdump: 322e 312e 3230 3220 2843 6c61 7564 6520 436f 6465 290a  ("2.1.202 (Claude Code)\n")
```
tjs stderr: empty.

Both the tjs run and the node oracle print `2.1.202 (Claude Code)`, exit 0,
byte-identical stdout, empty stderr. This is the whole M2 design's target
milestone ("bundle `--version`"), met on the real, unmodified bundle.

---

## Walls hit + fixes

### Wall 1 (the ONLY wall) — tjs default JS stack too small for the real bundle

- **Symptom:** `build/tjs/tjs run libexec/node-shim/loader.cjs cli.cjs --version`
  → bare `RangeError: Maximum call stack size exceeded`, no stack trace (QuickJS
  cannot capture a trace once the stack is already exhausted).
- **Diagnosis (systematic-debugging, cause named before fixing):**
  - **Parser ruled out.** Parsing the 22MB `cli.cjs` via `new Function(...)`
    succeeds even at the stock default stack — so the QuickJS parser is not
    the culprit.
  - **Threshold-bisected.** Binary-searching `--stack-size` on an experimental
    loader: 262K/524K/1M all overflow at `evalModule → fn.call` executing the
    **cli.cjs entry body itself**; 2M and 4M/8M clear it. The failure is
    *runtime recursion depth* while evaluating the CJS entry — the real bundle
    recurses deeper at startup than txiki's stock 1MB release JS stack admits.
  - **`setMaxStackSize` unreachable.** Root cause traced to
    `spike/quickjs/vendor/txiki.js/src/vm.c` — `#ifdef NDEBUG` (Release build)
    `TJS__DEFAULT_STACK_SIZE (1024*1024)`. `JS_SetMaxStackSize` is the only
    lever, but txiki exposes it only on `tjs:internal/core`, which is
    "not exposed to user code" (verified: dynamic `import('tjs:internal/core')`
    throws); `tjs.engine` does not carry `setMaxStackSize`. No runtime setter is
    reachable from the loader; a re-exec wrapper was rejected as heavyweight and
    fragile. The clean, acceptance-command-compatible fix is a build-config change.
  - A transient *false* `fs.readSync not implemented` wall appeared while
    probing with an experimental loader copied to `/tmp` (there `SHIM_DIR` →
    `/tmp/modules` doesn't exist, so `require('fs')` fell to a wallProxy) —
    corrected by running the loader beside the real `modules/`; not a real wall.
- **Fix:** new patch `spike/quickjs/patches/txiki-default-stack-size.patch`,
  raising the Release `TJS__DEFAULT_STACK_SIZE` from 1MB to 4MB; PINS.md note
  added; rebuilt via `node scripts/build-tjs.mjs`. 4MB clears the boot with
  headroom (measured recursion depth **1034 → 4155**) and stays well under the
  8MB main-thread C stack on macOS/Linux. This is a **new, third** txiki patch
  (alongside `txiki-sync-fs.patch` from M1 and the unrelated NetBSD
  `js_exepath` quickjs-ng patch from the M4 spike).
- **Characterization:** `test/node-shim-stack.test.cjs` — a fixture descends
  until it overflows and reports the depth reached; runs through the loader at
  the **default** stack (the exact `--version` config, no flag) under both host
  node and tjs. Because this is a *capacity* wall, exact depth-equality with
  node is engine-specific and meaningless; the asserted invariant is that BOTH
  admit depth ≥ 3000 — comfortably past the ~1034 the stock 1MB default
  allowed and below the ~4155 the 4MB default admits. Verified failing on the
  pre-fix binary (depth=1034), passing on the rebuilt binary (depth=4155).

**No other walls.** `--version` is a clean early-exit path: it did not spawn a
child process, open a socket, or touch `ws`/`net`/`tls`/the TUI.

---

## What M2 did NOT need

- **No SEALED-set adjustment.** `SEALED = {module, vm}` (set in Task 2) was not
  touched; no sealed feature-detect tripped during `--version`.
- **`child_process` stayed empty `{}`.** Never required/called.
- **No spawn, socket, `ws`, `net`, `tls`, or TUI surface was reached.**
  `Bun.spawn` unused. `--version` completed cleanly with no network or terminal use.

---

## Divergences

Carried from M1 (`phase2-m1-toolchain.md`), still accurate, none newly
exercised or invalidated by `--version`:

- **`vm.Script` is syntax-check-only**, and `vm.runInThisContext` /
  `vm.compileFunction` run in the **GLOBAL context, not a sandboxed one**
  (`libexec/node-shim/modules/vm.cjs`, documented + tested in-file) —
  quickjs-ng has no context-isolation primitive exposed here. **Not exercised
  by `--version`** — the bundle's early-exit version path never called into
  `vm`. Still adequate for a non-sandboxed self-eval; a true sandbox remains a wall.
- **`require.main` is loader-synthesized**, not a real `Module` instance —
  identity (`=== module`) and `.filename` are correct; `.children`/`.paths`/
  `.loaded`/`.id` are absent. Exercised during boot (module resolution runs),
  no observed breakage.
- **Sealed-surface property walls** change Node's missing-prop=undefined idiom
  to a branded throw, but only for the two SEALED modules (`module`, `vm`); all
  other builtins keep Node's normal idiom. Unchanged by this milestone.
- **`process.nextTick` vs `queueMicrotask` ordering:** `--version` did not
  observably depend on ordering between the two — no divergence surfaced.
- **New nit — `util.isDeepStrictEqual(0, -0)` diverges from node.**
  `libexec/node-shim/modules/util.cjs` line 27 shortcuts `if (a === b) return true`
  before falling back to `Object.is` semantics; since `0 === -0` is `true` in JS,
  the shim reports `isDeepStrictEqual(0, -0) === true`, whereas node's real
  `util.isDeepStrictEqual` distinguishes `0` from `-0` (→ `false`). Not
  exercised by `--version`'s boot path (no known caller compares signed zeros);
  recorded here as a known shim-fidelity gap, not fixed in M2 (out of scope —
  `--version` never surfaced it as a wall).

---

## M1 M2-entry-gates — now CLOSED

M1's evidence file named two explicit M2 entry gates. Both are resolved:

1. **"Property-level fail-loud walls + `Module.wrap` / a fuller `vm`."**
   Closed by Task 2 (`bd9acb3`, `feat(node-shim): property-granular walls +
   Module._load/wrap + fuller vm (M2 gate)`) — the `SEALED` set now throws the
   branded wall on missing properties (not just missing modules) for `module`
   and `vm`, `Module.wrap` is implemented, and `vm` gained
   `runInThisContext`/`compileFunction`.
2. **"Full 240MB real-native-binary extraction under tjs."**
   Closed by Task 1 (`4638293`) — see "Rung A" above: the real 243MB
   darwin-arm64 provider binary extracts byte-identical to node, real anchors
   match, no "NOT applied" warnings.

---

## M3 entry gates (surfaced, not fixed)

`--version` is a clean early-exit: it never reached the network, TLS, real
child-process spawning, or the TUI. The M3 milestone — a headless round-trip,
e.g. `CLODE_ENGINE=tjs clode -p 'say PONG'` with a real `ANTHROPIC_API_KEY` —
will newly exercise all of the following, none of which `--version` touched:

- **Real network path.** `ws` → the txiki WebSocket adapter (the bundle's
  `_wsArgs` shim was characterization-tested against Bun-shape args in Task 4,
  but never driven against a live txiki `WebSocket` under tjs). `net`/`tls`
  and `fetch` (`clode-net.cjs`'s real HTTPS path) are entirely unexercised by
  `--version`.
- **Real child-process / spawn.** `child_process` stayed `{}` and `Bun.spawn`
  was unused during `--version`; M3's round-trip is expected to actually spawn
  (or the bundle to call `Bun.spawn`/`tjs.spawn`), which will need routing
  through whatever `tjs.spawn` surface exists — unproven today.
- **Deeper `Bun.*` surface.** Only the pieces bun-shim touches at load time and
  during a version-only path were exercised (Task 4); `Bun.semver`, YAML,
  string-width/ANSI stubs, etc. are unit-characterized in isolation but not yet
  proven inside a live tjs round-trip.
- **Event-loop ordering under real async.** `--version` is synchronous
  end-to-end; a real round-trip drives genuine async I/O (network reads,
  timers, streaming), which is where `nextTick`/microtask/timer-ordering
  divergences (if any) would actually surface.
- **The 4MB stack may need bumping for deeper paths.** The stack-size fix in
  this milestone was empirically tuned to `--version`'s recursion depth
  (measured 4155 against the new 4MB ceiling, leaving 4MB of headroom under
  the 8MB main-thread C stack). A full round-trip through network/TUI/deeper
  `Bun.*` call chains may recurse further and re-trip the same class of wall;
  if so, bump `TJS__DEFAULT_STACK_SIZE` again, mindful of the next gate.
- **Worker-thread caveat.** The 4MB JS stack limit applies to all threads, but
  libuv worker threads default to only a ~512KB C stack on macOS — a 4MB JS
  limit there could **segfault** rather than throw a catchable `RangeError`.
  Safe today because `--version` is main-thread-only (8MB C stack) and
  `worker_threads` is not shimmed; if M3 ever needs `worker_threads`, this
  needs addressing (either a per-thread stack size or shimming
  `worker_threads` to reject/wall it) before it becomes a live segfault risk.

---

## Shim-suite tally (Task 5)

`node --test test/node-shim-*.test.cjs` → tests 27, pass 26, fail 0, skipped 1.
The 1 skip is the pre-existing `CLODE_PROVIDER_BIN`-gated real-bundle extractor
test; run explicitly with the fetched binary it passes
(`node-shim-bundle-extract.test.cjs` → 1 pass). The new
`node-shim-stack.test.cjs` row passes.

## Full-suite tally (this task, close-out)

```
$ npm test
...
ℹ tests 412
ℹ suites 0
ℹ pass 372
ℹ fail 0
ℹ cancelled 0
ℹ skipped 39
ℹ todo 1
ℹ duration_ms 8823.002125
```

All 39 skips are pre-existing opt-in gates (SEA build unsupported on this box,
provider-binary-gated regression fixtures, ext-dep `semver` not installed) —
none newly introduced by M2. No fail. No regression from the Task 6 tally
(`tests 412, pass 372, fail 0, skipped 39, todo 1`), confirming the suite is
stable across the full M2 arc (Tasks 1–7).

## Files changed across M2 (Tasks 1–7, for reference)

- Task 1 (`4638293`) — real-binary extraction test at scale.
- Task 2 (`bd9acb3`) — property-granular walls, `Module._load`/`wrap`, fuller `vm`.
- Task 3 (`9a7e21f`) — feross `buffer` as the global `Buffer`, NODE_PATH ext resolution.
- Task 4 (`7457384`) — bun-shim loads clean under the loader.
- Task 5 (`781e178`) — the `--version` milestone: `txiki-default-stack-size.patch`,
  `test/node-shim-stack.test.cjs`, `PINS.md` note.
- Task 6 (`1961387`) — `libexec/clode-run.cjs` `CLODE_ENGINE=tjs` opt-in branch,
  `test/clode-run-engine.test.cjs`.
- Task 7 (this commit) — `spike/quickjs/results/phase2-m2-version.md` (this
  file) + the worker-thread caveat folded into `spike/quickjs/PINS.md`.

## Self-review

- Every transcript above is quoted verbatim from the committed Task 5 report
  (`.superpowers/sdd/task-5-report.md`), not re-derived or re-run — the 240MB
  fetch/boot was not repeated for this evidence file, per instructions.
- The wall list is exactly ONE entry, matching Task 5's own "no other walls"
  claim; no walls were invented or omitted.
- The `npm test` tally in this file was captured fresh in this task (not
  copied from Task 6), and matches Task 6's tally exactly (412/372/0/39/1),
  confirming no regression across Tasks 6→7.
- The `isDeepStrictEqual(0, -0)` divergence was independently verified by
  reading `libexec/node-shim/modules/util.cjs` line 27 (the `a === b`
  short-circuit before the `Object.is` fallback) rather than asserted from
  the brief text alone.

## Concerns

- The `--version` milestone leaves the entire network/spawn/TUI surface
  unexercised; M3's headless round-trip is a materially larger jump in surface
  area than M2 was, and several of its gates (worker-thread stack safety,
  `tjs.spawn` shape) are still open design questions rather than known
  quantities.
- The 4MB stack figure remains empirical/tuned to `--version`'s measured
  depth; it is not derived from a worst-case bound on the bundle's call graph.
