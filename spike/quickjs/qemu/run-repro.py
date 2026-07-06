#!/usr/bin/env python3
"""Minimal one-off driver: install+boot evbarm-aarch64, build qjs (no
txiki), ktrace-repro the `qjs -c` standalone spin. Trimmed copy of
run-in-guest.py's setup/watchdog machinery; see RUNBOOK.md for the anita
API notes this leans on.
"""
import os
import signal
import sys
import time

import anita
import pexpect

CDN = 'https://cdn.netbsd.org/pub/NetBSD/NetBSD-10.1/'
arch = 'evbarm-aarch64'
url = CDN + 'evbarm-aarch64/'
workdir, logfile = sys.argv[1], sys.argv[2]
disk, mem, tmo, overall, pkgarch = '8G', '4G', 900, 3600, 'aarch64'

logf = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logf, 1)
os.dup2(logf, 2)
sys.stdout = os.fdopen(1, 'w', buffering=1)
sys.stderr = os.fdopen(2, 'w', buffering=1)

a = anita.Anita(anita.URL(url), workdir=workdir, disk_size=disk,
                memory_size=mem, vmm_args=['-smp', '2'])
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

NL = [r'\r?\n']


def run(cmd, timeout, tries=1, sleep_between=10):
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


PKG_PATH = 'http://10.0.2.2:8080/vendor/dist/pkgs/%s' % pkgarch

setup = [
    ('dhcpcd -w && ping -o -w 30 10.0.2.2', 600, 3),
    ('PKG_PATH=%s pkg_add cmake gmake libffi' % PKG_PATH, tmo, 3),
    ('ftp -o /tmp/repro.sh http://10.0.2.2:8080/qemu/repro-ktrace.sh', 600, 3),
]
for cmd, t, tries in setup:
    if run(cmd, t, tries) != 0:
        print('\n=== DRIVER-ABORT setup failed: %s ===' % cmd)
        a.halt()
        sys.exit(1)

run('sh -x /tmp/repro.sh', max(tmo, 1200))

a.halt()
print('guest run complete; log at', logfile)
