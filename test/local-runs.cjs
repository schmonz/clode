'use strict';
// THE LOCAL RUNS (every-tool ruling E11, 2026-11-20): an engine no CI job can reach is driven on a local VM, and the
// run is held by a committed, machine-written evidence file. ONE definition, read by the gate that judges the evidence
// (test/build-gates/tool-coverage-gates.test.cjs, `driven-local`) and by the command that writes it
// (scripts/vm-cells.mjs <run>).
//
//   run       the run's name, and the argument to its re-run command
//   engine    the shipping engine whose cells it drives
//   files     the driver files it runs (their sha at the run is in the evidence; an edit drives nothing until re-run)
//   evidence  the committed evidence file, repo-relative
//   rerun     the one command that re-runs it and rewrites the evidence
//   vm        how to reach the guest: ssh args (the user is the caller's own), its work dir (under its HOME, never
//             searched), the PATH a non-interactive ssh lacks, the provider carve to build from (NetBSD has none of
//             its own: clode build uses the linux carve, as `clode fetch claude` does), and the env the PTY harness
//             (`npm install --prefix test`) builds under there
const LOCAL_RUNS = [
  { run: 'netbsd-arm64-vm', engine: 'netbsd-arm64',
    files: ['test/fidelity/tools-local.test.cjs', 'test/fidelity/agentic-grep-glob.test.cjs'],
    evidence: 'test/fidelity/evidence/netbsd-arm64-vm.json', rerun: 'node scripts/vm-cells.mjs netbsd-arm64-vm',
    // the local qemu NetBSD/arm64 guest: `nb boot netbsd 10 arm64` (really 11.0_RC2), ssh on host port 2230
    vm: { ssh: ['-p', '2230', '-o', 'BatchMode=yes', 'localhost'], scp: ['-P', '2230', '-o', 'BatchMode=yes'], host: 'localhost',
      dir: 'clode-vm-cells', path: '/opt/pkg/bin:/opt/pkg/sbin:/usr/bin:/bin:/usr/sbin:/sbin', provider: 'linux',
      // the PTY harness (test/package.json's node-pty) has no netbsd-arm64 prebuild, and its source build misses three
      // headers and libutil there (forkpty/openpty, termios): measured 2026-11-20, these make it build and spawn
      harnessEnv: { CXXFLAGS: '-include termios.h -include sys/ioctl.h -include util.h', LDFLAGS: '-lutil' } } },
];
module.exports = { LOCAL_RUNS };
