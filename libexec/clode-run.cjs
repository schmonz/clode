#!/usr/bin/env node
'use strict';
// clode-run — JS port of bin/clode's bundle-launch path (write_update_guard_settings,
// guard_settings_for_args, exec_bundle). Sets up the host environment and launches the
// extracted cli.cjs under host node. Because a JS launcher cannot `exec` (replace its
// own image) the way the sh launcher did, it spawns the bundle as a child with stdio
// inherited — a two-process stand-in for `exec`. The child stays in the launcher's
// foreground process group, so tty signals reach it directly; the parent ignores those
// (SIGINT/SIGQUIT), forwards only directed signals (SIGTERM/SIGHUP), and mirrors the
// child's exit status. Pure Node stdlib + a require of clode-hosttools (host-env helpers).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const hosttools = require('./clode-hosttools.cjs');
const sea = require('./clode-sea.cjs');
const { cacheBase } = require('./clode-paths.cjs');

// sh `: "${VAR:=value}"` — assign when unset OR empty. Mutates env.
function setIfUnset(env, name, value) {
  if (env[name] == null || env[name] === '') env[name] = value;
}

// Port of write_update_guard_settings. Write a clode-ONLY settings file wiring the
// PreToolUse(Bash) update-guard hook and return its path. Passed via --settings so it
// MERGES with (never overwrites) the user's settings and exists only for clode-launched
// sessions. Absolute node + script paths so the hook runs regardless of the session's
// PATH. Returns null (echoes nothing) if the guard script is missing or the dir can't
// be created.
function writeUpdateGuardSettings(opts = {}) {
  const { node, libexec, env = process.env } = opts;
  const guardScript = path.join(libexec, 'clode-update-guard.cjs');
  // sh `[ -f "$_guard_script" ]` — must be a regular file.
  try {
    if (!fs.statSync(guardScript).isFile()) return null;
  } catch {
    return null;
  }
  const dir = cacheBase(env);
  const out = path.join(dir, 'update-guard-settings.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null; // sh: `mkdir -p ... || return 0`
  }
  // Byte-for-byte the sh printf shape (raw, matching the launcher's printf; trailing \n).
  const cmd = `${node} ${guardScript}`;
  const json = `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":${JSON.stringify(cmd)}}]}]}}\n`;
  try {
    fs.writeFileSync(out, json);
  } catch {
    return null; // sh: `> "$_out" || return 0`
  }
  return out;
}

// Port of guard_settings_for_args. Print-and-exit invocations (--version/-v/--help/-h)
// run no model, so the PreToolUse(Bash) guard can never fire — and passing --settings
// there would needlessly push the bundle onto the settings/render path. Match the FIRST
// arg exactly so a prompt that merely CONTAINS "--version" is not mistaken for the flag.
// Returns the settings path for real sessions, else null.
function guardSettingsForArgs(args = [], opts = {}) {
  const first = args[0];
  switch (first) {
    case '--version':
    case '-v':
    case '--help':
    case '-h':
      return null;
    default:
      return writeUpdateGuardSettings(opts);
  }
}

// Port of exec_bundle's environment setup (order-faithful):
//   DISABLE_INSTALLATION_CHECKS=1, NODE_USE_ENV_PROXY=1 (set-if-unset),
//   maybe_default_cert_store, set_ripgrep_env, set_node_path, CLODE_SELF=self.
// Mutates and returns env.
function applyBundleEnv(opts = {}) {
  const { node, self, libexec, env = process.env } = opts;
  const depsRoot = 'depsRoot' in opts ? opts.depsRoot : env.DEPS_ROOT;
  setIfUnset(env, 'DISABLE_INSTALLATION_CHECKS', '1');
  setIfUnset(env, 'NODE_USE_ENV_PROXY', '1');
  hosttools.certStoreDefault({ env });
  hosttools.applyRipgrepEnv({ env });
  // sh set_node_path derives $HERE/../node_modules; libexec is a sibling of that
  // node_modules (both directly under the package root), so path.resolve(libexec,'..')
  // yields the same package root as path.resolve(HERE,'..'). depsRoot (ensure_deps's
  // DEPS_ROOT, threaded from the launcher) + the node prefix's global node_modules
  // come from the caller/node exactly as in sh's set_node_path.
  hosttools.applyNodePath({ env, here: libexec, depsRoot, node });
  // Hand the bundle's in-TUI autoupdater a way back to this launcher.
  if (self != null) env.CLODE_SELF = self;
  return env;
}

