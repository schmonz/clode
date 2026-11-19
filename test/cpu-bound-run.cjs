'use strict';
// cpu-bound-run.cjs: run a CPU-bound child under a bound on the WORK it does, not on the wall clock.
//
// WHY. clode-native's acceptance 2 (the native builder blobulates a quaude) ran under a bare 600 s wall timeout. It
// is single-threaded CPU work under tjs (measured 2026-11-19, alone on this M-series box: ~190 s wall, user CPU about
// equal to wall, no network; 85% of it is extracting and SCC-merging the 2.1.283 carve), so its wall time is its CPU
// time divided by the share of a core the box gives it. In full suites it took 245-460 s; in one loaded suite every
// test ran 2.5-3x slower and it hit 600 s with no output, which is the load, not the build. A wall bound therefore
// judges the machine. Its CPU time does not move with load; a hang shows as CPU that stops moving. So:
//
//   cpuBudgetMs  the child's process tree may use at most this much CPU (a runaway: the build doing far more work);
//   stallMs      if the tree's CPU does not advance for this long while it lives, it is stalled (a hang, a deadlock;
//                new processes that add no CPU do not count). Only for CPU-bound runs: see PRECONDITION below;
//   wallMs       an outer ceiling all the same, so a starved box cannot run the file into its watchdog
//                (test/file-watchdog.cjs) without a named failure first.
// Whichever trips first kills the tree and is named in `bound` with the CPU it had used, so a red row says which.
//
// CPU is sampled from test/proc-tree.cjs's process table (`ps -A -o pid=,ppid=,time=`; on Windows the CIM table's
// user + kernel time) every pollMs and summed over the child and its descendants, each pid
// keeping its largest reading (an exited descendant's CPU is kept, not lost). Progress is CPU only: a new pid in the
// tree counts only through the CPU it adds, so a loop that keeps spawning sleepers is still STALLED. Where the table
// cannot be read, only the wall ceiling applies, and the result says so (cpuSampled false).
//
// PRECONDITION: the bounded run does its work on the CPU. A run that waits on the network, or on long blocking IO,
// makes no CPU progress while it waits and is called STALLED: bound such a run by the wall clock instead.
// BLIND SPOTS of the tree sum, which both make it read LOW (never high, so they can cause a false STALLED or a late
// CPU-budget kill, never a false budget kill): a descendant that lives and dies between two polls is never seen, so
// its CPU is not counted and it does not count as a new pid; and a descendant whose parent exits is reparented to
// init (pid 1, or a subreaper), leaves the tree, and its CPU stops counting from then on.
const { spawnCollect } = require('./spawn-collect.cjs');
const { parsePsTime, processTable, descendants } = require('./proc-tree.cjs');

// The tree under `root` in one snapshot of the table: [{ pid, ms }] (test/proc-tree.cjs walks it).
function treeOf(rows, root) {
  const self = rows.find((r) => r.pid === root);
  if (!self) return [];
  const under = new Set(descendants(rows, root));
  return [self, ...rows.filter((r) => under.has(r.pid))];
}

function runCpuBounded(cmd, args, spawnOpts, { cpuBudgetMs, stallMs, wallMs, pollMs = 5000, snapshot = () => processTable() }) {
  let bound = null, cpuMs = 0, cpuSampled = false, timer = null, lastAdvance = Date.now();
  const best = new Map();                   // pid -> largest CPU ms seen
  const started = Date.now();
  const kill = (pids) => { for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };
  const onSpawn = (child) => {
    const poll = () => {
      const rows = snapshot(child.pid);
      if (!rows) return;                    // no ps here: the wall ceiling alone applies
      const tree = treeOf(rows, child.pid);
      if (!tree.length) return;             // exited between polls
      cpuSampled = true;
      for (const r of tree) best.set(r.pid, Math.max(best.get(r.pid) || 0, r.ms));
      let sum = 0; for (const v of best.values()) sum += v;
      if (sum > cpuMs) { cpuMs = sum; lastAdvance = Date.now(); }
      const quiet = Date.now() - lastAdvance;
      if (cpuMs > cpuBudgetMs) bound = `CPU budget: the tree used ${Math.round(cpuMs / 1000)} s of CPU, over its ${cpuBudgetMs / 1000} s budget`;
      else if (quiet > stallMs) bound = `STALLED: no CPU progress for ${Math.round(quiet / 1000)} s (over ${stallMs / 1000} s) at ${Math.round(cpuMs / 1000)} s of CPU`;
      if (bound) { clearInterval(timer); kill(tree.map((r) => r.pid).reverse()); }
    };
    timer = setInterval(poll, pollMs);
    child.on('exit', () => clearInterval(timer));
  };
  return spawnCollect(cmd, args, spawnOpts, { timeoutMs: wallMs, onSpawn }).then((r) => {
    clearInterval(timer);
    const wall = Date.now() - started;
    if (!bound && r.timedOut) bound = `WALL ceiling: ${Math.round(wall / 1000)} s (over ${wallMs / 1000} s) at ${Math.round(cpuMs / 1000)} s of CPU`;
    return { ...r, bound, cpuMs, cpuSampled, wallMs: wall };
  });
}

module.exports = { runCpuBounded, parsePsTime, treeOf };
