# Gate 3 — NetBSD/mac68k (qemu-q800), the North Star: BLOCKED at boot

**Status: BLOCKED — re-plan trigger.** The North-Star rung could not be run:
`qemu-system-m68k -M q800 -kernel netbsd-INSTALL` **cannot boot a NetBSD
kernel at all**. qemu's q800 `-kernel` loader implements only the Linux/m68k
boot protocol; NetBSD/mac68k requires the MacBSD Booter (a MacOS application
that in turn requires a proprietary Quadra 800 ROM). The wall is hit *before*
sysinst, so the build / probe / memory phases were never reachable. This is
not sysinst intractability (the process-contract "3 attempts" case) — it is a
lower-level boot-protocol incompatibility with no ROM-free, serial-automatable
remedy. Full reproduction and the exact commands are in
`qemu/RUNBOOK.md` § "mac68k (Task 9) — BLOCKED at boot".

Salvaged and committed: the `js_exepath` NetBSD patch (the load-bearing
upstream fix candidate for the run-from-bytecode path, verified to apply to a
clean quickjs-ng v0.15.1 tarball), the q800 RAM-ceiling finding, and the
North-Star axes reading distilled from the darwin control + the
evbarm-aarch64 rung. What is NOT here — because nothing ran on m68k — is any
native-big-endian probe output or any 32-bit memory number.

## The wall (evidence)

Boot attempt (one of several `-serial`/`-append` variants; all identical
result):

```
$ /opt/pkg/bin/qemu-system-m68k -M q800 -m 1000M \
    -drive file=/private/tmp/qemu-mac68k/wd0.img,format=raw,if=scsi,bus=0,unit=0 \
    -kernel /private/tmp/qemu-mac68k/netbsd-INSTALL -append "SERIALCONSOLE" \
    -serial mon:stdio -display none
  (serial log: 0 bytes.  framebuffer screendump: solid white, uninitialised.
   qemu: no load error, PC set to ELF entry — kernel hangs in early boot.)
```

Kernels are genuine big-endian m68k:
`netbsd-INSTALL: ELF 32-bit MSB executable, Motorola m68k, 68020, … for NetBSD 10.1`.

Three independent confirmations of the cause:

1. **NetBSD/mac68k boots from the MacBSD Booter environment, not a Linux
   bootinfo.** `sys/arch/mac68k/mac68k/machdep.c: getenvvars(u_long flag, char
   *buf)` requires `flag & 0x80000000` set and `buf` → a
   `"var=val\0var=val\0…\0\0"` env; `consinit()` then reads
   `serial_console = getenv("SERIALCONSOLE")` and the video params
   (`VIDEO_ADDR`, `DIMENSIONS`, `ROW_BYTES`, `SCREEN_DEPTH`) from that same
   env. No env buffer ⇒ every `getenv()` returns 0 ⇒ garbage video config ⇒
   dead console (the white screen), and `SERIALCONSOLE` can never be set.
2. **qemu 11's `hw/m68k/q800.c` `-kernel` path writes only the Linux/m68k
   `BI_*` bootinfo** (`BI_MACHTYPE, BI_MAC_VADDR, BI_MAC_SCCBASE,
   BI_COMMAND_LINE, BI_RAMDISK, …`). It never constructs the NetBSD
   `var=val\0` env and never sets the `0x80000000` flag; `-append` lands only
   in `BI_COMMAND_LINE`, which `getenvvars()` never reads. qemu's
   NetBSD-specific bits (`via1_adb_netbsd_enum_hack`, the `"Create alias for
   NetBSD"` ESCC alias) exist for NetBSD running *via the Booter on a real
   ROM*, not for `-kernel`.
3. **Every field recipe uses the ROM + Booter.** qemu wiki / E-Maculation /
   Wikistix / port-mac68k all install NetBSD/mac68k by booting MacOS from a
   `Quadra800.rom`, launching the Booter, and ticking its "serial console"
   box (the checkbox that writes `SERIALCONSOLE` into the Booter env). qemu's
   own `tests/functional/test_m68k_q800.py` boots a **Debian/Linux** m68k
   kernel (`console=ttyS0 vga=off`), never NetBSD.

The Quadra 800 ROM is non-redistributable Apple firmware (absent here), and
driving the MacOS Booter GUI to install NetBSD is a graphical, non-serial,
non-scriptable process. **No ROM-free path exists**, so this rung is
unreachable under qemu as specified.

## Machine facts recorded

- **q800 RAM ceiling = 1024 MiB.** `-m 2G` →
  `Too much memory for this machine: 2048 MiB, maximum 1024 MiB`. `-m 1000M`
  accepted. (This was the memory-reality datum the task asked for; the
  in-guest bytecode-compile-vs-RAM question below it is unanswerable without a
  bootable guest.)
- Assets fetched and staged fine (kernels, `base/etc/comp/text/kern-GENERIC`
  sets, sidecars stripped, CDN-layout mirror under the served tree) — none of
  it was ever consumed, because nothing booted.

## The `js_exepath` NetBSD patch (delivered)

