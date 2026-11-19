'use strict';
// file-watchdog.cjs — a wall-clock limit on every test FILE the suite runs, so that a file that never finishes is a
// named red failure instead of a silent wait.
//
// WHY (2026-11-19). 0876302 moved test/oracle-models.cjs to settle on 'close'. oracle-models.test.cjs's fake spawns
// emitted only 'exit', so two of its promises never settled, and node:test waited for them: the full suite sat for
// 9h40m with no output until someone killed it. node:test has no per-file limit, and its --test-timeout (per TEST) does
// not cover it: measured, a test past --test-timeout is reported, but its file's process stays up while anything holds
// its loop open, and node --test waits for that process. Nothing named the file.
//
// OUT OF PROCESS (review, round 5). A timer inside the file cannot fire while the file is blocked in a synchronous
// call, and test/ holds hundreds of spawnSync/execFileSync lines with no timeout (e2e-pty's drive() among them). So
// the timer lives in a SLEEPER, test/file-watchdog-sleeper.cjs, a separate node process the preload starts with the
// file's pid and its limit. At the limit the sleeper writes the named message to the stderr it inherited from the file
// (which node --test is reading) and kills the file and every process under it. It exits as soon as the file does:
// the IPC channel between them closes when the file's process ends, however it ends, and the sleeper also polls the
// pid. So a normal run leaves no sleeper behind, and a sleeper never outlives its file by more than one poll.
//
// HOW IT IS LOADED. test/run.mjs and every CI step run `node --require test/file-watchdog-preload.cjs --test ...`.
// node --test hands its own --require to each per-file process (measured: the file's execArgv carries it, a process the
// file spawns does not), so a sleeper starts for exactly the test-file processes: never for the runner (its execArgv
// carries --test) and never for a child a test spawns.
//
// THE LIMIT. DEFAULT_LIMIT_MS, 30 minutes. Measured on CI (run 44460009323, suite ubuntu-latest): the WHOLE suite's
// node --test took 108s, and its slowest single test 10.2s, so no CI file comes near it. Locally, with a tjs and a
// provider present, the heaviest files run real builds and agentic turns; the longest timeout any of them gives a
// single step is 10 minutes (clode-native's runNative), so 30 minutes admits three such steps back to back. A file whose
// own spawn is allowed longer than that is named in OVERRIDES with its reason. There is no global knob, on purpose:
// a limit raised for everything is a hang hidden for everything.
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SLEEPER = path.join(__dirname, 'file-watchdog-sleeper.cjs');
const DEFAULT_LIMIT_MS = 30 * 60 * 1000;

// Repo-relative POSIX path -> { ms, why }. Each entry exists because the file's OWN timeout for one step exceeds the
// default, and the watchdog must not pre-empt the file's own, better-named, failure.
const OVERRIDES = {
  'test/build-tjs-no-node.test.cjs': { ms: 65 * 60 * 1000,
    why: 'builds a tjs from source with no node on PATH; its spawnSync allows 60 minutes (cold vendor build)' },
  'test/build-host-stale-engine.test.cjs': { ms: 65 * 60 * 1000,
    why: 'rebuilds a stale host engine; its spawnSync allows 60 minutes (cold vendor build)' },
  'test/unicode-data-fresh.test.cjs': { ms: 35 * 60 * 1000,
    why: 'regenerates the Unicode tables against the native binary; its spawnSync allows 30 minutes (cold UCD fetch)' },
};

// Repo-relative POSIX for a file in the checkout; the absolute path for one outside it.
function relOf(file) {
  const rel = path.relative(REPO, path.resolve(file));
  return rel.startsWith('..') || path.isAbsolute(rel) ? path.resolve(file) : rel.split(path.sep).join('/');
}

function limitFor(file, overrides = OVERRIDES) {
  const o = overrides[relOf(file)];
  return o ? o.ms : DEFAULT_LIMIT_MS;
}

// Which processes get a watchdog: a node:test per-file process (NODE_TEST_CONTEXT set, --test NOT in its own execArgv,
// so not the runner) running a *.test.cjs file.
function shouldArm({ execArgv, env, argv }) {
  return !execArgv.includes('--test') && !!env.NODE_TEST_CONTEXT && /\.test\.cjs$/.test(argv[1] || '');
}

function message(file, ms, survivors = []) {
  const rel = relOf(file);
  return `file-watchdog: ${rel} was still running ${Math.round(ms / 1000)}s after it started, its wall-clock limit `
    + '(test/file-watchdog.cjs). A test in it never settled, a synchronous call in it never returned, or something '
    + 'holds its event loop open; it and every process under it were killed'
    + (survivors.length ? ` (pids still alive after the kill: ${survivors.join(', ')})` : '')
    + '. If the file legitimately needs longer, name it in OVERRIDES with the reason.\n';
}

// The sleeper's environment: the file's, minus what would make it something else. NODE_OPTIONS can carry a preload
// (the forced-win32 pass forces process.platform to 'win32' there, which would send the sleeper's tree-kill down the
// Windows branch on a POSIX host); NODE_TEST_CONTEXT would make it look like a test-file process.
function sleeperEnv(env) {
  const out = { ...env };
  delete out.NODE_OPTIONS;
  delete out.NODE_TEST_CONTEXT;
  return out;
}

// Starts the sleeper for this process. Not detached: it must not leave the file's process group or session, and the
// file's death closes the IPC channel whatever the platform. unref'd, channel included, so the sleeper never holds the
// file's process open. `spawn` is injectable for the unit rows (and is the real one the forced-win32 trap lets
// through: see test/forced-win32-preload.cjs).
function arm(file, ms, { pid = process.pid, env = process.env, spawn = require('node:child_process').spawn } = {}) {
  const child = spawn(process.execPath, [SLEEPER, String(pid), String(ms), file], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: sleeperEnv(env), windowsHide: true,
  });
  if (child && typeof child.unref === 'function') child.unref();
  if (child && child.channel && typeof child.channel.unref === 'function') child.channel.unref();
  return child;
}

module.exports = { DEFAULT_LIMIT_MS, OVERRIDES, REPO, SLEEPER, limitFor, shouldArm, message, sleeperEnv, arm, relOf };
