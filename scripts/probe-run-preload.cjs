'use strict';
// Runner-only observability preload for scripts/probe-run.mjs. Loaded via
// `node --require <this> --test <files>` around the agentic/interactive
// corpora, NEVER shipped and NEVER affecting the shim itself.
//
// Two problems this solves, both because those corpora spawn quaude as a
// GRANDCHILD of this process and were not written with probing in mind:
//
// 1. Env propagation: test/fidelity/agentic-*.test.cjs and
//    test/node-shim-agentic.test.cjs spread `{...process.env}` into the
//    child env, so setting CLODE_SHIM_PROBE=1 on THIS process's env is
//    enough for them. But e2e.cjs's sandbox()/capture() (used by
//    test/fidelity/interactive-*.test.cjs) construct an explicit env object
//    that does NOT inherit process.env at all — CLODE_SHIM_PROBE would never
//    reach that grandchild no matter what this process's env holds. Patching
//    node:child_process here, once, covers both shapes uniformly: add the
//    flag to whatever options object each spawn call already built, whether
//    or not that object happened to start from process.env.
//
// 2. Stdio capture: these harnesses read the grandchild's stdout/stderr into
//    local JS strings for their own assertions and never forward those bytes
//    to this process's real stderr — so a [probe] line the grandchild wrote
//    is otherwise invisible to probe-run.mjs, which can only see what THIS
//    process (the `node --test` child it spawned) writes to its own stderr.
//    Attaching a second listener (async spawn) / teeing the return value
//    (sync spawn) does not change what the harness's own listener/return
//    value sees — it only ALSO relays the same bytes, prefixed, to this
//    process's stderr. BOTH stdout and stderr are relayed, not just stderr:
//    the interactive corpus runs quaude inside a real PTY (node-pty), and a
//    PTY gives a child ONE fd for stdout+stderr — test/tui-screen.cjs reads
//    that combined stream and prints the rendered screen to ITS OWN stdout,
//    which test/e2e-pty.cjs's capture() then captures as `r.stdout` (not
//    stderr) via this exact spawnSync. Relaying only stderr silently
//    discarded every [probe] line the PTY path produced (found in review:
//    interactive contributed hits but zero unique keys vs apicheck/agentic).
//
// Every function here is additive: it forwards to the real
// node:child_process implementation with an env object that has exactly one
// key added, and otherwise passes every argument through unchanged. It does
// not touch libexec/ (the shim under measurement) at all.
const cp = require('node:child_process');
const FLAG = 'CLODE_SHIM_PROBE';
const RELAY_PREFIX = '[probe-relay] ';

function withFlag(env) {
  return { ...(env || process.env), [FLAG]: '1' };
}

// The options object is whichever trailing argument is a plain object (not
// an array — argv lists — and not a function — exec/execFile callbacks).
// Every call shape used by the corpora this preload targets (spawn(cmd,
// argv, opts), spawn(cmd, opts), spawnSync(cmd, argv, opts), execFileSync(cmd,
// argv, opts)) fits this scan from the end.
function findOptsIndex(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a && typeof a === 'object' && !Array.isArray(a)) return i;
  }
  return -1;
}
function injectFlag(args) {
  const i = findOptsIndex(args);
  if (i !== -1) args[i] = { ...args[i], env: withFlag(args[i].env) };
  return args;
}
function relay(chunk) {
  try { process.stderr.write(RELAY_PREFIX + String(chunk)); } catch { /* best effort */ }
}

const origSpawn = cp.spawn;
cp.spawn = function patchedSpawn(...args) {
  const child = origSpawn.apply(this, injectFlag(args));
  if (child && child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', relay);
  }
  if (child && child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', relay);
  }
  return child;
};

const origSpawnSync = cp.spawnSync;
cp.spawnSync = function patchedSpawnSync(...args) {
  const r = origSpawnSync.apply(this, injectFlag(args));
  if (r && r.stdout) relay(r.stdout);
  if (r && r.stderr) relay(r.stderr);
  return r;
};

for (const name of ['execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const orig = cp[name];
  if (typeof orig !== 'function') continue;
  cp[name] = function patched(...args) {
    return orig.apply(this, injectFlag(args));
  };
}
