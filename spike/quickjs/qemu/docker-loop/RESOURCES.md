# NetBSD/sparc cross-fuse — per-phase resource requirements

Measured on qemu-sun4m **SS-20 @ 512M RAM** (the SPARCstation-20 hardware
ceiling; SS-5 caps at 256M) under **TCG** on a linux/x86_64 Docker daemon.
Wall times are TCG (~10-20x slower than metal). Peak-RSS figures for the engine
phases are from `spike/quickjs/results/phase3-sparc-engine-verdict.md` (bundle
2.1.204, cli.cjs 19,106,804 B); the extraction figure is from the docker-loop
wall-walk (2026-07-14). Refresh from the `PROGRESS t=…` heartbeat in
`fuse-pong.sh` (clode RSS + swap) cross-referenced with clode's `CLODE_VERBOSE`
phase markers.

## Host side (linux/x86_64 container — fast, not resource-constrained)

| phase | tool | notes |
|---|---|---|
| build linux host `tjs` | cmake/ninja/gcc | `build-linux-tjs.sh`, ~3-5 min, native |
| build clode-main bundle | esbuild | `build-bundle.mjs`, seconds; **MUST be fresh** (stale bundle → fused-runtime skew → `statSync` crash in `extractIfNeeded`) |
| cross-fuse clode --self | node + linux tjs worker | seconds; byte-append onto the sparc template |

## Guest side (sparc, SS-20 @ 512M) — the constrained budget

Wall times below marked "(this host)" are on the 2013 Xeon boot2docker daemon —
TCG here is ~3-4x slower than the original campaign's bench, so use them as an
upper bound, not an absolute.

| phase | peak RSS | wall (TCG) | fits 512M? | notes |
|---|---|---|---|---|
| boot NetBSD 10.1 sun4m | — | ~30-60s | yes | 495M total / 480M avail |
| fetch provider (:8180) | — | 17M @ ~5 MiB/s ≈ 4s | — | use claude-min (17M), NOT the 240M binary |
| **materialize fused payload** (write ~397 members: node-shim + libexec + node_modules + 6.4M template to guest FS) | ~40M | **~300s (this host)** | yes | SILENT under TCG — the meter's first ~5 min; a real, previously-unaccounted phase |
| extract JS (carve cli.cjs from **claude-min** 17M) | ~55M | ~20-40s | yes | with the 240M binary this OOMs (>512M) + takes >35min — DO NOT use the full binary in-guest |
| syntax-check extracted cli.cjs (`vm.Script` parse 19M) | ~72M | ~tens s | yes | in-process node --check equivalent |
| **fuse worker** = compile+serialize cli.cjs (canonical-LE writer) **+ collect+sha256 397 members + write 31.7M archive** | **~216M compile peak, ~315M during assemble** | **the dominant cost — many minutes (this host); worker stdout is CAPTURED not streamed, so it is SILENT throughout** | yes (a ~10M spike into swap during assemble) | phase3's "93s compile" is compile-ONLY; the real worker cost is compile + member sha + archive write |
| PONG smoke (run quaude bytecode, in-proc mock) | ~215M during the turn | ~1-2 min (this host) | yes | a full Claude Code `-p` turn, not a bare load |
| attest (boot quaude + verify 397 member shas) | ~128M | ~1-4 min (this host) | yes | second quaude spawn |
| cleanup (rmSync materialized payload) | small | ~tens s | yes | slow TCG fs unlink |

### Observability learnings (from the meter)
- **`ps` RSS must include the WORKER**, not just `clode-sparc`: the compile/assemble
  run in the spawned `template-tjs` worker (and the smoke/attest in `quaude`
  children), so a `grep clode-sparc` shows a flat parent while the real work is
  elsewhere. Widen the sampler to `clode-sparc|template-tjs|quaude|tjs`.
- **External liveness**: `docker stats` on the qemu container — CPU ~100% == the
  TCG core is busy (working, not hung). The cheapest "is it alive" check.
- **`free_kb` via `vmstat NR==3 $5` is WRONG** on NetBSD (small bogus number);
  read swap (`swapctl -lk`) + the ps RSS instead, or fix the vmstat column.
- **BSD `^T`/SIGINFO** (NetBSD/BSD/macOS only, no Linux): drive from the driver
  (pexpect sends `\x14` on a timer) to get the kernel status line with the
  foreground process's advancing **CPU time** — distinguishes "slow" from "stuck"
  better than RSS. TODO in `ci-sparc-driver.py`.

## Takeaways for the CI leg (build-leg qemu-* recipe)

1. **Swap is mandatory** for the in-guest provider extraction: add ≥1.5G file
   swap before `clode build`, else "out of swap" kill. (Alternative: pre-extract
   the bundle on the x64 runner and pre-seed clode's per-version cache —
   `clodeCacheDir/<key>/{cli.cjs,bun-shim.cjs,.extractor-sig}`; the cache-hit
   check is provider-binary-independent — then the guest never carves 240M.)
2. **Compile fits at 512M** (213M peak, 2.2x headroom) — no extra RAM needed once
   extraction is handled.
3. **Timeouts**: `CLODE_TIMEOUT_SCALE=20` for the fuse worker; driver silence
   timeout ≥3600s covers the silent extract/compile stretches under TCG.
4. **Observability**: the silent phases need the `PROGRESS t=` heartbeat (or a
   clode-side intra-phase verbose meter — see follow-up) to distinguish work
   from hang.

## Follow-up (product, not harness)

Add an intra-phase progress meter to clode's `CLODE_VERBOSE`: extraction (bytes
scanned / total), compile (a periodic heartbeat), so a human watching a CI log
sees liveness during the multi-minute silent phases instead of guessing.
