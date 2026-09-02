// scripts/spawn-cost-probe.mjs — Task 8 (phase-2 spec §3.7): the Windows spawn
// measurement. Per §2 of docs/superpowers/specs/2026-09-02-phase2-name-the-steps-design.md,
// this decides PLACEMENT only ("programs as the DECLARED unit, some of them dispatched
// in-process" vs. "spawn overhead is trivial next to the work" — BACKLOG.md's "THE
// WINDOWS TAX" entry). It does not decide the step protocol's SHAPE; that already
// survives either answer (§2: "the program boundary becomes a deployment decision, not
// an architectural one").
//
// Modeled on scripts/exec-probe.mjs, which caught a real defect precisely because it
// reported before anything depended on it: prints and ALWAYS exits 0. This is an
// instrument, not a gate. A measurement job that can go red teaches people to ignore it.
//
// What is measured, and why it is not a proxy: the question is spawn overhead RELATIVE
// TO the work a build step actually does, not process-creation cost in isolation — "a
// microbenchmark of process-creation cost alone would answer a question nobody asked"
// (task-8 brief). So the spawned program is not `cmd /c echo` in a loop; it is THIS
// file, re-invoked with `--worker <units>`, doing the same CPU-bound work the in-process
// arm calls directly. That argv-dispatch shape — one file, multiple call modes — is
// deliberately the multi-call-binary shape phase 2's design is deciding whether to use
// for real steps (quaude-fuse.js:7-21 and scripts/merge-step.mjs already use this
// argv-contract style for the real thing; this probe borrows the shape, not the code).
//
// The work unit itself is calibrated, not arbitrary: phase-2 spec §1 measured the real
// build's compile step at 211.7s / 1795 modules ≈ 118ms/module. A chained-SHA-256 loop
// of DEFAULT_WORK_UNITS iterations was measured locally (see the comment below) to cost
// about that much wall time, so the "step-sized work" arm approximates one real compile,
// not a no-op and not the full 380s merge.
//
// Positive control (required by this project's standard: "a negative assertion with no
// positive control is not evidence" — a timing harness that reports the same number
// whether or not the work happens is worthless). `--self-test` runs the SAME harness at
// two work sizes it already knows the qualitative answer to — trivial work, where spawn
// overhead must dominate (ratio >> 1), and heavy work, where it must shrink toward 1 —
// and fails loudly (still exiting 0; it prints the failure) if the ratio does not move
// the expected direction. Run this locally before trusting any CI number from this file.
//
// Usage:
//   node scripts/spawn-cost-probe.mjs                 # the real measurement
//   node scripts/spawn-cost-probe.mjs --self-test      # prove the harness first
//   SPAWN_PROBE_N=<n> SPAWN_PROBE_WORK=<units> node scripts/spawn-cost-probe.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const SELF = fileURLToPath(import.meta.url);

// Chained SHA-256: cheap to implement, expensive enough to be real CPU work rather than
// a no-op the OS could optimise away, and cheap to calibrate. Measured locally
// (darwin/arm64, node v26.3.0): 200000 units ~= 126ms, close enough to the 118ms/module
// baseline above. Re-calibrate this constant if the two drift far apart; it is a rough
// stand-in, not a promise that a real module compile IS a SHA-256 chain.
const DEFAULT_WORK_UNITS = 200000;
const DEFAULT_N = 30;

function doWork(units) {
  let buf = Buffer.from('clode-spawn-cost-probe-seed');
  for (let i = 0; i < units; i++) {
    buf = createHash('sha256').update(buf).digest();
  }
  return buf;
}

// --- multi-call dispatch: this file IS the thing being spawned -------------------------
if (process.argv[2] === '--worker') {
  doWork(Number(process.argv[3]));
  process.exit(0);
}

function timeInProcess(n, units) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) doWork(units);
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}

function timeSpawned(n, units) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const r = spawnSync(process.execPath, [SELF, '--worker', String(units)], { stdio: 'ignore' });
    if (r.error || r.status !== 0) {
      console.error(`spawn-cost-probe: worker spawn ${i} did not exit 0 cleanly (status=${r.status}, error=${r.error?.message ?? 'none'})`);
    }
  }
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}

function measure(n, units, label) {
  const inProcMs = timeInProcess(n, units);
  const spawnMs = timeSpawned(n, units);
  const perInProcMs = inProcMs / n;
  const perSpawnMs = spawnMs / n;
  const ratio = spawnMs / inProcMs;
  console.log(`${label}: N=${n} workUnits=${units}`);
  console.log(`  in-process: ${inProcMs.toFixed(1)}ms total, ${perInProcMs.toFixed(3)}ms/op`);
  console.log(`  spawned:    ${spawnMs.toFixed(1)}ms total, ${perSpawnMs.toFixed(3)}ms/op`);
  console.log(`  ratio (spawned/in-process): ${ratio.toFixed(2)}x`);
  console.log(`  spawn overhead per call, isolated: ~${(perSpawnMs - perInProcMs).toFixed(3)}ms`);
  return { inProcMs, spawnMs, perInProcMs, perSpawnMs, ratio };
}

function main() {
  const n = Number(process.env.SPAWN_PROBE_N ?? DEFAULT_N);
  const units = Number(process.env.SPAWN_PROBE_WORK ?? DEFAULT_WORK_UNITS);

  console.log(
    `spawn-cost-probe: platform=${process.platform} arch=${process.arch} ` +
    `cpus=${os.cpus().length} osRelease=${os.release()} node=${process.version}`
  );

  if (process.argv.includes('--self-test')) {
    console.log('--- self-test: trivial work (spawn overhead should DOMINATE, ratio >> 1) ---');
    const trivial = measure(n, 1, 'trivial');
    console.log('--- self-test: heavy work (spawn overhead should SHRINK toward 1) ---');
    const heavy = measure(Math.max(5, Math.floor(n / 5)), units * 50, 'heavy');
    if (heavy.ratio < trivial.ratio) {
      console.log(`self-test OK: ratio shrank from ${trivial.ratio.toFixed(2)}x (trivial work) to ${heavy.ratio.toFixed(2)}x (heavy work) as work increased — the harness measures what it claims to.`);
    } else {
      console.error(`self-test FAILED: ratio did NOT shrink (trivial=${trivial.ratio.toFixed(2)}x, heavy=${heavy.ratio.toFixed(2)}x). Do not trust numbers from this harness until this is fixed.`);
    }
    return;
  }

  console.log('--- step-sized work (approximates one real compile step) ---');
  measure(n, units, 'step-sized');
}

try {
  main();
} catch (e) {
  console.error(`spawn-cost-probe: unexpected error, reporting nothing (${e?.stack ?? e})`);
}
process.exit(0); // always — this is an instrument, not a gate (see exec-probe.mjs)
