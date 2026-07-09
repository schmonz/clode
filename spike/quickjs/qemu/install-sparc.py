#!/usr/bin/env python3
"""One-time anita INSTALL of NetBSD/sparc 10.1 on qemu sun4m (SS-20).

Install ONLY — no gate run, no in-guest builds (see RUNBOOK-sparc.md).
Idempotent: skips if wd0.img exists; after a FAILED install, remove
<workdir>/wd0.img before retrying.

Phase-1 tooling, uncommitted, modeled on run-in-guest.py (which must not
be edited while the aarch64 rung is mid-run — hence a separate driver).
"""
import os
import signal
import sys

import anita

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # spike/quickjs
ISO = 'https://cdn.netbsd.org/pub/NetBSD/images/10.1/NetBSD-10.1-sparc.iso'
WORKDIR = '/private/tmp/qemu-anita/anita-sparc'   # LOCAL disk (NFS lock lesson)
LOGFILE = os.path.join(REPO, 'vendor', 'sparc-install-console.log')
OVERALL = 12 * 3600  # TCG sysinst watchdog

# One file captures everything (anita mirrors the serial console to
# stdout, qemu noise arrives on stderr).
logf = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

print('=== sparc install driver start (pid %d) ===' % os.getpid())

# SS-20: SS-5 (qemu default) hard-caps at 256MB; S0's RAM-fit probes need
# headroom. NO -smp (plan single-vcpu; sun4m MP is an S1 experiment).
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

a.install()
print('=== sparc install complete; image at %s/wd0.img ===' % WORKDIR)
