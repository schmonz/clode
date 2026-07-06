# qemu guest runbook — build + probe a NetBSD guest (Gate 3)

> **TARGET SUBSTITUTION (user decision 2026-07-06):** the amd64/TCG rung was
> replaced mid-task by **NetBSD/evbarm-aarch64 10.1 under HVF** — OS evidence
> (NetBSD + pkgsrc + base toolchain) is equivalent, x86-on-arm TCG bought
> hours of emulation for no extra signal, and the ISA-diversity need is
> carried by the mac68k rung (Task 9). The amd64 automation learnings below
> are retained and the amd64 path stays runnable (it got as far as a fully
> installed image + root shell; it was abandoned for cost, not for a wall).
> evbarm-aarch64 also skips sysinst entirely: anita dd's the pre-installed
> `binary/gzimg/arm64.img.gz` onto the disk image and boots the GENERIC64
> kernel directly.

Exact working commands, as actually run on darwin/arm64 (qemu at
/opt/pkg/bin; aarch64 guests run near-native under HVF, x86 guests are TCG
emulation and slow). Every place reality differed from the task brief is
called out inline as **DRIFT**.

All paths relative to the repo root. `vendor/` is uncommitted scratch.

## 1. venv + anita

**DRIFT (NFS venv):** plain `python3 -m venv` + ensurepip on this NFS mount
silently drops files during pip's thousands-of-small-files bootstrap copy
(`pip._internal.utils` missing, etc.). Skip pip inside the venv and borrow the
host's; only anita+pexpect then need to be written to the mount:

```sh
COPYFILE_DISABLE=1 python3 -m venv --system-site-packages --without-pip spike/quickjs/vendor/venv
```

**DRIFT (wrong anita):** `pip install anita` (per the brief) installs an
unrelated PyPI package — "ANITA", a logic-proof teaching assistant. The real
Automated NetBSD Installation and Test Application is Andreas Gustafsson's,
from gson.org (newest at time of writing: 2.18):

```sh
COPYFILE_DISABLE=1 spike/quickjs/vendor/venv/bin/python -m pip install \
  pexpect http://www.gson.org/netbsd/anita/download/anita-2.18.tar.gz
spike/quickjs/vendor/venv/bin/python -c "import anita, pexpect"  # must succeed
```

Host tools anita uses on darwin: `qemu-system-x86_64`, `qemu-img` (PATH),
`hdiutil makehybrid` (native; builds the install ISO from downloaded sets).

## 2. Stage dist tarballs + bundle

```sh
mkdir -p spike/quickjs/vendor/dist
QJS_TAG=$(awk '$1=="quickjs-ng"{print $2; exit}' spike/quickjs/PINS.md)
TJS_TAG=$(awk '$1=="txiki.js"{print $2; exit}' spike/quickjs/PINS.md)
curl -fsSL -o "spike/quickjs/vendor/dist/quickjs-ng-$QJS_TAG.tar.gz" \
  "https://github.com/quickjs-ng/quickjs/archive/refs/tags/$QJS_TAG.tar.gz"
# txiki tag-tarballs exclude submodules — tar the host checkout (has them).
# COPYFILE_DISABLE=1 + --exclude '._*' both, or AppleDouble sidecars poison
# the guest's CMake source globs (Task 5 lesson; PINS.md caveat).
COPYFILE_DISABLE=1 tar -czf "spike/quickjs/vendor/dist/txiki-$TJS_TAG.tar.gz" \
  -C spike/quickjs/vendor --exclude 'txiki.js/build' --exclude 'txiki.js/.git' \
  --exclude '._*' txiki.js
COPYFILE_DISABLE=1 cp "$(ls -t "${XDG_CACHE_HOME:-$HOME/.cache}"/clode/*/cli.cjs | head -1)" \
  spike/quickjs/vendor/dist/cli.cjs
# verify: tar tzf ...txiki... | grep -c '/\._'  must print 0
```

