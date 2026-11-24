'use strict';
// updater-off.cjs — no Claude Code a test drives updates its own install. ONE implementation of the knob, used by every
// place a test spawns native or quaude.
//
// WHY. linux-x64-pty (CI 45354661143, 45381323279) installed the pinned native with `npm i -g` at 11:13; at 12:06 the
// step that staged it found a binary it could not decode. In between the job drove that native interactively, and
// test/tool-driver.cjs's env had no DISABLE_AUTOUPDATER (test/frame-oracle.cjs's always had). An instrument mutated
// mid-job is the CLASS: scripts/record-provider.mjs now makes a changed provider a named refusal, and this module is the
// prevention. DISABLE_AUTOUPDATER=1 on BOTH sides (native and quaude): what a turn is judged on is never the updater, and
// one knob for both keeps the comparison symmetric (quaude's installers are spliced out anyway, notify-only:
// libexec/extract-claude-js.cjs patchLegacyAutoupdater).
//
//   updaterOff(env, because?)  -> a copy of env with DISABLE_AUTOUPDATER=1; or, when `because` (a non-empty written
//                                 reason) is given, with it REMOVED and the reason carried as CLODE_AUTOUPDATER_BECAUSE,
//                                 for the test that exercises update behaviour on purpose. An env that already carries
//                                 a reason (a helper handing its env to another: tool-driver to e2e-pty) keeps it.
//   refuseUpdaterOn(env, what) -> env, or throws naming `what`: neither the knob nor a written reason. The helpers that
//                                 spawn (tui-screen.cjs for every PTY drive, tool-driver.cjs for every -p turn) call it
//                                 on the env they are about to hand the child.
//   ambient(env)               -> sets the knob on env (process.env) unless the caller already decided; test/run.mjs and
//                                 test/file-watchdog-preload.cjs (every CI `node --test` step) call it, so a spawn that
//                                 inherits the environment inherits the knob.
//   installSpawnTripwire(cp, env) -> wraps child_process so a spawn of a native Claude Code (a binary named `claude`, or
//                                 the path any of NATIVE_ENVS names) with an env lacking both refuses by name. This is
//                                 the hole the ambient default leaves: an env CONSTRUCTED for the child, which inherits
//                                 nothing. Installed by test/file-watchdog-preload.cjs.
const path = require('node:path');

const KNOB = 'DISABLE_AUTOUPDATER';
const BECAUSE = 'CLODE_AUTOUPDATER_BECAUSE';
// Every variable a test resolves a native (or built quaude) binary from.
const NATIVE_ENVS = ['CLODE_NATIVE_ORACLE', 'CLODE_NATIVE_CLAUDE', 'CLODE_CLAUDE_BIN', 'CLODE_PROVIDER_BIN',
  'CLODE_DARWIN_PROVIDER_BIN', 'CLODE_QUAUDE'];

function reasonOf(because) {
  if (typeof because !== 'string' || !because.trim()) {
    throw new Error(`autoUpdaterBecause must be a non-empty written reason (got ${JSON.stringify(because)}): a test that `
      + `leaves ${KNOB} unset says why`);
  }
  return because.trim();
}

function updaterOff(env, because) {
  const out = { ...(env || {}) };
  if (because === undefined || because === null) {
    if (typeof out[BECAUSE] === 'string' && out[BECAUSE].trim()) { delete out[KNOB]; return out; }   // decided upstream
    out[KNOB] = '1';
    delete out[BECAUSE];
  } else {
    out[BECAUSE] = reasonOf(because);
    delete out[KNOB];
  }
  return out;
}

function why(env) {
  if (!env) return null;
  if (env[KNOB] === '1') return null;
  if (typeof env[BECAUSE] === 'string' && env[BECAUSE].trim()) return null;
  return env[KNOB] === undefined ? `${KNOB} is unset` : `${KNOB}=${JSON.stringify(env[KNOB])}, not "1"`;
}

function refuseUpdaterOn(env, what) {
  const w = why(env);
  if (w) {
    throw new Error(`${what}: refusing to spawn a Claude Code whose updater may run: ${w}, and no ${BECAUSE} says why. `
      + 'A native left to itself updates its own install mid-job (CI 45354661143). Build the env with '
      + 'test/updater-off.cjs updaterOff(env), or pass autoUpdaterBecause: "<reason>" where the update IS the test.');
  }
  return env;
}

function ambient(env) {
  if (env[KNOB] === undefined && env[BECAUSE] === undefined) env[KNOB] = '1';
  return env;
}

// A command is native Claude Code when it is named `claude` (how `command -v claude` and an npm global install name
// it) or is the very path a native-resolving variable names.
function isNativeCommand(cmd, env) {
  if (typeof cmd !== 'string' || !cmd) return false;
  if (/^claude(\.exe)?$/i.test(path.basename(cmd))) return true;
  const abs = path.resolve(cmd);
  return NATIVE_ENVS.some((k) => env && env[k] && path.resolve(env[k]) === abs);
}

// The env a child_process call hands the child: its options.env, or (absent) the parent's.
function childEnv(opts, parentEnv) { return opts && opts.env ? opts.env : parentEnv; }

const WRAPPED = Symbol.for('clode.updaterTripwire');
function installSpawnTripwire(cp = require('node:child_process'), parentEnv = process.env) {
  if (cp[WRAPPED]) return cp;
  // (file, args?, options?, ...): the options are the argument after an args array, else the one after file.
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function updaterTripwire(...a) {
      const [file, args] = a;
      const o = Array.isArray(args) ? a[2] : args;
      // argv0 `rg`: native dispatches to its embedded ripgrep (scripts/lib/rg-probe.cjs runNativeRg) and never starts
      // Claude Code, so there is no updater to run.
      const asRg = o && typeof o === 'object' && o.argv0 === 'rg';
      if (!asRg && isNativeCommand(file, parentEnv)) {
        refuseUpdaterOn(childEnv(o && typeof o === 'object' ? o : null, parentEnv), `child_process.${name}(${file})`);
      }
      return orig.apply(this, a);
    };
  }
  Object.defineProperty(cp, WRAPPED, { value: true });
  return cp;
}

module.exports = { KNOB, BECAUSE, NATIVE_ENVS, updaterOff, refuseUpdaterOn, ambient, isNativeCommand, installSpawnTripwire,
  whyUpdaterOn: why };
