'use strict';
// I/O half of the differential: build the shared fixture tree, write the plan, run exec.cjs under
// host node, under tjs + node-shim, and under node again, and read back what each wrote.
//
// WHY NODE TWICE: a field the oracle itself sees move between its own two runs (a FIFO's atime, the
// free memory) cannot be judged, and compare.cjs names it instead of guessing. The subject runs
// between the two oracle runs, so anything that moved around it moved for node too.
//
// fd 3 of every executor is a pipe whose reading end is closed: the `brokenpipe` descriptor, so a
// write meets EPIPE as `rg | head` does.
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('./fixtures.cjs');

const EXEC = path.join(__dirname, 'exec.cjs');

// A pipe nobody reads, as a descriptor: a FIFO opened for reading (nonblocking, so the open does not
// wait for a writer), then for writing, then its reading end closed. Node has no pipe(2); this is one.
function brokenPipe(dir) {
  if (process.platform === 'win32') return null;
  const fifo = path.join(dir, 'broken-pipe');
  execFileSync('mkfifo', [fifo]);
  const r = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const w = fs.openSync(fifo, fs.constants.O_WRONLY);
  fs.closeSync(r);
  return w;
}

function runOne(argv, { planFile, outFile, cwd, timeout, pipeFd }) {
  const r = spawnSync(argv[0], [...argv.slice(1), EXEC, planFile, outFile], {
    cwd, stdio: ['ignore', 'pipe', 'pipe', pipeFd === null ? 'ignore' : pipeFd], env: { ...process.env },
    encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
  });
  const lines = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean) : [];
  const results = {};
  let done = false;
  for (const l of lines) {
    const x = JSON.parse(l);
    if ('done' in x) done = true; else results[x.id] = x;
  }
  return { code: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error && r.error.message, results, done };
}

// node: [execPath]; subject: the engine's argv prefix (helper.engineSpawn(['run', loader])).
function runDifferential({ cases, subject, node = [process.execPath], timeout = 300000 }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-diff-')));
  let pipeFd = null;
  try {
    const shared = build(path.join(base, 'shared'));
    pipeFd = brokenPipe(base);
    const mk = (tag) => {
      const scratch = path.join(base, `scratch-${tag}`);
      fs.mkdirSync(scratch);
      const planFile = path.join(base, `plan-${tag}.json`);
      // every run sees the same shared tree; its mutating cases each get a fresh tree under its own scratch
      fs.writeFileSync(planFile, JSON.stringify({ shared, scratch, cases }));
      return { planFile, outFile: path.join(base, `out-${tag}.jsonl`), cwd: shared, timeout, pipeFd };
    };
    const node1 = runOne(node, mk('node1'));
    const ours = runOne(subject, mk('ours'));
    const node2 = runOne(node, mk('node2'));
    return { node1, ours, node2, fifo: fs.existsSync(path.join(shared, 'fifo')) };
  } finally {
    if (pipeFd !== null) try { fs.closeSync(pipeFd); } catch { /* closed */ }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp dir left behind is not a result */ }
  }
}

module.exports = { runDifferential, EXEC };