## 2b. Host-side pkgsrc mirror (guest->internet is DEAD through slirp)

**DRIFT (slirp outbound: IPv6-preferred, IPv4-only-works):** guest->host
(10.0.2.2) TCP always works. Direct guest->CDN fetches *appear* dead
(nettop on the qemu process: bytes_out>0, bytes_in=0; pkg_add stalled
forever on both the amd64 and aarch64 rungs). The in-guest diagnostic
showed the real mechanism: slirp's DNS (10.0.2.3) resolves A **and** AAAA
records, NetBSD tries the IPv6 addresses first, and slirp cannot route
IPv6 — each address burns a long connect timeout before IPv4 fallback
eventually succeeds. So outbound IPv4 works but any multi-address fetch
crawls or times out. The durable fix is to stop depending on
guest->internet: pre-download the package dependency closure on the HOST
and serve it over the known-good path. The driver still runs a bounded
in-guest diagnostic (`nslookup` + `ftp -q 15` against the CDN) as
evidence, and passes `PROBE_NET=0` to the guest script when even bounded
outbound fails, so probe.js's fetch-tls exercise reports a skip instead of
hanging the run.

```sh
curl -fsSL -o /tmp/pkg_summary.gz \
  http://cdn.netbsd.org/pub/pkgsrc/packages/NetBSD/aarch64/10.1/All/pkg_summary.gz
mkdir -p spike/quickjs/vendor/dist/pkgs/aarch64
# pkg-closure.py: ~60-line throwaway resolver — parses PKGNAME/DEPENDS out
# of pkg_summary, picks max version per pkgbase, walks the closure.
# cmake+gmake+libffi -> 13 packages, ~28MB (cmake pulls the
# curl/libuv/rhash/libxml2/nghttp2/zstd/lz4/libidn2/libunistring/xmlcatmgr
# chain).
for p in $(python3 pkg-closure.py /tmp/pkg_summary.gz cmake gmake libffi); do
  curl -fsSL -o spike/quickjs/vendor/dist/pkgs/aarch64/$p.tgz \
    http://cdn.netbsd.org/pub/pkgsrc/packages/NetBSD/aarch64/10.1/All/$p.tgz
done
find spike/quickjs/vendor/dist -name '._*' -delete  # sidecars poison pkg_add's index glob
```

Guest side (the driver does this):
`PKG_PATH=http://10.0.2.2:8080/vendor/dist/pkgs/aarch64 pkg_add cmake gmake libffi`
— pkg_add resolves name globs and dependencies against python http.server's
directory index just fine. libffi IS required from packages by txiki
(`BUILD_WITH_FFI` defaults ON and REQUIREs the system lib — not vendored in
deps/, unlike mbedtls/sqlite3 etc.); the closure is small, keep it.

## 3. Host file server (guest reaches it at 10.0.2.2:8080)

```sh
python3 -m http.server 8080 --directory spike/quickjs \
  > spike/quickjs/vendor/http-server.log 2>&1 &
# kill it when the guest run is done
```

Guest networking is qemu's *default* user-net NIC: anita 2.18 passes no
network args at boot, and qemu supplies an implicit e1000 (`wm0` in the
guest) on user-mode NAT. `dhcpcd` in the guest gets 10.0.2.15.

## 4. Install + run the guest

**DRIFT (workdir must be on a LOCAL filesystem):** a workdir under
`spike/quickjs/vendor/` (this NFS mount) dies at first qemu boot with
`Failed to lock byte 100: Operation not supported` — qemu takes byte-range
locks on its disk images and this NFS mount doesn't support them. Use any
local directory (~10GB free: 8G dense wd0.img + sets + install ISO). The
console log on NFS is fine.

```sh
WORK=/private/tmp/qemu-anita/anita-aarch64   # LOCAL disk, not NFS
mkdir -p "$WORK"
spike/quickjs/vendor/venv/bin/python spike/quickjs/qemu/run-in-guest.py \
  evbarm-aarch64 "$WORK" spike/quickjs/vendor/aarch64-console.log --install
```

