// Build the host-native depscan (tools/depscan) — the cross-capable
// dependency reader the engine build's hermeticity check runs.
//
// HOST-NATIVE IS THE WHOLE POINT. depscan inspects a binary built FOR
// ANOTHER MACHINE, so it must run on THIS one. Passing the target's
// cross-file here would produce a verifier the build that needs it cannot
// execute — the same host-vs-target split buildHostTjsc() already makes for
// tjsc, for the same reason. This module therefore never reads crossFile and
// never passes CMAKE_TOOLCHAIN_FILE; test/depscan.test.cjs asserts both
// against this file's own source, scanning code only so that this very
// comment is not mistaken for a violation.
import fs from 'node:fs';
import path from 'node:path';

export function buildDepscan(repo, hostBuildDir, { run, jobs = 1 } = {}) {
  if (typeof run !== 'function') throw new Error('buildDepscan: a `run(cmd, args)` function is required');
  const src = path.join(repo, 'tools', 'depscan');
  fs.mkdirSync(hostBuildDir, { recursive: true });
  run('cmake', ['-S', src, '-B', hostBuildDir, '-DCMAKE_BUILD_TYPE=Release']);
  // --config Release is a no-op for single-config generators and load-bearing
  // for Visual Studio, which ignores CMAKE_BUILD_TYPE at configure time.
  run('cmake', ['--build', hostBuildDir, '--config', 'Release', '--target', 'depscan', '-j', String(jobs)]);
  const exe = path.join(hostBuildDir, process.platform === 'win32' ? 'depscan.exe' : 'depscan');
  if (!fs.existsSync(exe)) {
    // Loud, not silent. If the host cannot build its own verifier, NOTHING is
    // verified — a real build failure, not a condition to skip past quietly.
    // A silent skip here would recreate the exact defect this tool exists to
    // remove.
    throw new Error(`depscan: the host verifier did not build at ${exe} — the hermeticity check cannot run without it`);
  }
  return exe;
}
