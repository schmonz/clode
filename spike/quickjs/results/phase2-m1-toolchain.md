# Phase 2 · M1 — toolchain real jobs under tjs (PROOF)

**Milestone claim:** clode's own toolchain modules (`libexec/clode-net.cjs`,
`libexec/extract-claude-js.cjs`) run REAL jobs under the patched `build/tjs/tjs`
via the node-shim loader, producing output **identical to host node**.

- Host node: `node` (v26.3.0 / pkgsrc, this box) — reference oracle.
- tjs: `build/tjs/tjs` (patched with `__tjs_fs_sync`) + `libexec/node-shim/loader.cjs`.
- Date: 2026-07-06.

Task 8 added two shims — `modules/vm.cjs` (Script = syntax-check-only via
`new Function`; `runInThisContext` is a fail-loud wall) and `modules/module.cjs`
(`createRequire` over the loader's own `makeRequire`) — plus one loader
behavioral fix (`require.main`, see Wall 2) and one fs/buffer behavioral fix
(latin1 round-trip, see Wall 1). Every behavioral fix is test-first.

---

## Rung 1 — clode-net.cjs real job

`clode-net.cjs` is a MODULE (`module.exports = { downloadFile, sha256Of }`), NOT
a CLI (no `require.main` block), so it is driven by a tiny script that
`require()`s it and calls the exports, run under BOTH tjs and node.

### Commands

```
# known digest
$ printf 'clode' | shasum -a 256
300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c  -

# node (oracle)
$ node rung1-driver.cjs input.txt payload.bin copy-node.bin
sha256=300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c
download=true
copy_sha256=3b223779ea54952fd36d6f497bb58cf05b92893004fa6b833a8c614f44afd9ab

# tjs + node-shim loader
$ build/tjs/tjs run libexec/node-shim/loader.cjs rung1-driver.cjs input.txt payload.bin copy-tjs.bin
sha256=300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c
download=true
copy_sha256=3b223779ea54952fd36d6f497bb58cf05b92893004fa6b833a8c614f44afd9ab
```

### Result

- `sha256Of('clode')` under tjs == host node == the known digest
  `300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c`. **MATCH.**
- `downloadFile('file://payload.bin', dest)` — the `file://` copy under tjs is
  **byte-identical** to the source AND to node's copy
  (`copy_sha256=3b223779…`, incl. embedded NUL/`\x00\x01\x02` bytes, so binary
  safety is proven). **BYTE-IDENTICAL.**

### Walls hit in Rung 1

**None.** `sha256Of` (crypto.createHash sha256 over fs.readFileSync bytes) and
the `file://` branch (fs.copyFileSync) already worked through the Task-6/7 shims.

Committed as `test/node-shim-toolchain.test.cjs` › *Rung 1*.

---

## Rung 2 — extract-claude-js.cjs real job

### Input used: SYNTHETIC (faithful minimal Bun fixture)

There is **no native `claude` binary** in this environment:
`~/.local/share/clode/providers/*/claude` is empty, and the cached
`~/.cache/clode/2.1.198/cli.cjs` is EXTRACTED OUTPUT (not valid extractor
input). A real 240MB provider binary was not fetched (network-gated; the memory
ceiling is an M4/mac68k concern, explicitly a non-issue on this darwin/arm64
box, but a real fetch was out of scope for a cheap proof here).

Per the brief's sanctioned fallback, Rung 2 uses a **faithful minimal Bun
`--compile` fixture** (`mkBunFixture()` in the committed test): a NUL-terminated
`entrypoints/cli.js` name followed by a
`// @bun ... @bun-cjs\n(function(exports, require, module, __filename, __dirname) { <body> })`
block terminated by NUL. The body carries two `import.meta` forms (`.url` and a
bare `import.meta`), the `commander` sentinel, and >1MB of padding so the
extractor's `contentChecks` (MIN_OUTPUT_BYTES = 1e6) passes. This exercises the
REAL extractor code paths: `carveBlocks` → `pickEntry(entrypoints/cli.js)` →
`import.meta` rewrite → PRELUDE prepend → `verify` + `contentChecks`, and — via
the loader fix — `main()` firing on `require.main === module`.

> **M2 item:** full 240MB real-native-binary extraction under tjs (obtain a real
> darwin-arm64 provider binary; confirm carve at scale). Not exercised here.

### Commands

```
$ node mkfixture.cjs fake-claude.bin      # 1100267-byte synthetic Bun binary

# node (oracle) — runs as entry (require.main === module -> main())
$ node libexec/extract-claude-js.cjs fake-claude.bin out-node.cjs
  ...4x "clode: /doctor|autoupdater hook NOT applied" warnings (synthetic input
     has none of the real anchors — expected, best-effort, non-fatal)...
entry=entrypoints/cli.js
wrote out-node.cjs (1101553 bytes)

# tjs + node-shim loader — same, main() fires via the require.main fix
$ build/tjs/tjs run libexec/node-shim/loader.cjs libexec/extract-claude-js.cjs fake-claude.bin out-tjs.cjs
  ...IDENTICAL 4x warnings + "entry=entrypoints/cli.js" + "wrote out-tjs.cjs (1101553 bytes)"...

$ shasum -a 256 out-node.cjs out-tjs.cjs
e165be3bc50b594c0d57d4fd3636f81970c823cc7a2b7b9220748e9bfd49101c  out-node.cjs
e165be3bc50b594c0d57d4fd3636f81970c823cc7a2b7b9220748e9bfd49101c  out-tjs.cjs
$ cmp -s out-node.cjs out-tjs.cjs && echo BYTE_IDENTICAL=yes
BYTE_IDENTICAL=yes
```

### Result

- Extractor output under tjs is **BYTE-IDENTICAL** to host node:
  both 1101553 bytes, sha256
  `e165be3bc50b594c0d57d4fd3636f81970c823cc7a2b7b9220748e9bfd49101c`.
- Both stderr streams are identical (same 4 non-fatal anchor-miss warnings +
  the `entry=`/`wrote` lines from `main()`), confirming `main()` ran under tjs.

Committed as `test/node-shim-toolchain.test.cjs` › *Rung 2*.

### Walls hit in Rung 2 — and their fixes

**Wall 1 — `fs.readFileSync(bin, 'latin1')` / `Buffer.from(text, 'latin1')`
(latin1 byte round-trip).**
The extractor's entire design is the latin1 round-trip (1 char == 1 byte, so
byte regexes become string regexes). The fs shim only handled `utf8`, so
`readFileSync(bin, 'latin1')` returned a `Uint8Array`, and `data.matchAll(...)`
in `bundle-carve.cjs` threw `TypeError: not a function` (Uint8Array has no
`matchAll`). Symmetrically `Buffer.from(text, 'latin1')` fell through to UTF-8,
which would corrupt every byte ≥ 0x80.
*Fix (test-first, `test/node-shim-fs.test.cjs` › latin1 row):*
- `modules/fs.cjs`: `readFileSync`/`promises.readFile` now decode `latin1`/
  `binary` via a chunked `String.fromCharCode` (chunked so a multi-MB binary
  doesn't blow the argument limit).
- `internal/buffer-lite.cjs`: `Buffer.from(str, 'latin1'|'binary')` maps
  `charCodeAt(i) & 0xff` per byte; `Buffer.toString('latin1'|'binary')` added
  for symmetry.
Characterization writes all 256 byte values ×2, reads `'latin1'`, re-encodes
`Buffer.from(s,'latin1')`, and asserts byte-equality vs node.

**Wall 2 — `require.main` (the extractor's `if (require.main === module) main()`).**
The Task-3 loader created a fresh `require` per module with no `.main`, so
`require.main === module` was `false` for the entry and `main()` never fired —
the extractor as entry did nothing.
*Fix (test-first, `test/node-shim-loader.test.cjs` › require.main row):* the
loader now tracks a single `mainModule` (the entry module object, set when the
entry is evaluated) and every `require` exposes a live `require.main` getter
returning it — faithful node semantics: the entry sees `require.main === module`
true, a required child sees it false. This is the faithful toolchain invocation
(the extractor runs as a real entry) AND a genuine node-compat win the M2 bundle
needs; preferred over driving the exported `main(argv)`. All prior shim tests
stay green.

---

## npm test

Full suite green — see the commit's report for the tally. New shim tests:
`node-shim-vm-module.test.cjs` (2), `node-shim-toolchain.test.cjs` (Rung 1 + 2),
plus the require.main row and the fs latin1 row.

---

## Divergences

- **vm.Script is syntax-check-only.** `new vm.Script(src)` parses `src` via
  `new Function(src)` — it detects `SyntaxError` (matches node for the
  extractor's syntax gate) but parses in sloppy/function context, not true
  Script/program context, and `runInThisContext()` is a **fail-loud wall**
  (`node-shim: vm.Script.runInThisContext not implemented`). Adequate for M1
  (the toolchain only needs the syntax gate); real sandbox/eval semantics are an
  M2+ concern.
- **`require.main` is loader-synthesized**, not a real Module instance. It is the
  entry module object (`{ exports, filename }`); identity comparison
  (`require.main === module`) and `.filename` are correct — the surface the
  toolchain (and Bun-prelude's `require.main === module`) actually reads. Other
  node `Module` fields (`.children`, `.paths`, `.loaded`, `.id`) are absent.
- **`process.nextTick` ordering:** not separately re-characterized in Task 8;
  Rung 1's async `downloadFile` (real `await` over the `file://` sync copy)
  resolved in-order and matched node byte-for-byte. No divergence observed.
- **Extractor stderr anchor-miss warnings** appear (4×) because the SYNTHETIC
  fixture has none of the real Claude doctor/autoupdater anchors. This is the
  extractor's own best-effort/non-fatal behavior and is IDENTICAL under node and
  tjs — not a shim divergence. A real bundle would match those anchors.
- **latin1 decode is manual** (chunked `String.fromCharCode`) rather than
  `TextDecoder('latin1')`; produces node-identical bytes (proven by the 256-byte
  round-trip + the byte-identical extractor output).
