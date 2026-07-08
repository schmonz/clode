# Phase 2 · M4 — live subscription round-trip under tjs, inside the NetBSD/aarch64 guest

**Status (2026-07-07): PASSING — 3/3 oracle runs print `PONG`, exit 0.** The real
Claude Code bundle (2.1.202), running under a **patched tjs built inside the
NetBSD 10.1/evbarm-aarch64 qemu guest** (HVF, phase-1 anita machinery),
authenticated by the user's **subscription via the file credential store**
(`~/.claude/.credentials.json` — no API key, no Keychain), completed the live
`-p 'say PONG'` round-trip against `api.anthropic.com` on every attempt.
Driver exit 0; whole guest run (boot → pkg_add incl. gcc12 → payload fetch →
full tjs build → 3 live oracles → halt) ≈ **21 minutes** wall-clock.

**Auth-mode note:** the phase-2 design's M3/M4 wording assumed
`ANTHROPIC_API_KEY`; this box has no key, and M3b (darwin) already moved the
milestone to the subscription path. On non-darwin the bundle reads the file
store, so the guest seeds `/root/.claude/.credentials.json` (0600) from the
host's Keychain credential — served loopback-only during the run and deleted
after.

## How to reproduce

```sh
spike/quickjs/qemu/stage-m4.sh          # payload + credential (Keychain prompt)
python3 -m http.server 8080 --bind 127.0.0.1 --directory spike/quickjs &
spike/quickjs/vendor/venv/bin/python spike/quickjs/qemu/run-in-guest.py \
  evbarm-aarch64 /private/tmp/qemu-anita/anita-aarch64 \
  "$PWD/spike/quickjs/vendor/aarch64-m4-console.log" \
  --script guest-m4.sh --pkgs 'cmake gmake libffi gcc12'
# afterwards: rm /private/tmp/qemu-anita/creds/.credentials.json; kill the server
```

Run detached (`nohup … & disown`) per the RUNBOOK; boots are `snapshot=on`, so
every run redoes pkg_add + build from the pristine installed image.

## Evidence (verbatim from `aarch64-m4-console.log`, 2026-07-07 ~22:04 EDT)

```
+ echo tjs-build-exit=0
tjs-build-exit=0
+ ./txiki.js/build/tjs eval 'console.log("spawn_sync:", typeof __tjs_spawn_sync, "fs_sync:", typeof __tjs_fs_sync)'
spawn_sync: function fs_sync: object
+ cat hosts.frag >>/etc/hosts
+ ./txiki.js/build/tjs eval 'fetch("https://api.anthropic.com/",{method:"HEAD"}).then(r=>console.log("api-status",r.status)).catch(e=>console.log("api-error",String(e)))'
api-status 404
...
=== M4-ORACLE run 1 ===
+ NODE_PATH=/root/m4work/node_modules TERM=vt100 /usr/bin/timeout 300 ./txiki.js/build/tjs run /root/m4work/node-shim/loader.cjs /root/m4work/cli.cjs -p 'say PONG' </dev/null
Warning: no stdin data received in 3s, proceeding without it. ...
PONG
m4-run-1-exit=0
=== M4-ORACLE run 2 ===   → PONG, m4-run-2-exit=0
=== M4-ORACLE run 3 ===   → PONG, m4-run-3-exit=0
=== GUEST-DONE ===
```

(`api-status 404` is the *reachability* probe passing: lws TLS + the embedded
CA bundle + the IPv4 `/etc/hosts` pin all work; 404 is simply what `HEAD /`
returns on that host. The stdin warning is the same benign launcher cosmetic
seen on darwin and Windows.)

## Build walls hit and closed (runs 1–7, one root-caused fix each)

1. **AppleDouble/xattr tarball poisoning (run 1).** bsdtar recorded
   `com.apple.provenance` xattrs; NetBSD tar exits nonzero failing to restore
   them, and the guest's `tar … && tar …` chain silently skipped later
   payloads. Fixed: `--no-xattrs` at staging; un-chained extractions behind
   explicit dir checks in `guest-m4.sh`.
2. **`deps/ada` needs C++20 constexpr `std::string` (runs 1–2).** The
   documented phase-1 gate-3 wall: base g++ 10.5 can't build ada. Fixed as the
   design prescribed: **pkgsrc gcc12** (`gcc12-12.5.0nb1`, no binary deps,
   +126MB in the mirror; driver grew `--pkgs`).
