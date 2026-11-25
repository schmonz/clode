'use strict';
// spawn-collect.cjs — spawn a child, collect its stdout and stderr, and resolve once it has EXITED AND ITS STDIO HAS
// CLOSED ('close'), never on 'exit' alone.
//
// WHY. node fires 'exit' without waiting for the child's stdio ("child process stdio streams might still be open"), so
// output collected by then can be missing its tail. node-shim-oracle (CI 44460009323) failed exactly so: exit code 0
// from a handler that had printed 'resumed', and the collected stdout held only 'ready\n'. The same shape (collect,
// then resolve on 'exit') sat in about twenty test files; they all use this now, and
// test/spawn-close-gate.test.cjs refuses the shape anywhere under test/.
//
// spawnCollect(cmd, args, spawnOpts, { timeoutMs, onSpawn, spawn }) -> Promise<{ status, signal, stdout, stderr, error,
// timedOut }>. A spawn failure resolves with `error` (and status null). At `timeoutMs` the child is SIGKILLed; if its
// stdio still has not closed GRACE_MS later (a grandchild holding the pipe), it resolves anyway, with timedOut true,
// rather than hanging the suite. `onSpawn(child)` gets the child (to write its stdin, say) before anything is awaited.
//
// A KILL SAYS SO, IN STDERR. The naude model on node-shim-oracle-darwin (CI 45646543044) hung twice, and both failures read
// "stderr: (empty) / null !== 0": the timeout had SIGKILLed it, and nothing on the page said a watchdog fired, or when. A
// caller that prints stderr on failure (nearly all do) now prints `KILLED_BY_TIMEOUT` and the limit too.
// test/spawn-watchdog-gate.test.cjs refuses a hand-rolled kill-on-timeout under test/, which is how that one hid.
const GRACE_MS = 5000;
const KILLED_BY_TIMEOUT = '[spawn-collect] KILLED_BY_TIMEOUT';

function spawnCollect(cmd, args, spawnOpts = {}, { timeoutMs = 0, onSpawn = null, spawn = require('node:child_process').spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timedOut = false, grace = null, to = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (to) clearTimeout(to);
      if (grace) clearTimeout(grace);
      resolve({ stdout, stderr, timedOut, error: null, ...r });
    };
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts }); } catch (e) {
      finish({ status: null, signal: null, error: e, stderr: String(e) });
      return;
    }
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { stdout += d; }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr += d; }); }
    child.on('error', (e) => finish({ status: null, signal: null, error: e, stderr: stderr + String(e) }));
    child.on('close', (status, signal) => finish({ status, signal }));
    if (timeoutMs) {
      to = setTimeout(() => {
        timedOut = true;
        stderr += `${stderr && !stderr.endsWith('\n') ? '\n' : ''}${KILLED_BY_TIMEOUT}: no exit within ${timeoutMs} ms, so it was SIGKILLed\n`;
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        grace = setTimeout(() => finish({ status: null, signal: 'SIGKILL' }), GRACE_MS);
      }, timeoutMs);
    }
    if (onSpawn) onSpawn(child);
  });
}

module.exports = { spawnCollect, GRACE_MS, KILLED_BY_TIMEOUT };
