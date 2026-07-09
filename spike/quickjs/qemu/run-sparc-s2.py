#!/usr/bin/env python3
"""SPARC S2 campaign PHASE B driver — tjs build + S4 loader + S5 mock PONG.

Boots the BAKED NetBSD/sparc 10.1 image (gmake+cmake in /usr/local from the
phase-A persist runs) with snapshot=on — the image is never dirtied; a crashed
run costs nothing but time. Fetches guest-sparc-s2.sh from the host file
server on port 8180 and runs it: full patched tjs build (pure-C config:
TJS_USE_ADA=OFF/wurl, FFI=OFF, MIMALLOC=OFF, WASM=OFF, atomic shim), engine
sanity, wurl-on-BE URL probes, S4 hello.cjs under the loader, S5 mock PONG
against the host mock (mock-s2.cjs on 8183; guest sees 10.0.2.2:8183).

Modeled on run-sparc-gates.py; deltas: 16h watchdog (tjs build alone est.
4-12h TCG at -j1). Phase-1 tooling, uncommitted, non-production.
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
LOGFILE = os.path.join(REPO, 'vendor', 'sparc-s2b-console.log')
OVERALL = 16 * 3600          # whole-run watchdog (tjs build 4-12h + probes)
SILENCE_SETUP = 900          # dhcpcd/fetch steps
SILENCE_GATES = 7200         # longest legit silent stretch: one cc TU / link

logf = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

print('=== sparc s2b gates driver start (pid %d) snapshot=on ===' % os.getpid())

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
    ('ftp -o /tmp/s2.sh http://10.0.2.2:8180/qemu/guest-sparc-s2.sh', SILENCE_SETUP, 3),
]
for cmd, t, tries in setup:
    if run(cmd, t, tries) != 0:
        print('\n=== DRIVER-ABORT setup failed: %s ===' % cmd)
        a.halt()
        sys.exit(1)

# The gates themselves; failures inside are findings, not driver errors.
run('sh /tmp/s2.sh', SILENCE_GATES)

a.halt()
print('guest run complete; log at', LOGFILE)
