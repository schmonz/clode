#!/usr/bin/env python3
"""SPARC gate campaign driver — ENGINE VERDICT (gates S0 + S3).

Boots the already-installed NetBSD/sparc 10.1 image (sun4m SS-20, 512M,
snapshot=on so the one-precious-install wd0.img is never dirtied), fetches
guest-sparc-gates.sh from the host file server on port 8180, and runs it.
All evidence arrives on the serial console -> the log file.

Modeled on run-in-guest.py (see its docstring for the anita 2.18 API notes)
with the RUNBOOK-sparc.md § 7 deltas: ISO dist, -M SS-20, NO -smp, port
8180, TCG-scale silence timeouts, no pkg_add (no sparc binary pkgs exist —
the guest script builds bare qjs from source with the no-cmake recipe).
Phase-1 tooling, uncommitted, non-production.
"""
import os
import signal
import sys
import time

import anita
import pexpect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # spike/quickjs
ISO = 'https://cdn.netbsd.org/pub/NetBSD/images/10.1/NetBSD-10.1-sparc.iso'
WORKDIR = '/private/tmp/qemu-anita/anita-sparc'   # LOCAL disk (NFS lock lesson)
LOGFILE = os.path.join(REPO, 'vendor', 'sparc-gates-console.log')
OVERALL = 12 * 3600          # whole-run watchdog (TCG: build 1-3h + probes)
SILENCE_SETUP = 900          # dhcpcd/fetch steps
SILENCE_GATES = 7200         # longest legit silent stretch: one cc/measurement

logf = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

print('=== sparc gates driver start (pid %d) ===' % os.getpid())

# Same instantiation as install-sparc.py: SS-20 (SS-5 caps at 256MB), no
# -smp. install() is a no-op (wd0.img exists); boot() uses snapshot=on.
a = anita.Anita(anita.ISO(ISO), workdir=WORKDIR, disk_size='8G',
                memory_size='512M', vmm_args=['-M', 'SS-20'])


def watchdog(signum, frame):
    print('\n=== DRIVER-WATCHDOG-TIMEOUT after %ds — killing qemu ===' % OVERALL)
    try:
        child = a.child
        if child is not None and child.pid:
            os.kill(child.pid, signal.SIGKILL)
    except Exception as e:
        print('watchdog: kill failed: %s' % e)
    os._exit(2)


signal.signal(signal.SIGALRM, watchdog)
signal.alarm(OVERALL)

a.boot()

NL = [r'\r?\n']  # any console output is a sign of life


def run(cmd, timeout, tries=1, sleep_between=15):
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


setup = [
    ('dhcpcd -w && ping -o -w 60 10.0.2.2', SILENCE_SETUP, 3),
    ('ftp -o /tmp/gg.sh http://10.0.2.2:8180/qemu/guest-sparc-gates.sh', SILENCE_SETUP, 3),
]
for cmd, t, tries in setup:
    if run(cmd, t, tries) != 0:
        print('\n=== DRIVER-ABORT setup failed: %s ===' % cmd)
        a.halt()
        sys.exit(1)

# The gates themselves; failures inside are findings, not driver errors.
run('sh /tmp/gg.sh', SILENCE_GATES)

a.halt()
print('guest run complete; log at', LOGFILE)
