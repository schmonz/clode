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
// HOW. test/run.mjs runs `node --require test/file-watchdog-preload.cjs --test ...`. node --test hands its own
// --require to each per-file process (measured: the file's execArgv carries it, a process the file spawns does not), so
// the timer runs in exactly the test-file processes, never in the runner (its execArgv carries --test) and never in a
// child a test spawns. At the limit it writes which file, how long, and how to change the limit, then exits 1: node
// --test reports `not ok - <file>` with that message, and the run goes red.
//
// THE LIMIT. DEFAULT_LIMIT_MS, 30 minutes. Measured on CI (run 44460009323, suite ubuntu-latest): the WHOLE suite's
// node --test took 108s, and its slowest single test 10.2s, so no CI file comes near it. Locally, with a tjs and a
// provider present, the heaviest files run real builds and agentic turns; the longest timeout any of them gives a
// single step is 10 minutes (clode-native's runNative), so 30 minutes admits three such steps back to back. A file whose
// own spawn is allowed longer than that is named in OVERRIDES with its reason. There is no global knob, on purpose:
// a limit raised for everything is a hang hidden for everything.
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
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

function message(file, ms) {
  const rel = relOf(file);
  return `file-watchdog: ${rel} was still running ${Math.round(ms / 1000)}s after it started, its wall-clock limit `
    + '(test/file-watchdog.cjs). A test in it never settled, or something holds its event loop open. If the file '
    + `legitimately needs longer, name it in OVERRIDES with the reason.\n`;
}

// Arms the timer; `exit` and `write` are injectable for the unit rows.
function arm(file, ms, { exit = (c) => process.exit(c), write = (s) => process.stderr.write(s),
  setTimer = setTimeout } = {}) {
  const t = setTimer(() => { write(message(file, ms)); exit(1); }, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = { DEFAULT_LIMIT_MS, OVERRIDES, REPO, limitFor, shouldArm, message, arm, relOf };
