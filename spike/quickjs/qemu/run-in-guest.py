#!/usr/bin/env python3
"""Install (once) and boot a NetBSD VM via anita, log in on the serial
console, run a fixed command sequence, capture everything to a log file.

Usage:
  run-in-guest.py <arch> <workdir> <logfile> [--install] [--skip-tjs]

arch: amd64 | evbarm-aarch64 | mac68k (distribution URL, VM sizing, accel).

Written against anita 2.18 (gson.org — NOT the PyPI package named "anita",
which is an unrelated logic-proof tool; see RUNBOOK.md). Real API notes:
- Anita(dist, workdir=, disk_size=, memory_size=, vmm_args=[...]).
- .install() is idempotent (skips if the disk image exists), so boot-only
  reruns just omit --install (or keep it; same effect once installed).
- .boot() returns the pexpect child after the login prompt appears; boots
  run qemu with snapshot=on (persist=False), so guest-side changes are
  discarded at exit — every run must redo dhcpcd/pkg_add, and the installed
  disk image is never dirtied by a crashed run.
- .shell_cmd(cmd, timeout, keepalive_patterns) does its own root login and
  unique-prompt handling and returns the command's exit status — far more
  robust than hand-rolled expect('# ') (which false-matches build output).
- Console traffic is mirrored to the driver's stdout; we dup2 stdout+stderr
  onto the logfile so one file captures everything (install included).
- keepalive_patterns=[newline] makes the per-command timeout mean "max
  console silence", not "max duration" — required for multi-hour TCG builds.
- A SIGALRM watchdog bounds the WHOLE run: a wedged expect once hung a run
  forever at 0% CPU; now the driver force-kills qemu and exits 2 instead.
Phase-1 tooling, non-production.
"""
import os
import signal
import sys
import time

import anita
import pexpect

CDN = 'https://cdn.netbsd.org/pub/NetBSD/NetBSD-10.1/'
ARCHES = {
    # arch             (distribution URL         disk  mem    silence(s) overall(s) pkgarch)
    # amd64 rung retired by user decision 2026-07-06 (see RUNBOOK.md); kept
    # runnable. OS evidence moved to evbarm-aarch64 (HVF, near-native).
    'amd64':          (CDN + 'amd64/',           '8G', '4G',   1800,     28800,  'amd64'),
    'evbarm-aarch64': (CDN + 'evbarm-aarch64/',  '8G', '4G',    900,     14400,  'aarch64'),
    'mac68k':         (CDN + 'mac68k/',          '4G', '256M', 14400,   172800,  'm68k'),
}
arch, workdir, logfile = sys.argv[1], sys.argv[2], sys.argv[3]
url, disk, mem, tmo, overall, pkgarch = ARCHES[arch]
skip_tjs = '--skip-tjs' in sys.argv

# One file captures everything: anita mirrors the serial console to stdout,
# qemu noise arrives on stderr. Line-buffering keeps it tail -f friendly.
logf = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

a = anita.Anita(anita.URL(url), workdir=workdir, disk_size=disk,
                memory_size=mem, vmm_args=['-smp', '2'])

if arch == 'evbarm-aarch64':
    # HVF (native-speed aarch64-on-aarch64). anita's arch_vmm_args() emits
    # '-cpu cortex-a57' AFTER our vmm_args, and hvf only supports -cpu host,
    # so appending '-accel hvf -cpu host' to vmm_args is not enough — shadow
    # the instance method to substitute the cpu. The shadow must preserve
    # the '-kernel <unzipped GENERIC64>' pair arch_vmm_args appends for
    # image-based ports: without it qemu exits instantly ('-append' without
    # '-kernel' is an error). Recorded in RUNBOOK.md.
    # virtio-rng: without it the qemu virt machine has no RNG source and
    # NetBSD 10 stalls at boot on "Waiting for entropy... entropy: pid NNN
    # (dd) waiting for entropy(7)" for minutes before the login prompt.
    a.extra_vmm_args += ['-accel', 'hvf', '-device', 'virtio-rng-pci']
    a.arch_vmm_args = lambda: ['-M', a.machine, '-cpu', 'host',
                               '-kernel', a.actual_kernel()]


