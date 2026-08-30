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
//     contract (shapeTargetEnv — was the retired runner's applyBundleEnv job),
//     spawn process.execPath (the naude binary) with
//     NAUDE_RUN_AS_NODE=<workDir>/cli.cjs, NODE_PATH prepended with
//     <depsRoot>/node_modules, and the user args passed through; wait; mirror
//     exit.
//   - set: the re-invoked "plain node" pass — install the notify-only
//     __clodeCheckUpdate global (installCheckUpdateGlobal, below), then run the
//     target cli.cjs as the main module (fix process.argv, then require it;
//     the baked cli.cjs self-requires the bun-shim, NODE_PATH resolves the
//     deps).
//
// Task 5 (auto-update notify-only, naude parity): a naude cannot rebuild
// itself, so its baked cli.cjs's in-app updater used to spawn a rebuild back
// through the clode that built it. That spawn is RETIRED (Task 3): the shared
// autoupdater patches (extract-claude-js.cjs) now call
// globalThis.__clodeCheckUpdate(current) instead — a pure check-and-notify,
// no builder, no rebuild. naude no longer bakes any builder path at all (the
// old bakedBuilder / `builder` SEA asset are both removed);
// installCheckUpdateGlobal below provides the SAME global the quaude PRELUDE
// installs, so the notify path works even against a cli.cjs whose own PRELUDE
// patch didn't apply (version drift).
//
// Before either branch, the FIRST pass carves the reserved `--clode-*` argv namespace
// (libexec/clode-attest.cjs) so those flags never reach the baked cli.cjs — the same
// carve, from the same module, that quaude's bootstrap does. `--clode-attest` is answered
// here, from the SEA assets, without materializing or spawning anything.
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
const { guardVerdict, shouldInjectGuard } = require('./update-guard.cjs');
const { checkUpdate } = require('./target-update-check.cjs');
const { carveClodeArgs, CLODE_FLAGS, attestReport } = require('./clode-attest.cjs');
require('./host-provision.cjs'); // ensure esbuild bundles it into the SEA for runtime provision('tar')

// Install globalThis.__clodeCheckUpdate exactly as the quaude PRELUDE does
// (extract-claude-js.cjs): a pure check-upstream-and-notify, never an install
// or rebuild. target-update-check.cjs is required with a STATIC specifier here
// (unlike cli.cjs's own baked `require(__dirname + '/target-update-check.cjs')`),
// so esbuild bundles it straight into naude-entry.bundle.cjs — no separate SEA
// asset needed for THIS call site. (cli.cjs's own dynamic require is a
// different consumer with a different resolution rule; see the
// materializeAssets `names` list below for why target-update-check.cjs still
// rides as a materialized asset.) Bun.semver.order is read at CALL time, not
// here, because globalThis.Bun is only set once the baked cli.cjs's own
// prelude has run (its `globalThis.Bun = ... require(bun-shim.cjs)` line runs
// before any of its own code, including the updater that eventually calls
// this) — falls back to a crude string comparator if Bun is somehow absent.
function installCheckUpdateGlobal() {
  globalThis.__clodeCheckUpdate = function (current) {
    const semverOrder = (globalThis.Bun && globalThis.Bun.semver && globalThis.Bun.semver.order)
      ? globalThis.Bun.semver.order
      : (a, b) => (a === b ? 0 : (a > b ? 1 : -1));
    return checkUpdate({ current, env: process.env, semverOrder })
      .then((r) => ({
        wasUpdated: false,
        latestVersion: r.state === 'newer' ? r.latest : null,
        lockFailed: false,
        __clodeState: r.state,
      }))
      .catch(() => ({ wasUpdated: false, latestVersion: null, lockFailed: false, __clodeState: 'unknown' }));
  };
}

