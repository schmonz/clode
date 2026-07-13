#!/usr/bin/env python3
"""ci-sparc-driver.py — committed CI own-qemu driver (qemu-netbsd-sparc guest backend).

This is the GHA-oriented sibling of the uncommitted Phase-1 tooling
(`run-sparc-le.py`, `install-sparc.py`): it BOOTS an already-fetched
`wd0.img` (the pinned NetBSD/sparc image the guest action downloads and
sha256-verifies from the `ci-images` release — see CI-IMAGES.md) rather
than anita-INSTALLING one from an ISO. It never touches the network for
NetBSD media; a missing `wd0.img` is a hard error, not a multi-hour
silent install.

Shape (reused wholesale from run-sparc-le.py, which is the proven
reference): dup2 stdout/stderr to a console-log file that mirrors the
qemu serial console; an overall SIGALRM watchdog that SIGKILLs qemu (and
the host file server) if the whole run overruns; per-command "silence"
timeouts with keepalive-on-any-output, via anita's shell_cmd; a setup
phase (network up, fetch the recipe) that aborts the run on failure; a
gated phase (the recipe itself) whose *internal* failures are findings,
not driver errors — the driver's own pass/fail verdict comes only from
scanning the console log afterward for the marker vocabulary already
used by spike/quickjs/qemu/guest-sparc-*.sh: a line matching
`=== GUEST-DONE ===` must be present, and every `<phase>-exit=<N>`
marker found must be `0`.

Machine type, recipe path, workspace dir, and timeouts are all
argv/env-parameterized (see `build_arg_parser`) so a FUTURE own-qemu
platform (a different NetBSD port, a different qemu machine type) can
reuse this harness unchanged: swap `--machine`/`--iso-url`/`--recipe`,
keep the driver.

STRUCTURAL FIRST PASS: this module has NOT been run against a real GHA
runner. Whether qemu-sun4m actually boots the fetched image under GHA's
constraints, whether the timeouts/RAM/machine choices are right, and
whether the recipe's marker vocabulary needs adjustment are all proven
and tuned in a later CI wall-walk (the netbsd-sparc-matrix-leg plan's
Task 4), not here.
"""
import argparse
import os
import re
import shlex
import signal
import subprocess
import sys
import time

import anita
import pexpect

# --- defaults (sparc/sun4m today; override everything via argv/env for a
# future leg) -----------------------------------------------------------
DEFAULT_ISO_URL = 'https://cdn.netbsd.org/pub/NetBSD/images/10.1/NetBSD-10.1-sparc.iso'
DEFAULT_MACHINE = 'SS-20'      # SS-5 (qemu default) hard-caps at 256MB
DEFAULT_MEMORY = '512M'
DEFAULT_DISK_SIZE = '8G'       # only consulted if anita ever needs it; no_install=True means it won't
DEFAULT_HTTP_PORT = 8180
DEFAULT_OVERALL_TIMEOUT = 4 * 3600     # whole-run watchdog
DEFAULT_SETUP_TIMEOUT = 900            # dhcpcd/fetch steps (silence timeout)
DEFAULT_SETUP_TRIES = 3
DEFAULT_RECIPE_TIMEOUT = 3600          # longest legit silent stretch while the recipe runs
GUEST_GATEWAY = '10.0.2.2'             # qemu usermode-networking host alias, from inside the guest

GUEST_DONE_RE = re.compile(r'===\s*GUEST-DONE\s*===')
MARKER_RE = re.compile(r'([A-Za-z0-9][\w.-]*-exit)=(-?\d+)')

NL = [r'\r?\n']  # any console output is a sign of life (keepalive pattern)


