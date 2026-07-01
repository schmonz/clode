#!/usr/bin/env node
'use strict';
// clode-run — JS port of bin/clode's bundle-launch path (write_update_guard_settings,
// guard_settings_for_args, exec_bundle). Sets up the host environment and launches the
// extracted cli.cjs under host node. Because a JS launcher cannot `exec` (replace its
// own image) the way the sh launcher does, it spawns the bundle as a child with
// stdio inherited and forwards the terminating signals — a faithful stand-in for
// `exec`, including re-raising a killing signal so the parent's exit status reflects
// it. Pure Node stdlib + a require of clode-hosttools (the host-env helpers).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const hosttools = require('./clode-hosttools.cjs');

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
  // sh `${XDG_CACHE_HOME:-$HOME/.cache}/clode` — :- is unset-or-empty.
  const cacheBase = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME !== ''
    ? env.XDG_CACHE_HOME
    : path.join(env.HOME || '', '.cache');
  const dir = path.join(cacheBase, 'clode');
  const out = path.join(dir, 'update-guard-settings.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null; // sh: `mkdir -p ... || return 0`
  }
  // Byte-for-byte the sh printf shape (raw, matching the launcher's printf; trailing \n).
  const cmd = `${node} ${guardScript}`;
  const json = `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${cmd}"}]}]}}\n`;
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
// with stdio inherited, forwarding INT/TERM/HUP/QUIT to the child and re-raising a
// killing signal so this process's exit status mirrors the child's — the faithful
// stand-in for the sh `exec`. spawn/procOn/exit/killParent/stderr are injectable for
// testing without terminating the test process.
function runBundle(opts = {}) {
  const {
    node,
    cliPath,
    args = [],
    settingsPath = null,
    self,
    libexec,
    depsRoot,
    env = process.env,
    spawn: spawnFn = spawn,
    procOn = (s, cb) => process.on(s, cb),
    exit = (c) => process.exit(c),
    killParent = (sig) => process.kill(process.pid, sig),
    stderr = process.stderr,
  } = opts;

  applyBundleEnv({ node, self, libexec, depsRoot, env });

  const argv = settingsPath ? ['--settings', settingsPath, ...args] : [...args];
  const child = spawnFn(node, [cliPath, ...argv], { stdio: 'inherit', env });

  const fwd = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
  for (const s of fwd) procOn(s, () => { try { child.kill(s); } catch {} });

  child.on('exit', (code, signal) => {
    if (signal) { killParent(signal); return; } // re-raise so exit status reflects the signal
    exit(code == null ? 1 : code);
  });
  child.on('error', (e) => {
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