// --clode-attest, naude's half. A naude's hashed units are its SEA assets; manifest.json
// names each one's length + sha256, and manifest.sig carries the manifest's own sha256 so
// the document the check is made AGAINST is itself checked (the role a quaude's archive
// index plays). Every asset is read straight out of the executable and re-hashed here.
//
// WHAT IT DOES NOT COVER, stated in the report rather than left to be assumed:
//   * the packages inside deps.tar. The tarball is verified whole, as one member, but
//     naude does not open it — so a declared BOM package being silently ABSENT is a hole
//     quaude's per-package presence check closes and this one does not. Extracting a
//     tarball to answer a read-only question would make attest a side-effecting operation.
//   * the embedded node and the SEA main bundle. Neither is an asset; they are the image
//     this code is executing out of. A quaude has exactly the same gap (its tjs template
//     and its bootstrap bytecode are not archive members), and both products record the
//     engine's build-time sha as `template` instead.
function attestSelf(sea, { hash = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex') } = {}) {
  const asset = (name) => Buffer.from(sea.getRawAsset(name));
  const manifestBytes = asset('manifest.json');
  const manifestSig = asset('manifest.sig').toString('utf8').trim();
  const manifestText = manifestBytes.toString('utf8');
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { manifest = { members: {} }; }

  const members = [];
  for (const [name, rec] of Object.entries(manifest.members || {})) {
    let bytes = null;
    try { bytes = asset(name); } catch { bytes = null; }   // asset missing entirely
    members.push({
      name,
      len: bytes ? bytes.length : 0,
      ok: !!bytes && bytes.length === rec.len && hash(bytes) === rec.sha256,
    });
  }
  // The manifest itself, LAST — mirroring where a quaude's manifest.json lands in its own
  // index order — checked against manifest.sig rather than against itself.
  members.push({ name: 'manifest.json', len: manifestBytes.length, ok: hash(manifestBytes) === manifestSig });

  return attestReport({
    manifestText,
    members,
    notes: ['node_modules rides inside the verified deps.tar member; individual packages are not checked'],
  });
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
    stderr = process.stderr,
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
  // main module. Strip the sentinel so the baked cli.cjs never sees it. Install
  // the notify-only __clodeCheckUpdate global BEFORE requiring cli.cjs (its own
  // baked PRELUDE unconditionally re-assigns the same global once it loads —
  // this call is defense-in-depth for a cli.cjs whose PRELUDE patch didn't
  // apply, not a race).
  const target = env.NAUDE_RUN_AS_NODE;
  if (target) {
    delete env.NAUDE_RUN_AS_NODE;
    installCheckUpdateGlobal();
    requireMain(target, [execPath, target, ...argv]);
    return;
  }

  // Reserved argv namespace: strip `--clode-*` BEFORE anything bundle-visible sees argv,
  // exactly as quaude's bootstrap does and with the same carve function. An unknown flag
  // in the namespace is OUR error to report (exit 64), not one to hand to Claude Code,
  // which would blame it on itself. Everything else passes through in order.
  const carved = carveClodeArgs(argv);
  if (carved.unknown.length) {
    stderr.write(`naude: unknown option '${carved.unknown[0]}' `
      + `(the --clode-* namespace is reserved; known: ${CLODE_FLAGS.join(', ')})\n`);
    exit(64);
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
  } = opts;

  // --clode-attest: the same flag, format and verdict line a quaude prints. Answered from
  // the SEA assets alone — nothing is materialized to disk, nothing is spawned, no deps
  // are unpacked. An attest that boots the product is a launch, not an attest.
  if (carved.clode.includes('--clode-attest')) {
    const report = attestSelf(sea);
    stdout.write(report.text);
    exit(report.ok ? 0 : 1);
    return;
  }
  const argvForChild = carved.rest;

  // Unpack the deps tarball to a sig-keyed cache dir (holds node_modules/), and the
  // baked cli.cjs + bun-shim + target-update-check.cjs into a work dir. workDir is
  // injectable for tests; the default is a stable dir under the deps cache root.
  // target-update-check.cjs rides alongside cli.cjs (not merely bundled into THIS
  // esbuilt entry, above) because cli.cjs's own baked PRELUDE resolves it
  // dynamically as `require(__dirname + '/target-update-check.cjs')` — __dirname
  // there is workDir, so the file must actually exist on disk here or that
  // require 404s the moment the notify-only autoupdater fires (mirrors quaude-
  // fuse.js's product-role member of the same name, same reasoning).
  const depsRoot = materializeDeps({ sea, cacheDir });
  const workDir = opts.workDir || path.join(cacheDir, 'sea-deps', 'naude');
  materializeAssets({ sea, destDir: workDir, names: ['cli.cjs', 'bun-shim.cjs', 'target-update-check.cjs'] });
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
  // must not be conflated. No builder path / target kind is baked: the rebuild
  // updater is retired (Task 3), so the notify-only autoupdater never needs to
  // know what this target is or who built it.
  shapeTargetEnv({
    env: childEnv,
    platform: process.platform,
    delimiter: path.delimiter,
    exists: fs.existsSync,
    isExec: isExecutableFile,
    dirname: path.dirname,
  });

  // Guard injection: wire the model's Bash tool through the update guard by
  // writing an ephemeral PreToolUse settings file and appending --settings to
  // the child's argv. The hook calls back into execPath — the naude's own
  // binary. execPath falsy -> skip entirely (e.g. a bare `require()` in a test,
  // or a context with no known own binary to call back into).
  let guardSettingsFile = null;
  const childArgv = [...argvForChild];
  if (execPath && shouldInjectGuard(childArgv)) {
    guardSettingsFile = path.join(cacheDir || os.tmpdir(), 'clode-guard-' + process.pid + '.json');
    const guardSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '"' + execPath + '" --clode-update-guard' },
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