def _env(name, default):
    return os.environ.get(name, default)


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--workdir', default=_env('CI_SPARC_WORKDIR', None), required=_env('CI_SPARC_WORKDIR', None) is None,
                    help='dir containing the already-fetched wd0.img (env CI_SPARC_WORKDIR)')
    p.add_argument('--workspace', default=_env('CI_SPARC_WORKSPACE', None), required=_env('CI_SPARC_WORKSPACE', None) is None,
                    help='dir served on the host file server; the recipe path is relative to this (env CI_SPARC_WORKSPACE)')
    p.add_argument('--recipe', default=_env('CI_SPARC_RECIPE', None), required=_env('CI_SPARC_RECIPE', None) is None,
                    help='recipe script path, relative to --workspace, that the guest fetches and runs with sh (env CI_SPARC_RECIPE)')
    p.add_argument('--machine', default=_env('CI_SPARC_MACHINE', DEFAULT_MACHINE),
                    help='qemu -M machine type (env CI_SPARC_MACHINE, default %(default)s)')
    p.add_argument('--memory', default=_env('CI_SPARC_MEMORY', DEFAULT_MEMORY),
                    help='qemu -m memory size (env CI_SPARC_MEMORY, default %(default)s)')
    p.add_argument('--disk-size', default=_env('CI_SPARC_DISK_SIZE', DEFAULT_DISK_SIZE),
                    help='anita disk_size, only consulted if install were ever triggered (env CI_SPARC_DISK_SIZE)')
    p.add_argument('--iso-url', default=_env('CI_SPARC_ISO_URL', DEFAULT_ISO_URL),
                    help='NetBSD ISO URL anita uses ONLY to determine the port arch; never fetched (no_install=True) (env CI_SPARC_ISO_URL)')
    p.add_argument('--extra-vmm-args', default=_env('CI_SPARC_EXTRA_VMM_ARGS', ''),
                    help='extra qemu args, shlex-split and appended after -M/--machine (env CI_SPARC_EXTRA_VMM_ARGS)')
    p.add_argument('--http-port', type=int, default=int(_env('CI_SPARC_HTTP_PORT', DEFAULT_HTTP_PORT)),
                    help='host file-server port the guest fetches from at %s (env CI_SPARC_HTTP_PORT)' % GUEST_GATEWAY)
    p.add_argument('--log', default=_env('CI_SPARC_LOG', None),
                    help='console-log path (default: <workdir>/ci-sparc-console.log)')
    p.add_argument('--overall-timeout', type=int, default=int(_env('CI_SPARC_OVERALL_TIMEOUT', DEFAULT_OVERALL_TIMEOUT)),
                    help='whole-run SIGALRM watchdog, seconds (env CI_SPARC_OVERALL_TIMEOUT)')
    p.add_argument('--setup-timeout', type=int, default=int(_env('CI_SPARC_SETUP_TIMEOUT', DEFAULT_SETUP_TIMEOUT)),
                    help='per-command silence timeout during setup, seconds (env CI_SPARC_SETUP_TIMEOUT)')
    p.add_argument('--setup-tries', type=int, default=int(_env('CI_SPARC_SETUP_TRIES', DEFAULT_SETUP_TRIES)),
                    help='retries per setup command (env CI_SPARC_SETUP_TRIES)')
    p.add_argument('--recipe-timeout', type=int, default=int(_env('CI_SPARC_RECIPE_TIMEOUT', DEFAULT_RECIPE_TIMEOUT)),
                    help='silence timeout while the recipe runs, seconds (env CI_SPARC_RECIPE_TIMEOUT)')
    return p


class HostFileServer(object):
    """`python3 -m http.server` over --workspace, on --http-port.

    The guest fetches the recipe (and anything else the recipe wants)
    from http://10.0.2.2:<port>/... — the same pattern as the uncommitted
    guest-sparc-*.sh recipes (`H=http://10.0.2.2:8180`).
    """

    def __init__(self, directory, port, logpath):
        self.logpath = logpath
        self._logf = open(logpath, 'ab', buffering=0)
        self.proc = subprocess.Popen(
            [sys.executable, '-m', 'http.server', str(port), '--directory', directory],
            stdout=self._logf, stderr=subprocess.STDOUT)

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def stop(self):
        if self.proc is None:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
                self.proc.wait(timeout=10)
            except Exception:
                pass
        finally:
            self.proc = None
            try:
                self._logf.close()
            except Exception:
                pass


def collect_markers(logpath):
    """Scan the console-log transcript for the recipe marker vocabulary.

    Returns (guest_done: bool, markers: dict[name -> last exit code seen]).
    """
    with open(logpath, 'r', errors='replace') as f:
        text = f.read()
    guest_done = bool(GUEST_DONE_RE.search(text))
    markers = {}
    for m in MARKER_RE.finditer(text):
        markers[m.group(1)] = int(m.group(2))  # last occurrence wins (retries)
    return guest_done, markers


def verdict(guest_done, markers):
    """(exit_code, message) from collected markers, per the guest-action contract."""
    failed = {k: v for k, v in sorted(markers.items()) if v != 0}
    if not guest_done:
        return 2, 'no "=== GUEST-DONE ===" marker found (%d exit-markers seen: %s)' % (
            len(markers), sorted(markers) or 'none')
    if failed:
        return 1, 'GUEST-DONE seen, but %d marker(s) failed: %s' % (len(failed), failed)
    return 0, 'GUEST-DONE seen, all %d exit-marker(s) zero' % len(markers)