// Port of exec_bundle's launch. Sets up the env (applyBundleEnv), then spawns
//   node cli.cjs [--settings <settingsPath>] <args...>
// with stdio inherited — a two-process stand-in for the sh `exec`.
//
// Signal model (matching exec's single-process observable behavior across two
// processes): the child stays in the launcher's foreground process group, so the
// KERNEL delivers tty-generated signals (Ctrl-C=SIGINT, Ctrl-\=SIGQUIT) to the child
// directly, and its own handlers (the Ink TUI's "press Ctrl-C twice to exit"
// interception) must apply, exactly as under exec. Therefore:
//   - The parent IGNORES tty signals (SIGINT/SIGQUIT) via no-op handlers. This keeps
//     the launcher from dying on Ctrl-C (which would kill it out from under the TUI)
//     AND avoids re-forwarding them to the child (the kernel already delivered them —
//     forwarding would DOUBLE-deliver and break the twice-to-exit UX).
//   - The parent FORWARDS directed signals (SIGTERM/SIGHUP) to the child, since those
//     are sent to the launcher pid only (e.g. `kill <clode-pid>`) and never reach the
//     child on their own.
// On child exit we tear the handlers down and mirror the child's status: a signal
// death becomes 128 + signum (shell $? convention, e.g. 130 for SIGINT) so callers
// see the right exit status; otherwise the child's own exit code.
// spawn/procOn/procOff/exit/stderr are injectable for testing without terminating
// the test process.
function runBundle(opts = {}) {
  const {
    node: nodeArg,
    cliPath,
    args = [],
    settingsPath = null,
    self,
    libexec,
    depsRoot,
    env = process.env,
    spawn: spawnFn = spawn,
    procOn = (s, cb) => process.on(s, cb),
    procOff = (s, cb) => process.removeListener(s, cb),
    exit = (c) => process.exit(c),
    stderr = process.stderr,
    isSea = sea.isSea,
  } = opts;

  // Under a SEA there is no separate host node: the SEA binary IS its own node. Force
  // node=self and set the run-as-node sentinel so the spawned child re-enters
  // clode-main -> runAsNodeIfRequested and executes cli.cjs as plain node would.
  let node = nodeArg;
  if (isSea()) {
    node = process.execPath;
    env.CLODE_SEA_RUN_AS_NODE = '1';
  }

  applyBundleEnv({ node, self, libexec, depsRoot, env });

  const argv = settingsPath ? ['--settings', settingsPath, ...args] : [...args];

  // Experimental opt-in: run the bundle under the patched tjs via node-shim.
  // Default (CLODE_ENGINE unset) is byte-identical to the node path below.
  let child;
  if (env.CLODE_ENGINE === 'tjs') {
    const tjsBin = env.CLODE_TJS || path.join(libexec, '..', 'build', 'tjs', 'tjs');
    const loader = path.join(libexec, 'node-shim', 'loader.cjs');
    child = spawnFn(tjsBin, ['run', loader, cliPath, ...argv], { stdio: 'inherit', env });
  } else {
    child = spawnFn(node, [cliPath, ...argv], { stdio: 'inherit', env });
  }

  // Ignore tty signals (child gets them from the shared group); forward directed ones.
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
  };

  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) { exit(128 + os.constants.signals[signal]); return; }
    exit(code == null ? 1 : code);
  });
  child.on('error', (e) => {
    cleanup();
    stderr.write('clode: failed to launch node: ' + e.message + '\n');
    exit(1);
  });
  return child;
}

module.exports = {
  writeUpdateGuardSettings,
  guardSettingsForArgs,
  applyBundleEnv,
  runBundle,
};