(Substitute `amd64`/`mac68k` and matching workdir/log names for other rungs.)

Everything (anita's console mirror, qemu stderr, driver markers) lands in
the console log. `tail -f` it; the run is done at `guest run complete`
after the guest printed `=== GUEST-DONE ===`.

**DRIFT (evbarm-aarch64 under HVF — three interlocking qemu fixes),** all
implemented as the `arch == 'evbarm-aarch64'` block in `run-in-guest.py`:
1. anita's `arch_vmm_args()` emits `-cpu cortex-a57` AFTER caller
   `vmm_args`, and HVF only supports `-cpu host` — appending
   `-accel hvf -cpu host` is NOT enough (the later cortex-a57 wins and
   qemu refuses to start). The driver shadows the instance method.
2. The shadow must preserve the `-kernel <workdir>/netbsd-GENERIC64.img`
   pair that `arch_vmm_args()` appends for image-based ports: without it
   qemu exits instantly (`-append` without `-kernel` is a qemu error) and
   anita's expect dies with EOF. Bonus anita behavior: when `install()`
   fails this way it deletes `wd0.img` on its way out, so the next
   `--install` correctly redoes the (fast) image dd.
3. `-device virtio-rng-pci`: the qemu virt machine has no RNG source and
   NetBSD 10 stalls at boot on "Waiting for entropy... (dd) waiting for
   entropy(7)" before reaching login. Likely relevant to the mac68k rung
   too if its kernel waits for entropy (q800 has no virtio; a different
   trick will be needed there).

Boot-only reruns after a successful install: same command without
`--install` (it would be skipped anyway — `install()` returns early if
`wd0.img` exists; conversely after a FAILED install you must `rm wd0.img`,
or the partial image is mistaken for a completed install). Boots run qemu
with `snapshot=on` (anita default, `persist=False`): guest changes are
discarded at exit, so every run redoes dhcpcd/pkg_add and a crashed run
can never dirty the installed image.

**DRIFT (launch detached, poll the log):** run the driver under
`nohup sh -c '<driver>; echo driver-exit=$? > .../driver-exit.txt' &` +
`disown` — harness/session-managed background jobs were reaped after ~10
minutes, taking qemu down mid-install. Poll the console log and the
`driver-exit.txt` marker; never hold a session open on the driver.

**DRIFT (dhcpcd races its own lease):** the brief's plain `dhcpcd` forks
to the background *before* the lease arrives; pkg_add then fails with
"Transient resolver failure" and ftp with "Can't assign requested address".
Use `dhcpcd -w` (wait for an address) and prove the gateway path with
`ping -o -w 30 10.0.2.2` before fetching anything.

**DRIFT (hang hazard → watchdog):** one boot-only run wedged forever —
driver blocked in expect at 0% CPU, guest idle at its root prompt, console
log frozen mid-command. The driver now (a) arms a SIGALRM watchdog over
the whole run (amd64 8h, mac68k 48h) that force-kills qemu and exits 2,
(b) retries each setup command 3x, and (c) aborts early (halt + exit 1)
if network/pkg_add/script-fetch never succeed — a build without cmake
would waste hours producing nothing.

**DRIFT (driver, brief -> anita 2.18 reality):**
- The brief's `child = a.boot(); child.expect('login:') ... expect('# ')`
  sketch is both redundant and fragile: `boot()` already waits for the login
  prompt, and raw `expect('# ')` false-matches `#` in build output. anita's
  own `a.shell_cmd(cmd, timeout, keepalive_patterns)` logs in as root, sets a
  unique shell prompt, and returns the command's real exit status — used
  instead, with `keepalive_patterns=[r'\r?\n']` so timeouts mean "max console
  silence", not "max duration" (multi-hour TCG builds would kill any fixed
  overall timeout).