def main(argv=None):
    args = build_arg_parser().parse_args(argv)

    workdir = os.path.abspath(args.workdir)
    workspace = os.path.abspath(args.workspace)
    logpath = os.path.abspath(args.log) if args.log else os.path.join(workdir, 'ci-sparc-console.log')
    http_logpath = os.path.join(workdir, 'ci-sparc-http.log')

    wd0 = os.path.join(workdir, 'wd0.img')
    if not os.path.exists(wd0):
        print('ci-sparc-driver: %s does not exist — the guest action must fetch+verify+decompress '
              'the pinned image before invoking this driver (see CI-IMAGES.md)' % wd0, file=sys.stderr)
        return 3

    recipe_path = os.path.join(workspace, args.recipe)
    if not os.path.exists(recipe_path):
        print('ci-sparc-driver: recipe %s does not exist under workspace %s' % (args.recipe, workspace),
              file=sys.stderr)
        return 3

    # Save the real stdout/stderr so a short verdict can reach the GHA step
    # log even though the bulk of our own output (and the mirrored serial
    # console) is redirected into the console-log file below — matching
    # run-sparc-le.py's shape, which assumes a human tails the log file.
    real_stdout = os.fdopen(os.dup(1), 'w', buffering=1)

    logf = os.open(logpath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(logf, 1)
    os.dup2(logf, 2)
    sys.stdout = os.fdopen(1, 'w', buffering=1)
    sys.stderr = os.fdopen(2, 'w', buffering=1)

    print('=== ci-sparc-driver start (pid %d) ===' % os.getpid())
    print('workdir=%s workspace=%s recipe=%s machine=%s memory=%s http_port=%d' % (
        workdir, workspace, args.recipe, args.machine, args.memory, args.http_port))

    http_server = HostFileServer(workspace, args.http_port, http_logpath)
    print('host file server pid=%s serving %s on :%d (log %s)' % (
        http_server.pid, workspace, args.http_port, http_logpath))

    extra_vmm_args = shlex.split(args.extra_vmm_args) if args.extra_vmm_args else []
    a = anita.Anita(anita.ISO(args.iso_url), workdir=workdir, disk_size=args.disk_size,
                     memory_size=args.memory, vmm_args=['-M', args.machine] + extra_vmm_args,
                     no_install=True)

    def cleanup():
        try:
            http_server.stop()
        except Exception as e:
            print('cleanup: http server stop failed: %s' % e)

    def watchdog(signum, frame):
        print('\n=== DRIVER-WATCHDOG-TIMEOUT after %ds — killing qemu ===' % args.overall_timeout)
        try:
            child = a.child
            if child is not None and child.pid:
                os.kill(child.pid, signal.SIGKILL)
        except Exception as e:
            print('watchdog: kill failed: %s' % e)
        cleanup()
        os._exit(2)

    signal.signal(signal.SIGALRM, watchdog)
    signal.alarm(args.overall_timeout)

    a.boot()

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

    recipe_url = 'http://%s:%d/%s' % (GUEST_GATEWAY, args.http_port, args.recipe)
    recipe_local = '/tmp/' + os.path.basename(args.recipe)
    setup = [
        ('dhcpcd -w && ping -o -w 60 %s' % GUEST_GATEWAY, args.setup_timeout, args.setup_tries),
        ('ftp -o %s %s' % (recipe_local, recipe_url), args.setup_timeout, args.setup_tries),
    ]
    for cmd, timeout, tries in setup:
        if run(cmd, timeout, tries) != 0:
            print('\n=== DRIVER-ABORT setup failed: %s ===' % cmd)
            try:
                a.halt()
            except Exception as e:
                print('halt after setup failure raised: %s' % e)
            cleanup()
            signal.alarm(0)
            real_stdout.write('ci-sparc-driver: setup failed (%s) — see %s\n' % (cmd, logpath))
            return 1

    # The recipe itself: internal step failures inside it are findings, not
    # driver errors (mirrors run-sparc-le.py) — the driver's verdict comes
    # only from the marker scan below, after the guest halts.
    run('sh %s' % recipe_local, args.recipe_timeout)

    try:
        a.halt()
    except Exception as e:
        print('halt raised: %s' % e)

    signal.alarm(0)
    cleanup()

    print('guest run complete; log at', logpath)

    guest_done, markers = collect_markers(logpath)
    code, message = verdict(guest_done, markers)
    print('=== VERDICT (%d): %s ===' % (code, message))

    real_stdout.write('ci-sparc-driver: %s (log %s)\n' % (message, logpath))
    real_stdout.flush()
    return code


if __name__ == '__main__':
    sys.exit(main())
