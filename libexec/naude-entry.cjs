'use strict';
// naude-entry — the `main` script a naude SEA runs on invocation. naude is
// "Claude Code baked into a Node SEA": the SEA embeds a baked `cli.cjs` (Claude
// Code's JS) + `bun-shim.cjs` + a `deps.tar` as node:sea assets. On run, this
// entry materializes those assets to disk and runs the baked cli.cjs under the
// embedded node.
//
// It runs the cli.cjs via the SAME "run as node" re-invocation the retired clode
// SEA dispatch used (clode-main.runAsNodeIfRequested + clode-run.runBundle,
// retired in 13eeb86): rather than require() cli.cjs nested under this entry, we
// re-exec the naude binary itself as plain node so cli.cjs gets a clean process
// (its own argv0, signals, and main-module identity). Two branches, keyed on the
// NAUDE_RUN_AS_NODE env sentinel:
//   - unset (+ isSea): the first pass — materialize deps (-> depsRoot) and the
//     named assets (-> workDir), then spawn process.execPath (the naude binary)
//     with NAUDE_RUN_AS_NODE=<workDir>/cli.cjs, NODE_PATH prepended with
//     <depsRoot>/node_modules, and the user args passed through; wait; mirror exit.
//   - set: the re-invoked "plain node" pass — run the target cli.cjs as the main
//     module (fix process.argv, then require it; the baked cli.cjs self-requires
//     the bun-shim, NODE_PATH resolves the deps).
//
// Everything the two branches touch (sea, spawn, env, exit, materializeDeps,
// materializeAssets, requireMain, the exit hook) is injectable, so both branches
// unit-test WITHOUT building a real SEA.
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const seaHelpers = require('./naude-sea.cjs');

// Reshape argv to plain-node form and run the target as the main module. Defaults
// to the real behavior: set process.argv = [execPath, script, ...userArgs], then
// require(script). In a SEA the global require resolves only built-ins; a
// filesystem-capable require for cli.cjs comes from createRequire — which behaves
// identically outside a SEA, so this one path serves both.
function defaultRequireMain(script, argv) {
  process.argv = argv;
  require('node:module').createRequire(script)(script);
}

// runNaude(opts) — the two-branch SEA entry. Injectable seams (see header) default
// to the real modules so the guarded bootstrap at the file end just works.
function runNaude(opts = {}) {
  const {
    argv = process.argv.slice(2),
    execPath = process.execPath,
    env = process.env,
    requireMain = defaultRequireMain,
  } = opts;

  // Second pass: we are the re-invoked "plain node". Run the target cli.cjs as the
  // main module. Strip the sentinel so the baked cli.cjs never sees it.
  const target = env.NAUDE_RUN_AS_NODE;
  if (target) {
    delete env.NAUDE_RUN_AS_NODE;
    requireMain(target, [execPath, target, ...argv]);
    return;
  }

  // First pass: materialize the embedded assets and re-invoke ourselves as node.
  const {
    // The node:sea MODULE — what the materializers read assets from
    // (sea.getRawAsset). NOT seaHelpers, which merely wraps it: handing the
    // helpers module in here unit-passes against stubbed materializers and then
    // dies on the first real boot with "sea.getRawAsset is not a function".
    sea = seaHelpers.seaMod(),
    cacheDir = env.NAUDE_CACHE || os.tmpdir(),
    materializeDeps = seaHelpers.materializeDeps,
    materializeAssets = seaHelpers.materializeAssets,
    spawn: spawnFn = spawn,
    procOn = (s, cb) => process.on(s, cb),
    procOff = (s, cb) => process.removeListener(s, cb),
    exit = (c) => process.exit(c),
    onExit,
  } = opts;

  // Unpack the deps tarball to a sig-keyed cache dir (holds node_modules/), and the
  // baked cli.cjs + bun-shim into a work dir. workDir is injectable for tests; the
  // default is a stable dir under the deps cache root.
  const depsRoot = materializeDeps({ sea, cacheDir });
  const workDir = opts.workDir || path.join(cacheDir, 'sea-deps', 'naude');
  materializeAssets({ sea, destDir: workDir, names: ['cli.cjs', 'bun-shim.cjs'] });
  const cliPath = path.join(workDir, 'cli.cjs');

  // Build the child env: sentinel points at the baked cli.cjs; NODE_PATH PREPENDS
  // the materialized deps' node_modules (preserving any existing NODE_PATH).
  const nodeModules = path.join(depsRoot, 'node_modules');
  const priorNodePath = env.NODE_PATH;
  const childEnv = Object.assign({}, env, {
    NAUDE_RUN_AS_NODE: cliPath,
    NODE_PATH: priorNodePath ? nodeModules + path.delimiter + priorNodePath : nodeModules,
  });

  // Re-invoke the naude binary itself (its own node) as plain node, args passed
  // through, stdio inherited — the child owns the tty and the model session.
  const child = spawnFn(execPath, [...argv], { stdio: 'inherit', env: childEnv });

  // Signal model (mirrors the retired runBundle): the child stays in our foreground
  // process group, so the kernel delivers tty signals (Ctrl-C=SIGINT, Ctrl-\=SIGQUIT)
  // to it directly and its own handlers apply — so we IGNORE those here (forwarding
  // would double-deliver). We FORWARD directed signals (SIGTERM/SIGHUP), which reach
  // only our pid. On exit we tear the handlers down and mirror the child's status:
  // a signal death becomes 128 + signum (shell $? convention), else its exit code.
  const handlers = {};
  for (const s of ['SIGINT', 'SIGQUIT']) {
    handlers[s] = () => {};
    procOn(s, handlers[s]);
  }
  for (const s of ['SIGTERM', 'SIGHUP']) {
    handlers[s] = () => { try { child.kill(s); } catch {} };
    procOn(s, handlers[s]);
  }
  const cleanup = () => { for (const s of Object.keys(handlers)) procOff(s, handlers[s]); };

  // The exit hook is injectable (onExit) so tests drive it synchronously; the real
  // wiring listens on child's 'exit'.
  const handleExit = (code, signal) => {
    cleanup();
    if (signal) { exit(128 + os.constants.signals[signal]); return; }
    exit(code == null ? 1 : code);
  };
  if (onExit) onExit(handleExit);
  else child.on('exit', handleExit);
  return child;
}

// Guarded SEA bootstrap: run only when we are a SEA (first pass) or the re-invoked
// plain-node pass (sentinel set). Never fires when a test require()s this module.
if (require('./naude-sea.cjs').isSea() || process.env.NAUDE_RUN_AS_NODE) {
  runNaude({ argv: process.argv.slice(2) });
}

module.exports = { runNaude };
