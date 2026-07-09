#!/usr/bin/env python3
"""SPARC S2 campaign — bake-verify boot (snapshot=on, image never dirtied).

Cheap boot that answers: what actually persisted into wd0.img from the
phase-A persist run(s)? Probes /usr/local/bin contents, GNU make, and the
gmake+cmake pair the S2 build needs. Marker a-bake-verified=0 means the FULL
bake (gmake name + cmake) is present. Phase-1 tooling, uncommitted.
"""
import os
import signal
import sys

import anita
import pexpect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # spike/quickjs
ISO = 'https://cdn.netbsd.org/pub/NetBSD/images/10.1/NetBSD-10.1-sparc.iso'
WORKDIR = '/private/tmp/qemu-anita/anita-sparc'
LOGFILE = os.path.join(REPO, 'vendor', 'sparc-s2a-verify.log')
OVERALL = 3600
SILENCE = 900

logf = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

print('=== sparc s2a bake-verify driver start (pid %d) snapshot=on ===' % os.getpid())

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
NL = [r'\r?\n']

cmds = [
    'ls -l /usr/local/bin 2>&1',
    '/usr/local/bin/make --version 2>&1 | sed -n 1,2p',
    'echo persisted-make-exit=$?',
    '/usr/local/bin/gmake --version > /dev/null 2>&1 && /usr/local/bin/cmake --version > /dev/null 2>&1; echo a-bake-verified=$?',
]
for cmd in cmds:
    print('\n=== DRIVER-CMD %s ===' % cmd)
    try:
        status = a.shell_cmd(cmd, timeout=SILENCE, keepalive_patterns=NL)
        print('\n=== DRIVER-EXIT %d: %s ===' % (status, cmd))
    except pexpect.TIMEOUT:
        print('\n=== DRIVER-SILENCE-TIMEOUT: %s ===' % cmd)
        break

a.halt()
print('verify run complete; log at', LOGFILE)
