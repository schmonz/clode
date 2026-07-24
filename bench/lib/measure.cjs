'use strict';
const { spawn } = require('node:child_process');

// macOS `/usr/bin/time -l` writes resource stats to stderr; the RSS line is
// "<bytes>  maximum resident set size" (bytes on macOS, unlike Linux's KB).
function parseTimeL(stderr) {
  const m = /(\d+)\s+maximum resident set size/.exec(String(stderr));
  return { peakRssBytes: m ? Number(m[1]) : null };
}

// Spawn one run wrapped in `/usr/bin/time -l`, timed with a monotonic clock.
// MUST be ASYNC (not spawnSync): the mock Anthropic server runs IN-PROCESS in the
// orchestrator, and spawnSync would block the event loop so the mock never
// serves the request — the child then hangs waiting for a response it can't get
// (the exact reason clode-fuse.cjs's `run` is async too). stdin is 'ignore' so a
// `-p` run does not wait on stdin. The outer wall clock (not time -l's "real")
// keeps the timing uniform; time -l is only mined for peak RSS.
function measure({ bin, args = [], cwd, env, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn('/usr/bin/time', ['-l', bin, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    const finish = (exitCode) => {
      clearTimeout(to);
      resolve({
        wallMs: Number(process.hrtime.bigint() - start) / 1e6,
        peakRssBytes: parseTimeL(stderr).peakRssBytes,
        exitCode,
        timedOut,
        stdout,
        stderr,
      });
    };
    child.on('exit', (status) => finish(status));
    child.on('error', () => finish(null));
  });
}

module.exports = { parseTimeL, measure };