3. **mimalloc 3.2.7 cannot compile on NetBSD — upstream regression (run 2).**
   Its `#if defined(__NetBSD__)` options-table entry (the only per-OS special
   case in the table) still names `mi_option_eager_commit_delay`, renamed
   upstream to `mi_option_deprecated_eager_commit_delay`; NetBSD is the only
   platform where that line compiles, so nobody noticed. **Upstream-report
   candidate (mimalloc).** Guest builds `-DBUILD_WITH_MIMALLOC=OFF` (system
   malloc; recorded divergence, same class as WASM-off).
4. **`#pragma region` under `-Werror` (run 3).** `text-coding.c`/`mod_ffi.c`
   use the clang/MSVC folding pragma; gcc errors via `-Wunknown-pragmas`
   (breaks ANY gcc -Werror build, not just NetBSD). Guest strips `-Werror`
   (a `sed` on CMakeLists before configure); gcc's 25 remaining warnings stay
   visible in the log as findings. **Upstream candidate (txiki).**
5. **Three genuine NetBSD portability bugs in txiki src (runs 4–6)** — now the
   committed **`patches/txiki-netbsd-portability.patch`** (upstream-PR
   candidate, provenance in PINS.md):
   - `mod_dns.c`: `AI_V4MAPPED` — RFC 3493 flag NetBSD never implemented;
     shimmed to 0 when undefined.
   - `mod_posix-socket.c`: `SO_DOMAIN`/`SO_PROTOCOL` getsockopts in the
     non-Apple branch (Linux/FreeBSD extensions); `#ifdef`-guarded like the
     file's own constants table.
   - `mod_ffi.c`: `LIBC_NAME`/`LIBM_NAME` OS switch had no NetBSD branch
     (`#error 'unknown os'`); added sonames `libc.so.12`/`libm.so.0`
     (unversioned `.so` symlinks are comp.tgz-only).
   Full-tree sweeps closed the class: socket/dns/netdb constants cross-checked
   against NetBSD 10's real headers (no other unguarded uses), and
   `mod_ffi.c:1260` was the only OS-switch `#error` in `src/`.

Walls that were **pre-planned and never bit**: sync-spawn `cwd` EINVAL (the
`addchdir_np` guard — the bundle's auth path needed no cwd-bearing sync spawn
on NetBSD), C-stack headroom (`ulimit -s 16384` applied; no overflow), slirp
IPv6-first DNS (hosts.frag pinned `api.anthropic.com`/`console.anthropic.com`
to IPv4 before any bundle fetch).

## Divergences vs the darwin M3b build (all deliberate, all recorded)

| Axis | darwin (M3b) | NetBSD guest (M4) |
|---|---|---|
| Compiler | Apple clang | pkgsrc gcc12 (base g++ 10.5 can't build ada) |
| `-Werror` | on | stripped (clang-only pragmas + gcc pedantry) |
| mimalloc | on | OFF (mimalloc 3.2.7 broken on NetBSD upstream) |
| WASM/wamr | on | OFF (wamr has no NetBSD port; phase-1 precedent) |
| Credentials | macOS Keychain (`security`) | file store `~/.claude/.credentials.json` |
| DNS | system | `/etc/hosts` IPv4 pins (slirp IPv6-first breakage) |
| Source | pristine + 4 patches | + `txiki-netbsd-portability.patch` (5 total) |

## Residuals / follow-ups

- **Upstream queue grew:** mimalloc NetBSD compile regression (report),
  txiki `#pragma region`-vs-gcc (`-Werror`) (report/PR), and
  `txiki-netbsd-portability.patch` (PR) — join the already-prepared
  js_exepath/repl-eof-spin/sync-fs/sync-spawn/no-origin submissions awaiting
  the user's go-ahead.
- The **latent darwin fd-race oracle** applies here too: re-run this M4 recipe
  (or at least the darwin M3b oracle) on any bundle bump or tjs/libuv re-pin.
- The guest oracle runs use the **snapshot** boot: nothing persists in the
  guest; the credential file lives only for the run and is deleted host-side
  afterwards (done for this run).

## Pointers

- Console log: `spike/quickjs/vendor/aarch64-m4-console.log` (+ `.run1`–`.run6`
  failure logs) — uncommitted scratch, on the dev box.
- Scripts: `spike/quickjs/qemu/{stage-m4.sh,guest-m4.sh,run-in-guest.py}`.
- Patch provenance: `spike/quickjs/PINS.md`; darwin milestone:
  `results/phase2-m3b-subscription-auth.md`; phase-1 guest bring-up:
  `results/gate3-netbsd-aarch64.md`, `qemu/RUNBOOK.md`.