- Log capture is `os.dup2` of the logfile over stdout+stderr (anita mirrors
  the console to stdout; reassigning `child.logfile_read` as sketched would
  fight anita's own multi-writer logging).
- `shutdown -p now` replaced by `a.halt()` (anita knows its own halt-confirm
  patterns and cleanup).
- Added `vmm_args=['-smp', '2']` (guest builds run `-j2`; qemu's default is
  a single vcpu).
- **pkg_add needs `libffi`** in addition to cmake+gmake: txiki's
  `BUILD_WITH_FFI` defaults ON and does `find_library(ffi REQUIRED)`.
  (mbedtls's Python dependency is NOT triggered: GEN_FILES defaults OFF.)
- `PKG_PATH=http://cdn.netbsd.org/pub/pkgsrc/packages/NetBSD/amd64/10.1/All`
  works but redirects server-side to `.../NetBSD/x86_64/10.0_2026Q1/All`
  (pkg_add's libfetch follows it). Recorded in PINS.md.

**DRIFT (guest-build.sh):** dropped the brief's trailing
`cat results/gate3-mem-guest-*.md` — `measure-mem.sh` already cats its
output file; the duplicate block would just bloat the console log.

**DRIFT (txiki on NetBSD needs two build interventions),** both in
guest-build.sh:
1. wamr's `simde.cmake` FetchContent **git-clones simde at configure
   time** — invisible on hosts with git+network, fatal in the guest
   ("could not find git for clone of simde-populate"). Pre-seed it:
   tarball the host checkout's `build/_deps/simde-src` (v0.8.2, exclude
   `.git` and `._*`) into `vendor/dist/simde-v0.8.2.tar.gz`; the guest
   extracts it and passes `-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src`.
2. `-DBUILD_WITH_WASM=OFF`: txiki's CMakeLists maps every
   non-Darwin/Windows/Android system to wamr's "linux" platform, and wamr
   has NO netbsd port (freebsd exists; a `-DWAMR_BUILD_PLATFORM` override
   can't win — txiki's plain `set()` clobbers the cache var). The linux
   layer calls Linux's 4-arg `mremap`; NetBSD's takes 5 → hard compile
   error in `posix_memmap.c`. Upstream txiki portability bug; WASM is not
   exercised by probe.js, so disabling it is honest. Divergence vs the
   darwin control (built with WASM ON) — noted in the result file.

**DRIFT (memory phase vs silence timeouts + a spinning standalone):**
`measure-mem.sh` writes to its results file and only cats at the end, so
the console is silent for the whole phase — it starved the driver's
silence-based timeout and got ^C'd blind on the first attempt. Two-part
fix in guest-build.sh: run it under `sh -x` (each command traced to the
console = keepalive + pinpoints hangs) and inside `(ulimit -t 300; ...)`.
The ulimit matters because of a REAL finding: the `qjs -c` standalone
bundle-exe **spins at 100% CPU on NetBSD/aarch64** (>=14 min observed)
where the same case exits in ~0.4s on darwin — SIGXCPU kills just that
child and `/usr/bin/time -l` still reports its rusage, turning the row
into valid "peak RSS while spinning" ceiling evidence instead of a lost
run.

## 5. Distill results

By hand from `vendor/aarch64-console.log` into
`results/gate3-netbsd-aarch64.md`: HOSTINFO verbatim, build exit codes
(+first errors if nonzero), PROBE sections verbatim, MEMORY section
verbatim, one wall-clock line. Diff probe rows against
`results/gate2-probe-darwin-arm64.md`; every divergence is a finding.

## mac68k (Task 9) heads-up

anita 2.18 has **zero** mac68k support (`grep -c mac68k anita.py` = 0; no
`arch_props` entry, and `Anita.__init__` raises "NetBSD port ... is not
supported"). The m68k leg cannot reuse anita's install path as-is; it needs
either hand-driven `qemu-system-m68k` (machine `q800`) + sysinst expect
scripting, or checking whether a newer anita grew support. The driver keeps
its `ARCHES` table arch-parameterized, but the mac68k row is aspirational
until that's resolved.