`patches/quickjs-ng-js_exepath-netbsd.patch` adds a NetBSD implementation of
`js_exepath()` (sysctl `KERN_PROC_ARGS`/`KERN_PROC_PATHNAME` for the current
process, `/proc/curproc/exe` fallback) to `cutils.h`, mirroring libuv's
`uv_exepath()`. Verified: applies cleanly (`patch -p1`, dry-run and real,
exit 0) to a fresh `quickjs-ng-v0.15.1.tar.gz` extraction.

This is the fix for the Gate-3 finding root-caused on the aarch64 rung
(`gate3-netbsd-aarch64.md` § "qjs -c standalone spin — root cause"): without a
NetBSD `js_exepath`, a `qjs -c` standalone silently degrades to the REPL on
*any* BSD and busy-spins poll+read(→0) on EOF stdin — which is exactly why the
aarch64 rung could not measure run-from-bytecode and had to bound it with
`ulimit -t`. The patch is what turns the load-bearing run-from-bytecode
measurement back on. It was intended to be applied to the m68k guest's source
before building; it is committed here so the next attempt (m68k via ROM, or a
retargeted BE rung) applies it as a pin. It is equally the upstream fix
candidate and would un-break the aarch64 standalone if that rung is re-run.

## North-Star axes (read from available evidence; m68k-native rows BLOCKED)

The three axes the North Star turns on, answered as far as the existing
darwin control (`gate2-probe-darwin-arm64.md`, `gate3-mem-darwin-arm64.md`)
and the evbarm-aarch64 rung (`gate3-netbsd-aarch64.md`) allow:

**1. Big-endian correctness — PARTIAL PASS on the portable signal; the
native-BE-hardware confirmation is BLOCKED.**
- `exercise.endianness` = **OK le=true be=true f64=true**, byte-for-byte
  identical on darwin (qjs + node + tjs), on NetBSD/aarch64, and on
  NetBSD/amd64 attempts. This is the explicit-endian `DataView` contract and
  is host-CPU-independent by design, so it is *already* green everywhere.
- `exercise.sha256-kat` = **ABSENT (no crypto.subtle)** under qjs on every
  platform — quickjs-ng ships no WebCrypto, so the KAT row cannot distinguish
  platforms under the bare engine (it is OK only under node/tjs, which have
  `crypto.subtle`). On this rung it would have been ABSENT too.
- The *unique* value m68k would have added is a **native big-endian host**:
  an engine bug that confuses host byte order with the caller-requested
  endianness would flip `be`/`le` only when the CPU itself is BE. That
  differential was **not exercised** — it is precisely what is blocked. On the
  portable evidence we have, there is no sign of BE breakage, but this rung
  cannot upgrade "no sign" to "confirmed on BE silicon".

**2. Memory vs. the class ceiling — 32-bit numbers BLOCKED; the 64-bit
picture (which sets the shape) stands.** No m68k run ⇒ no 32-bit peak-RSS and
no answer to "does compiling the 18.4 MB bundle to bytecode in-guest fit in
≤1 GB / need swap". What is measured elsewhere, against the mac68k-class
64–128 MB ceiling from the Task-7 reading:
  - parse-from-source is *far* over the ceiling on both 64-bit platforms —
    darwin qjsc 267.9 MB / run-from-source 208.3 MB; NetBSD/aarch64 242.6 MB /
    174.5 MB — 2–4× over even the 128 MB end. 32-bit pointers would shave
    some, but the 18.4 MB of source text being held and parsed dominates, so
    parse-from-source would still blow a 64–128 MB machine.
  - run-from-bytecode is the only path that fits: darwin standalone
    **80.4 MB**, comfortably under 128 MB. This is the load-bearing number,
    and it depends on the standalone actually running — i.e. on the
    `js_exepath` patch above (the aarch64 standalone couldn't be measured
    without it). The 32-bit confirmation of this figure is exactly what the
    blocked rung would have supplied.

**3. Wall-clock, reported without shame.** Nothing ran to completion, so there
is no honest build/probe wall-clock to report. The only timing datum is
negative: under TCG q800, the INSTALL kernel produced **no console output at
all** within repeated ~2-minute windows — not slowness, a boot-protocol dead
end (see the wall above).

## Recommendation (for the user — this is the re-plan decision)

The North-Star *intent* is big-endian-32-bit-NetBSD evidence for the JS
engine; mac68k was the chosen vehicle and it is blocked by qemu, not by the
engine. Two ROM-free, serial-installable, big-endian NetBSD targets can carry
the same intent under the existing anita/`run-in-guest.py` machinery:
- **NetBSD/sparc** (sun4m, 32-bit big-endian, boots via OpenBIOS —
  `qemu-system-sparc`; anita supports sparc install) — closest match: 32-bit
  *and* BE, so it answers both the BE-correctness and the 32-bit-memory axes.
- **NetBSD/macppc** (32-bit big-endian PowerPC, boots via OpenBIOS —
  `qemu-system-ppc`) — BE, near the same ISA-diversity value.
Either would let the committed `js_exepath` patch and `probe.js`/`measure-mem.sh`
run as intended. Retargeting is a plan change and is left to the user rather
than done unilaterally, per the brief's consult-on-re-plan contract.
