'use strict';
// run-tmp-runs: the OTHER runs. A killed run's per-run temp root (its pid is dead) is removed when the next run
// starts, and a watcher records every other LIVE run whose root appears while this one runs, so leftovers in the
// shared temp dir are judged unattributable instead of red (test/run-tmp.cjs says why).
//
// A module of its own, required only by test/run.mjs and its rows: it starts a process and asks the process table,
// and test/suite-home.cjs requires run-tmp.cjs, so anything here would land in the require closure of every test file
// and take it out of the forced-win32 pass (test/forced-win32.cjs: a file whose test-side code reaches the real OS).
const fs = require('node:fs');
const path = require('node:path');
const { removeRunRoot, writableDir, snapshotList } = require('./run-tmp.cjs');

const ROOT_NAME = /^clode-run-(\d+)-[A-Za-z0-9]{6}$/;

// The clode-run-<pid>-* roots in `parents`, other than `self`'s: [{ path, pid, alive }].
function runRoots(parents, { self = process.pid, alive = require('./proc-tree.cjs').pidAlive } = {}) {
  const out = [];
  for (const dir of new Set(parents.filter(writableDir).map((d) => fs.realpathSync.native(d)))) {
    for (const name of snapshotList(dir)) {
      const m = ROOT_NAME.exec(name);
      if (m && Number(m[1]) !== self) out.push({ path: path.join(dir, name), pid: Number(m[1]), alive: alive(Number(m[1])) });
    }
  }
  return out;
}

// Remove the roots of runs that died without removing them (killed: no exit hook ran). -> the paths removed, or
// refusals as Errors naming what refused.
function removeStaleRoots(parents, opts = {}) {
  const out = [];
  for (const r of runRoots(parents, opts).filter((x) => !x.alive)) {
    try { removeRunRoot(r.path); out.push({ path: r.path, pid: r.pid }); } catch (e) { out.push({ path: r.path, pid: r.pid, error: e }); }
  }
  return out;
}

// THE OVERLAP WATCHER: a child of the runner (`node run-tmp.cjs --watch-overlap <out> <runner pid> <parent>...`) that
// samples for other live roots every second and appends each new pid to <out>, until the runner is gone. A child,
// because the runner spends the run inside spawnSync, where no timer of its own can fire.
function watchOverlap(out, runner, parents, { every = 1000 } = {}) {
  const { pidAlive } = require('./proc-tree.cjs');
  const seen = new Set();
  const tick = () => {
    if (!pidAlive(runner)) process.exit(0);
    for (const r of runRoots(parents, { self: runner })) {
      if (r.alive && !seen.has(r.pid)) { seen.add(r.pid); try { fs.appendFileSync(out, `${r.pid}\n`); } catch { /* root gone */ } }
    }
  };
  tick();
  setInterval(tick, every);
}

function startOverlapWatch(out, parents) {
  const child = require('node:child_process').spawn(process.execPath,
    [__filename, '--watch-overlap', out, String(process.pid), ...parents], { stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

// Every pid the watcher recorded, plus one last sample.
function overlapPids(out, parents) {
  const pids = new Set();
  try { for (const l of fs.readFileSync(out, 'utf8').split('\n')) if (/^\d+$/.test(l)) pids.add(Number(l)); } catch { /* none recorded */ }
  for (const r of runRoots(parents)) if (r.alive) pids.add(r.pid);
  return [...pids].sort((a, b) => a - b);
}

module.exports = { ROOT_NAME, runRoots, removeStaleRoots, watchOverlap, startOverlapWatch, overlapPids };

if (require.main === module && process.argv[2] === '--watch-overlap') {
  watchOverlap(process.argv[3], Number(process.argv[4]), process.argv.slice(5));
}
