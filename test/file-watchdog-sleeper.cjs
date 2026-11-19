'use strict';
// file-watchdog-sleeper.cjs <pid> <limitMs> <file> — the out-of-process half of test/file-watchdog.cjs. It needs the
// IPC channel test/file-watchdog.cjs's arm() opens: run any other way, it never kills anything.
//
// Started by the preload with the test file's pid. It waits. If the file is still there at the limit, it snapshots the
// file's process tree, writes the named message to the stderr it inherited from the file, and kills the tree. It exits
// the moment the file does: on 'disconnect' (the IPC channel closes when the file's process ends, however it ends) and,
// as a second check, on a poll of process.connected.
//
// WHY THE CHANNEL AND NOT THE PID (review, round 6). "Is the file still there?" is asked of the IPC channel, never of
// the pid: a pid can be reused once its process is gone, and a sleeper that believed a reused pid would kill a
// stranger. The channel belongs to exactly the file's process and closes with it.
//
// THE TREE, one implementation everywhere: the process table as [pid, parent pid] rows, taken BEFORE anything is
// killed (so a child the file's death orphans is still in it), every transitive descendant of the file, minus this
// sleeper (it is the file's child too: killing itself first spared the planted grandchild, measured), each killed with
// process.kill (SIGKILL on POSIX, TerminateProcess on Windows). The sleeper kills itself last, by exiting. Only the
// SOURCE of the rows differs by platform, a platform fact: `ps` on POSIX; on Windows, which has no ps, the CIM process
// table through PowerShell. (`taskkill /T` was rejected: it kills the sleeper with the tree, before the sleeper can
// report what survived.)
//
// UNMEASURED ON WINDOWS (BACKLOG "Windows process-table and priority claims"): the CIM row source, and the kill order on a real
// Windows tree, have not run there.
// The table, the walk and the liveness check are test/proc-tree.cjs's, shared with tui-screen and cpu-bound-run.
const { pidAlive: alive, parseTable, processTable, descendants } = require('./proc-tree.cjs');

const POLL_MS = 1000;

// [[pid, ppid(, created)], ...]: the creation time rides along where the table has one (Windows), so descendants()
// can refuse a reused pid's stranger.
const toRows = (t) => t.map((r) => (r.created === undefined ? [r.pid, r.ppid] : [r.pid, r.ppid, r.created]));
const parseRows = (text, platform) => toRows(parseTable(text, platform));
const processRows = (opts) => toRows(processTable(opts) || []);

// Kills root and everything under it except this sleeper; returns the pids still alive after.
function killTree(root, { rows = processRows(), self = process.pid, kill = (pid) => process.kill(pid, 'SIGKILL'),
  isAlive = alive, waitMs = 5000 } = {}) {
  const tree = [root, ...descendants(rows, root).filter((p) => p !== self)];
  for (const pid of tree) { try { kill(pid); } catch { /* gone */ } }
  const t0 = Date.now();
  let left = tree;
  while ((left = left.filter(isAlive)).length && Date.now() - t0 < waitMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return left;
}

function main([pidS, msS, file]) {
  const pid = Number(pidS), ms = Number(msS);
  const { message } = require('./file-watchdog.cjs');
  const done = () => process.exit(0);
  process.on('disconnect', done);
  setInterval(() => { if (!process.connected) done(); }, POLL_MS);
  setTimeout(() => {
    if (!process.connected) done();
    process.stderr.write(message(file, ms, []));
    const survivors = killTree(pid);
    if (survivors.length) process.stderr.write(message(file, ms, survivors));
    done();
  }, ms);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { descendants, killTree, alive, parseRows, processRows };
