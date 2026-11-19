'use strict';
// I/O half of the differential: build the shared fixture tree, write the plan, run exec.cjs under
// host node, under tjs + node-shim, and under node again, and read back what each wrote.
//
// WHY NODE TWICE: a field the oracle itself sees move between its own two runs (a FIFO's atime, the
// free memory) cannot be judged, and compare.cjs names it instead of guessing. The subject runs
// between the two oracle runs, so anything that moved around it moved for node too.
//
// fd 3 of every executor is a pipe whose reading end is closed: the `brokenpipe` descriptor, so a
// write meets EPIPE as `rg | head` does. fd 4 is a pipe with bytes and an end: the `pipe` descriptor.
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

// A pipe holding "piped\n" and then end of file, as a descriptor (fd 4 of one executor run: it is read
// once, so each run gets its own): a FIFO opened for reading (nonblocking), then for writing, the
// bytes written and the writing end closed. readFileSync(fd) on it is a read that cannot pread.
function filledPipe(dir, tag) {
  if (process.platform === 'win32') return null;
  const fifo = path.join(dir, `filled-pipe-${tag}`);
  execFileSync('mkfifo', [fifo]);
  const r = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const w = fs.openSync(fifo, fs.constants.O_WRONLY);
  fs.writeSync(w, 'piped\n');
  fs.closeSync(w);
  return r;
}

// Every executor runs under `nice -n DIFF_NICE` (off Windows): a deliberately non-default niceness, so
// os.getPriority is judged at a value no constant can match by luck. The shim answered a constant 0 for
// months, and only a CI runner that happened to run at nice -10 (node-shim-oracle-darwin, run 44597568635)
// showed it. Node and the subject get the same nice; it is added to whatever the host runs at, so the increment is
// bumped when the host's own nice would cancel it to 0 (test/nice-increment.cjs).
const DIFF_NICE = require('../nice-increment.cjs').unmaskedIncrement(7, process.platform === 'win32' ? 0 : require('node:os').getPriority(0));
const niced = (argv) => (process.platform === 'win32' ? argv : ['nice', '-n', String(DIFF_NICE), ...argv]);

function runOne(argv, { planFile, outFile, cwd, timeout, pipeFd, base, tag, exec = EXEC }) {
  const filled = filledPipe(base, tag);
  argv = niced(argv);
  const r = spawnSync(argv[0], [...argv.slice(1), exec, planFile, outFile], {
    cwd, stdio: ['ignore', 'pipe', 'pipe', pipeFd === null ? 'ignore' : pipeFd, filled === null ? 'ignore' : filled], env: { ...process.env },
    encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
  });
  if (filled !== null) fs.closeSync(filled);
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
// subjectExec: another executor for the subject alone (a control that breaks one call on purpose).
function runDifferential({ cases, subject, node = [process.execPath], timeout = 300000, subjectExec = EXEC }) {
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
      return { planFile, outFile: path.join(base, `out-${tag}.jsonl`), cwd: shared, timeout, pipeFd, base, tag };
    };
    const node1 = runOne(node, mk('node1'));
    const ours = runOne(subject, { ...mk('ours'), exec: subjectExec });
    const node2 = runOne(node, mk('node2'));
    return { node1, ours, node2, fifo: fs.existsSync(path.join(shared, 'fifo')) };
  } finally {
    if (pipeFd !== null) try { fs.closeSync(pipeFd); } catch { /* closed */ }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp dir left behind is not a result */ }
  }
}

module.exports = { runDifferential, EXEC };
