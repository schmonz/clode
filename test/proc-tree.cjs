'use strict';
// proc-tree.cjs: the process table, a process's descendants, and "is this pid alive", ONE implementation for the
// test helpers that kill or measure a process tree (test/file-watchdog-sleeper.cjs, test/tui-screen.cjs,
// test/cpu-bound-run.cjs). There used to be three copies, each a little different.
//
// THE TABLE: rows { pid, ppid, ms, created }. POSIX: `ps -A -o pid=,ppid=,time=` (ms = cumulative CPU; created is
// unknown there and left undefined). Windows, which has no ps: the CIM process table through PowerShell, with
// ms = UserModeTime + KernelModeTime (100 ns units) and created = CreationDate as a FILETIME. Only the SOURCE of the
// rows differs by platform (a platform fact); the walk is the same everywhere.
//
// PID REUSE (Windows). A Windows process keeps the parent pid it was born with even after that parent is gone, so a
// pid the kernel later reuses for the root can "adopt" an old stranger. Where the table knows creation times, a row
// counts as a child only if it was created no earlier than its parent: a real child never predates its parent.
const { spawnSync } = require('node:child_process');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ps's cumulative CPU time: [[DD-]HH:]MM:SS[.ss] (macOS prints fractions, procps does not)
function parsePsTime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return null;
  return (((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +m[3]) * 60 + +m[4]) * 1000;
}

const CIM = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) '
  + '$([int64]($_.UserModeTime + $_.KernelModeTime) / 10000) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }';

// Rows from the table's text: "pid ppid [time|ms] [created]".
function parseTable(text, platform = process.platform) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 2) continue;
    const pid = Number(f[0]), ppid = Number(f[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const row = { pid, ppid };
    if (f.length >= 3) {
      const ms = platform === 'win32' ? Number(f[2]) : parsePsTime(f[2]);
      if (Number.isFinite(ms)) row.ms = ms;
    }
    if (f.length >= 4 && Number(f[3]) > 0) row.created = Number(f[3]);
    out.push(row);
  }
  return out;
}

// The whole table, or null where it cannot be read.
function processTable({ platform = process.platform, run = spawnSync } = {}) {
  const r = platform === 'win32'
    ? run('powershell', ['-NoProfile', '-NonInteractive', '-Command', CIM], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    : run('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8', timeout: 10000 });
  if (!r || r.error || r.status !== 0 || !r.stdout) return null;
  return parseTable(r.stdout, platform);
}

// Rows may be { pid, ppid, created } or [pid, ppid, created]. -> every transitive descendant of root (root excluded).
function descendants(rows, root) {
  const norm = rows.map((r) => (Array.isArray(r) ? { pid: r[0], ppid: r[1], created: r[2] } : r));
  const created = new Map(norm.map((r) => [r.pid, r.created]));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of norm) {
      if (!tree.has(r.ppid) || tree.has(r.pid)) continue;
      const parentBorn = created.get(r.ppid);
      if (r.created !== undefined && parentBorn !== undefined && r.created < parentBorn) continue;   // pid reuse
      tree.add(r.pid); grew = true;
    }
  }
  tree.delete(root);
  return [...tree];
}

module.exports = { pidAlive, parsePsTime, parseTable, processTable, descendants, CIM };
