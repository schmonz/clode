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
//     named assets (-> workDir), then shape the child env with the target-env
//     contract (shapeTargetEnv — was the retired runner's applyBundleEnv job;
//     CLODE_SELF points at the builder, see bakedBuilder below), spawn
//     process.execPath (the naude binary) with NAUDE_RUN_AS_NODE=<workDir>/cli.cjs,
//     NODE_PATH prepended with <depsRoot>/node_modules, and the user args passed
//     through; wait; mirror exit.
//   - set: the re-invoked "plain node" pass — run the target cli.cjs as the main
//     module (fix process.argv, then require it; the baked cli.cjs self-requires
//     the bun-shim, NODE_PATH resolves the deps).
//
// Everything the two branches touch (sea, spawn, env, exit, materializeDeps,
// materializeAssets, requireMain, the exit hook) is injectable, so both branches
// unit-test WITHOUT building a real SEA.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const seaHelpers = require('./naude-sea.cjs');
const { shapeTargetEnv } = require('./target-env.cjs');
const { isExecutableFile } = require('./clode-hosttools.cjs');
const { guardVerdict } = require('./update-guard.cjs');
// The absolute path of the clode that built this naude, read as a SEA asset (
// runtime data) rather than an esbuild --define (a build-time string burned
// into the bundle) — so the SAME esbuilt naude-entry bundle serves every
// build regardless of who built it. A naude cannot rebuild itself, so its
// patched in-app updater calls back to this builder. Absent asset / no `sea`
// seam (a plain `require()` of this module in tests) -> null, same as before
// -> no CLODE_SELF, updater fails loud.
function bakedBuilder(sea) {
  try {
    const b = sea && sea.getAsset && sea.getAsset('builder', 'utf8');
    return b ? (String(b).trim() || null) : null;
  } catch {
    return null;
  }
}

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
    stdin = process.stdin,
    stdout = process.stdout,
    exit = (c) => process.exit(c),
  } = opts;

  // Guard dispatch: naude's own patched updater hook calls back
  // `<naude> --clode-update-guard` as a PreToolUse(Bash) command. Read the whole
  // hook-input JSON off stdin, ask the pure guardVerdict, and emit its answer (or
  // nothing, on any parse failure — fail OPEN) — all BEFORE materializing a
  // single asset or spawning the bundle. This branch never reaches the
  // NAUDE_RUN_AS_NODE check below; it always exits 0 itself.
  if (argv[0] === '--clode-update-guard') {
    let data = '';
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => {
      let verdict = null;
      try {
        const parsed = JSON.parse(data);
        verdict = guardVerdict((parsed.tool_input || {}).command);
      } catch {
        verdict = null;
      }
      if (verdict) stdout.write(JSON.stringify(verdict));
      exit(0);
    });
    return;
  }

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
    onExit,
    builder = bakedBuilder(sea),
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
  // The contract every built target applies to itself (was the runner's job).
  // `exists` (mere presence) answers the trustd question; rg candidates need
  // `isExec` (isFile + +x) — see target-env.cjs's findOnPath for why the two
  // must not be conflated.
  shapeTargetEnv({
    env: childEnv,
    self: builder,
    targetKind: 'naude',
    targetPath: execPath,
    platform: process.platform,
    delimiter: path.delimiter,
    exists: fs.existsSync,
    isExec: isExecutableFile,
    dirname: path.dirname,
  });

  // Guard injection: when the raw incoming env declares CLODE_TARGET (the
  // launched-as-a-target contract — see target-env.cjs), wire the model's Bash
  // tool through the update guard by writing an ephemeral PreToolUse settings
  // file and appending --settings to the child's argv. CLODE_TARGET unset ->
  // skip entirely (e.g. a bare `require()` in a test, or a context with no
  // known target binary to call back into).
  let guardSettingsFile = null;
  const childArgv = [...argv];
  if (env.CLODE_TARGET) {
    guardSettingsFile = path.join(cacheDir || os.tmpdir(), 'clode-guard-' + process.pid + '.json');
    const guardSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '"' + env.CLODE_TARGET + '" --clode-update-guard' },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(guardSettingsFile, JSON.stringify(guardSettings));
    childArgv.push('--settings', guardSettingsFile);
  }

  // Re-invoke the naude binary itself (its own node) as plain node, args passed
  // through, stdio inherited — the child owns the tty and the model session.
  const child = spawnFn(execPath, childArgv, { stdio: 'inherit', env: childEnv });

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
  const cleanup = () => {
    for (const s of Object.keys(handlers)) procOff(s, handlers[s]);
    if (guardSettingsFile) { try { fs.rmSync(guardSettingsFile, { force: true }); } catch {} }
  };

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
