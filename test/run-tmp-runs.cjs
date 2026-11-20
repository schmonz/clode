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

// WHO OWNS A ROOT'S PID NOW: { started (ms since epoch, or null), command (or null) }, from the process table. POSIX:
// `ps -o lstart=,command=` (lstart is whole seconds, truncated); Windows: the CIM process, CreationDate and CommandLine.
function pidOwner(pid, { platform = process.platform, run = require('node:child_process').spawnSync } = {}) {
  if (platform === 'win32') {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { "$($p.CreationDate.ToFileTimeUtc())"; $p.CommandLine }`;
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const [ft, ...cmd] = String((r && r.stdout) || '').split(/\r?\n/);
    const n = Number(ft);
    return { started: n > 0 ? n / 10000 - 11644473600000 : null, command: cmd.join('\n').trim() || null };
  }
  const r = run('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000 });
  const m = /^\s*(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(String((r && r.stdout) || '').trim());
  if (!m) return { started: null, command: null };
  const t = Date.parse(m[1]);
  return { started: Number.isNaN(t) ? null : t, command: m[2] };
}

// A root's pid is that run's only if its process is alive AND either started no later than the root was born (a run
// makes its root after it starts) or is node running test/run.mjs. A pid the kernel reused for something started
// later is not the run: its root is a dead run's, swept, never counted as a live overlap. Birth time where the
// filesystem keeps one; otherwise ctime, which is no earlier (so a doubt counts as live, never as dead). An owner that
// cannot be read (ps answered nothing, PowerShell failed or timed out: started null) is a doubt too: a live pid whose
// start is unknown counts as live, so a running suite's root is never swept for want of a process table.
const RUNNER_COMMAND = /\bnode(?:\.exe)?\b.*\btest[\\/]run\.mjs\b/;
function ownsRoot(root, pid, { alive = require('./proc-tree.cjs').pidAlive, owner = pidOwner } = {}) {
  if (!alive(pid)) return false;
  const o = owner(pid);
  if (o.command && RUNNER_COMMAND.test(o.command)) return true;
  let born;
  try { const st = fs.statSync(root); born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs; } catch { return false; }
  return o.started === null || o.started <= born;
}

// The clode-run-<pid>-* roots in `parents`, other than `self`'s: [{ path, pid, alive }], alive meaning ownsRoot.
function runRoots(parents, { self = process.pid, ...opts } = {}) {
  const out = [];
  for (const dir of new Set(parents.filter(writableDir).map((d) => fs.realpathSync.native(d)))) {
    for (const name of snapshotList(dir)) {
      const m = ROOT_NAME.exec(name);
      if (!m || Number(m[1]) === self) continue;
      const p = path.join(dir, name);
      out.push({ path: p, pid: Number(m[1]), alive: ownsRoot(p, Number(m[1]), opts) });
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
// Each pid's owner is read once (pidOwner on Windows starts a PowerShell, about a second each): a pid's start time and
// command do not change while it lives, and the liveness check that comes first stays per tick.
function cachedOwner(owner = pidOwner) {
  const cache = new Map();
  return (pid) => { if (!cache.has(pid)) cache.set(pid, owner(pid)); return cache.get(pid); };
}
function watchOverlap(out, runner, parents, { every = 1000, owner = cachedOwner() } = {}) {
  const { pidAlive } = require('./proc-tree.cjs');
  const seen = new Set();
  const tick = () => {
    if (!pidAlive(runner)) process.exit(0);
    for (const r of runRoots(parents, { self: runner, owner })) {
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

module.exports = { ROOT_NAME, RUNNER_COMMAND, pidOwner, cachedOwner, ownsRoot, runRoots, removeStaleRoots, watchOverlap, startOverlapWatch, overlapPids };

if (require.main === module && process.argv[2] === '--watch-overlap') {
  watchOverlap(process.argv[3], Number(process.argv[4]), process.argv.slice(5));
}
