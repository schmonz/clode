#!/usr/bin/env python3
"""SPARC S2 campaign PHASE A driver — toolchain bake (the ONE persist boot).

Boots the installed NetBSD/sparc 10.1 image (sun4m SS-20, 512M) with
persist=True — guest writes LAND IN wd0.img. The host-side backup
wd0.img.pristine-10.1 (APFS clone, taken before this driver ever runs) is the
recovery path if this run wedges or corrupts the image. Fetches
guest-sparc-bake.sh from the host file server on port 8180 and runs it:
gmake 4.4.1 + cmake 3.28.6 from source into /usr/local, then a clean halt so
the fs is unmounted properly.

Modeled on run-sparc-gates.py; deltas: persist=True, longer overall watchdog
(cmake-from-source is the RUNBOOK-sparc long pole, est. 4-15h TCG; watchdog
18h — if it fires, the image is presumed dirty and MUST be restored from
wd0.img.pristine-10.1). Phase-1 tooling, uncommitted, non-production.
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
LOGFILE = os.path.join(REPO, 'vendor', 'sparc-s2a-console.log')
OVERALL = 18 * 3600          # whole-run watchdog: gmake ~1h + cmake 4-15h TCG
SILENCE_SETUP = 900          # dhcpcd/fetch steps
SILENCE_BAKE = 7200          # longest legit silent stretch: one big g++ TU

logf = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

print('=== sparc s2a bake driver start (pid %d) PERSIST=True ===' % os.getpid())

a = anita.Anita(anita.ISO(ISO), workdir=WORKDIR, disk_size='8G',
                memory_size='512M', vmm_args=['-M', 'SS-20'],
                persist=True)


def watchdog(signum, frame):
    print('\n=== DRIVER-WATCHDOG-TIMEOUT after %ds — killing qemu; '
          'IMAGE PRESUMED DIRTY, restore wd0.img.pristine-10.1 ===' % OVERALL)
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
    ('ftp -o /tmp/bake.sh http://10.0.2.2:8180/qemu/guest-sparc-bake.sh', SILENCE_SETUP, 3),
]
for cmd, t, tries in setup:
    if run(cmd, t, tries) != 0:
        print('\n=== DRIVER-ABORT setup failed: %s ===' % cmd)
        a.halt()
        sys.exit(1)

# The bake itself; failures inside are findings, not driver errors.
run('sh /tmp/bake.sh', SILENCE_BAKE)

# Clean halt matters doubly under persist: fs must unmount cleanly.
a.halt()
print('bake run complete; log at', LOGFILE)
