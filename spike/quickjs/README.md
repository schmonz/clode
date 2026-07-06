# Universal-binaries phase 1 — measurement tools — NON-PRODUCTION

Evidence-gathering scripts for the gates defined in
`docs/superpowers/specs/2026-07-05-universal-binaries-phase1-design.md`.
Nothing here ships, nothing is wired into clode, nothing runs in the test
suite. Scripts are deterministic and re-runnable so a future quickjs-ng /
txiki release (or newly acquired hardware) can be re-scored by re-running
them; results live in `results/` and are committed as evidence.

Layout:
- `PINS.md`          — exact versions/SHAs every result was measured against
- `vendor/`          — quickjs-ng + txiki checkouts/builds + dist tarballs (gitignored)
- `syntax/`          — Gate 1 micro-tests + bundle parse gate (with esbuild fallback)
- `inventory.cjs`    — Gate 2 Node-API surface scanner (runs under node)
- `probe.js`         — capability probe incl. endianness/KAT (runs under qjs/tjs/node)
- `measure-mem.sh`   — Gate 3 memory axis (peak RSS; macOS + NetBSD)
- `qemu/`            — Gate 3 anita driver, guest build script, RUNBOOK.md
- `boot/`            — Gate 4 CJS loader (written to graduate into node-shim) + runner
- `results/`         — committed evidence, one file per gate/target
