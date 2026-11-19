'use strict';
// file-watchdog-sleeper.cjs <pid> <limitMs> <file> — the out-of-process half of test/file-watchdog.cjs.
//
// Started by the preload with the test file's pid. It waits. If the file is still alive at the limit, it snapshots the
// file's process tree, writes the named message to the stderr it inherited from the file, and kills the tree. It exits
// the moment the file does: on 'disconnect' (the IPC channel closes when the file's process ends, however it ends) and,
// as a second check, when a poll finds the pid gone. It never outlives the file by more than one poll.
//
// THE TREE. On POSIX, every descendant the process table shows by parent pid (`ps`), taken BEFORE anything is killed,
// so a child orphaned by the file's death is still in it. On Windows there is no ps and no process group, and
// `taskkill /T` is the platform's own tree kill (written reason for the one per-platform branch: a platform fact, not
// a preference).
const { spawnSync } = require('node:child_process');

const POLL_MS = 1000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// [[pid, ppid], ...] -> every transitive descendant of root.
function descendants(rows, root) {
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, pp] of rows) if (tree.has(pp) && !tree.has(p)) { tree.add(p); grew = true; }
  }
  tree.delete(root);
  return [...tree];
}

function psRows() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x.every(Number.isInteger));
}

// Kills root and everything under it; returns the pids still alive after.
function killTree(root, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
    return alive(root) ? [root] : [];
  }
  // Not this sleeper: it is the file's child too, and killing itself first would spare the rest (measured: the
  // planted grandchild survived exactly so).
  const tree = descendants(psRows(), root).filter((p) => p !== process.pid);
  for (const pid of [root, ...tree]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  const t0 = Date.now();
  let left = [root, ...tree];
  while (left.length && Date.now() - t0 < 5000) {
    left = left.filter(alive);
    if (left.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return left;
}

function main([pidS, msS, file]) {
  const pid = Number(pidS), ms = Number(msS);
  const { message } = require('./file-watchdog.cjs');
  const done = () => process.exit(0);
  process.on('disconnect', done);
  setInterval(() => { if (!alive(pid)) done(); }, POLL_MS);
  setTimeout(() => {
    if (!alive(pid)) done();
    process.stderr.write(message(file, ms, []));
    const survivors = killTree(pid);
    if (survivors.length) process.stderr.write(message(file, ms, survivors));
    done();
  }, ms);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { descendants, killTree, alive };