def watchdog(signum, frame):
    print('\n=== DRIVER-WATCHDOG-TIMEOUT after %ds — killing qemu ===' % overall)
    try:
        child = a.child
        if child is not None and child.pid:
            os.kill(child.pid, signal.SIGKILL)
    except Exception as e:
        print('watchdog: kill failed: %s' % e)
    os._exit(2)


signal.signal(signal.SIGALRM, watchdog)
signal.alarm(overall)

if '--install' in sys.argv:
    a.install()
a.boot()

NL = [r'\r?\n']  # any console output is a sign of life


def run(cmd, timeout, tries=1, sleep_between=15):
    """shell_cmd with driver-side retries; returns final exit status.
    A silence timeout does not kill the run: Ctrl-C the guest command,
    record the marker, and carry on (the evidence so far is still in the
    log, and later steps like the memory axis may still succeed)."""
    status = -1
    for i in range(tries):
        if i:
            time.sleep(sleep_between)
        print('\n=== DRIVER-CMD (try %d/%d) %s ===' % (i + 1, tries, cmd))
        try:
            status = a.shell_cmd(cmd, timeout=timeout, keepalive_patterns=NL)
        except pexpect.TIMEOUT:
            print('\n=== DRIVER-SILENCE-TIMEOUT (%ds) — sending ^C: %s ===' % (timeout, cmd))
            a.child.send('\x03')
            time.sleep(2)
            status = -2
            continue
        print('\n=== DRIVER-EXIT %d: %s ===' % (status, cmd))
        if status == 0:
            return status
    return status


# Packages come from the HOST's mirror (vendor/dist/pkgs/<pkgarch>/, the
# dependency closure pre-downloaded by qemu/RUNBOOK.md step 2b): guest->host
# is the one network path slirp reliably provides here. Direct guest->CDN
# fetches stalled with bytes_in=0 (slirp outbound breakage, see RUNBOOK.md).
PKG_PATH = 'http://10.0.2.2:8080/vendor/dist/pkgs/%s' % pkgarch

# Setup steps: retried, and a persistent failure aborts the run (a build
# without cmake or the guest script would waste hours producing nothing).
# dhcpcd -w waits for a lease (plain `dhcpcd` forks before the lease arrives
# and the next command finds a dead network: "Transient resolver failure",
# "Can't assign requested address"); the ping proves the gateway path.
setup = [
    ('dhcpcd -w && ping -o -w 30 10.0.2.2', 600, 3),
    ('PKG_PATH=%s pkg_add cmake gmake libffi' % PKG_PATH, tmo, 3),
    ('ftp -o /tmp/gb.sh http://10.0.2.2:8080/qemu/guest-build.sh', 600, 3),
]
for cmd, t, tries in setup:
    if run(cmd, t, tries) != 0:
        print('\n=== DRIVER-ABORT setup failed: %s ===' % cmd)
        a.halt()
        sys.exit(1)

# Outbound-network diagnostic (evidence, not a gate): documents whether the
# guest can reach the real internet through slirp. `ftp -q 15` bounds the
# stall. If outbound is dead, tell the guest script to run the probes with
# NET=0 so probe.js's fetch-tls exercise cannot hang the whole build run —
# its ABSENT/skip line plus this diagnostic in the log is the finding.
outbound = run('nslookup cdn.netbsd.org; ftp -q 15 -o /dev/null http://cdn.netbsd.org/pub/', 300)
net_env = '' if outbound == 0 else 'PROBE_NET=0 '

# The build itself: failures inside gb.sh are findings, not driver errors.
# Generous silence budget: single guest commands (a big link, one memory
# measurement) legitimately stay quiet for many minutes — gb.sh's xtrace
# only marks command boundaries.
run(net_env + ('SKIP_TJS=1 ' if skip_tjs else '') + 'sh /tmp/gb.sh', max(tmo, 3600))

a.halt()
print('guest run complete; log at', logfile)
