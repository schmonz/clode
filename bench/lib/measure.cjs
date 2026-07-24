'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Portable resource measurement for the whole fleet.
//
// WALL TIME is the universal metric: we time the child with our own monotonic
// clock (process.hrtime), so it needs zero platform support and reads uniformly
// on macOS, the BSDs, Linux, illumos, Haiku — anywhere Node runs.
//
// PEAK RSS is best-effort and platform-specific, because there is no portable
// way to read a *child's* getrusage from Node. We wrap the child in the local
// `/usr/bin/time` and parse its report, NORMALIZING every value to BYTES:
//   - macOS (Darwin):  `time -l`, "N maximum resident set size" — N is BYTES.
//   - *BSD (netbsd/…):  `time -l`, same label — but N is KILOBYTES (4.4BSD).
//   - Linux (GNU time): `time -v`, "Maximum resident set size (kbytes): N" — KB.
// Where `/usr/bin/time` is absent or the platform is unknown, RSS is null and
// the child runs DIRECTLY — the bench still yields wall time everywhere.
const TIME_BIN = '/usr/bin/time';

// The per-platform RSS strategy, or null when we don't know how (→ wall-only).
// `unit` normalizes the parsed integer to bytes. Darwin is the odd one out:
// its ru_maxrss is already bytes; every other platform here reports kilobytes.
function rssStrategy(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return { flag: '-l', re: /(\d+)\s+maximum resident set size/, unit: 1 };
    case 'linux':
      return { flag: '-v', re: /Maximum resident set size \(kbytes\):\s*(\d+)/, unit: 1024 };
    case 'netbsd':
    case 'freebsd':
    case 'openbsd':
    case 'dragonfly':
      return { flag: '-l', re: /(\d+)\s+maximum resident set size/, unit: 1024 };
    default:
      return null;
  }
}

// Parse peak RSS (bytes) from a `time(1)` report using the given strategy.
// Returns null when the strategy is absent or the line isn't present.
function parsePeakRss(stderr, strategy) {
  if (!strategy) return null;
  const m = strategy.re.exec(String(stderr));
  return m ? Number(m[1]) * strategy.unit : null;
}

// Back-compat: the macOS-only parser the first cut shipped. Kept so callers that
// imported it keep working; new code should use parsePeakRss(stderr, strategy).
function parseTimeL(stderr) {
  return { peakRssBytes: parsePeakRss(stderr, rssStrategy('darwin')) };
}

// Resolve how to launch one measured run on THIS box: the argv to spawn and the
// RSS strategy to parse its stderr with. Injectable platform/existsSync for
// tests. When no usable time(1) exists, argv is the bare child and strategy null.
function resolveLaunch({ bin, args = [], platform = process.platform, existsSync = fs.existsSync }) {
  const strategy = rssStrategy(platform);
  if (strategy && existsSync(TIME_BIN)) {
    return { argv: [TIME_BIN, strategy.flag, bin, ...args], strategy };
  }
  return { argv: [bin, ...args], strategy: null };
}

// Spawn one measured run. MUST be ASYNC (not spawnSync): the mock Anthropic
// server runs IN-PROCESS in the orchestrator, and spawnSync would block the
// event loop so the mock never serves the request — the child then hangs
// waiting for a response it can't get (the exact reason clode-fuse.cjs's `run`
// is async too). stdin is 'ignore' so a `-p` run does not wait on stdin.
function measure({ bin, args = [], cwd, env, timeoutMs = 120000, platform = process.platform }) {
  const { argv, strategy } = resolveLaunch({ bin, args, platform });
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(argv[0], argv.slice(1), {
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
        peakRssBytes: parsePeakRss(stderr, strategy),
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

module.exports = { parseTimeL, parsePeakRss, rssStrategy, resolveLaunch, measure, TIME_BIN };
