'use strict';
// Unit tests for libexec/clode-run.cjs — the JS port of bin/clode's bundle-launch
// path. Mirrors the sh-side coverage in test/test_update_guard_wiring.bats for the
// guard-settings wiring, and adds coverage for the exec_bundle env setup + the
// spawn-child (two-process) stand-in for `exec`: ignore tty signals, forward directed
// signals, mirror the child's exit status.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  writeUpdateGuardSettings,
  guardSettingsForArgs,
  applyBundleEnv,
  runBundle,
} = require('../libexec/clode-run.cjs');

const REAL_LIBEXEC = path.resolve(__dirname, '..', 'libexec');
const NODE = process.execPath;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-run-'));
}

// --- writeUpdateGuardSettings ------------------------------------------------
test('writeUpdateGuardSettings emits a clode-only PreToolUse hook settings file', () => {
  const home = tmpdir();
  const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
  const out = writeUpdateGuardSettings({ node: NODE, libexec: REAL_LIBEXEC, env });
  assert.ok(out, 'returns a path');
  assert.ok(fs.existsSync(out), 'file exists');
  const body = fs.readFileSync(out, 'utf8');
  assert.match(body, /"PreToolUse"/);
  assert.match(body, /"matcher":"Bash"/);
  assert.match(body, /clode-update-guard\.cjs/);
  // exact JSON shape + node + guard-script command. The command is JSON.stringify'd by
  // the runtime, so on Windows its backslashes are escaped — assert via JSON.parse (below)
  // rather than byte-for-byte against an un-escaped template (which only matches on POSIX).
  const guard = path.join(REAL_LIBEXEC, 'clode-update-guard.cjs');
  // written under $XDG_CACHE_HOME/clode
  assert.strictEqual(out, path.join(home, 'cache', 'clode', 'update-guard-settings.json'));
  // valid JSON with the expected structure
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.hooks.PreToolUse[0].matcher, 'Bash');
  assert.strictEqual(parsed.hooks.PreToolUse[0].hooks[0].type, 'command');
  assert.strictEqual(parsed.hooks.PreToolUse[0].hooks[0].command, `${NODE} ${guard}`);
});

test('writeUpdateGuardSettings falls back to $HOME/.cache when XDG_CACHE_HOME unset', () => {
  const home = tmpdir();
  const out = writeUpdateGuardSettings({ node: NODE, libexec: REAL_LIBEXEC, env: { HOME: home } });
  assert.strictEqual(out, path.join(home, '.cache', 'clode', 'update-guard-settings.json'));
});

test('writeUpdateGuardSettings returns null if the hook script is absent', () => {
  const empty = tmpdir(); // no clode-update-guard.cjs here
  const home = tmpdir();
  const out = writeUpdateGuardSettings({ node: NODE, libexec: empty, env: { HOME: home } });
  assert.strictEqual(out, null);
});

// --- guardSettingsForArgs ----------------------------------------------------
test('no guard --settings for print-and-exit flags (no model runs)', () => {
  const home = tmpdir();
  const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
  for (const flag of ['--version', '-v', '--help', '-h']) {
    assert.strictEqual(
      guardSettingsForArgs([flag], { node: NODE, libexec: REAL_LIBEXEC, env }),
      null, `expected null for ${flag}`);
  }
});

test('guard --settings IS emitted for a real session invocation', () => {
  const home = tmpdir();
  const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
  const out = guardSettingsForArgs(['explain this code'], { node: NODE, libexec: REAL_LIBEXEC, env });
  assert.ok(out);
  assert.ok(fs.existsSync(out));
  assert.match(fs.readFileSync(out, 'utf8'), /"PreToolUse"/);
});

test('a flag value that is not a real --version flag still gets the guard', () => {
  const home = tmpdir();
  const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
  // canonical flags lead the argv; here --version is only inside a later arg
  const out = guardSettingsForArgs(['-p', 'tell me about --version handling'],
    { node: NODE, libexec: REAL_LIBEXEC, env });
  assert.ok(out);
});

// --- applyBundleEnv ----------------------------------------------------------
test('applyBundleEnv sets the exec_bundle env vars (set-if-unset, CLODE_SELF)', () => {
  const env = {};
  applyBundleEnv({ node: NODE, self: '/path/to/clode', libexec: REAL_LIBEXEC, env });
  assert.strictEqual(env.DISABLE_INSTALLATION_CHECKS, '1');
  assert.strictEqual(env.NODE_USE_ENV_PROXY, '1');
  assert.strictEqual(env.CLODE_SELF, '/path/to/clode');
});

test('applyBundleEnv respects a user-set DISABLE_INSTALLATION_CHECKS / NODE_USE_ENV_PROXY', () => {
  const env = { DISABLE_INSTALLATION_CHECKS: '0', NODE_USE_ENV_PROXY: 'off' };
  applyBundleEnv({ node: NODE, self: 'x', libexec: REAL_LIBEXEC, env });
  assert.strictEqual(env.DISABLE_INSTALLATION_CHECKS, '0');
  assert.strictEqual(env.NODE_USE_ENV_PROXY, 'off');
});

// --- runBundle: spawn shape + env --------------------------------------------
function fakeChild() {
  const c = new EventEmitter();
  c.killed = [];
  c.kill = (sig) => { c.killed.push(sig); return true; };
  return c;
}

test('runBundle spawns node with cli.cjs + --settings + args, stdio inherit, mutated env', () => {
  const env = { CLODE_ENGINE: 'node' }; // the host-Node oracle path (default is tjs)
  let call = null;
  const child = fakeChild();
  runBundle({
    node: NODE, cliPath: '/cache/cli.cjs', args: ['-p', 'hi'],
    settingsPath: '/cache/clode/guard.json', self: '/self/clode', libexec: REAL_LIBEXEC, env,
    spawn: (cmd, a, o) => { call = { cmd, a, o }; return child; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
  });
  assert.strictEqual(call.cmd, NODE);
  assert.deepStrictEqual(call.a, ['/cache/cli.cjs', '--settings', '/cache/clode/guard.json', '-p', 'hi']);
  assert.strictEqual(call.o.stdio, 'inherit');
  assert.strictEqual(call.o.env, env);
  assert.strictEqual(env.DISABLE_INSTALLATION_CHECKS, '1');
  assert.strictEqual(env.CLODE_SELF, '/self/clode');
});

test('runBundle omits --settings when settingsPath is null', () => {
  let call = null;
  const child = fakeChild();
  runBundle({
    node: NODE, cliPath: '/cache/cli.cjs', args: ['--version'], settingsPath: null,
    self: 'x', libexec: REAL_LIBEXEC, env: { CLODE_ENGINE: 'node' },
    spawn: (cmd, a) => { call = { cmd, a }; return child; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
  });
  assert.deepStrictEqual(call.a, ['/cache/cli.cjs', '--version']);
});

// --- runBundle: exit-code + signal semantics ---------------------------------
test('runBundle passes through the child exit code', () => {
  const child = fakeChild();
  let exited = null;
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, procOff: () => {},
  });
  child.emit('exit', 3, null);
  assert.strictEqual(exited, 3);
});

test('runBundle maps a null exit code to 1', () => {
  const child = fakeChild();
  let exited = null;
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, procOff: () => {},
  });
  child.emit('exit', null, null);
  assert.strictEqual(exited, 1);
});

test('runBundle exits 128+signum when the child is killed by a signal', () => {
  const child = fakeChild();
  let exited = 'unset';
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, procOff: () => {}, exit: (c) => { exited = c; },
  });
  child.emit('exit', null, 'SIGINT');
  // shell $? convention: 128 + signal number (130 for SIGINT)
  assert.strictEqual(exited, 128 + os.constants.signals.SIGINT);
});

test('runBundle ignores tty signals (SIGINT/SIGQUIT) and forwards directed signals (SIGTERM/SIGHUP)', () => {
  const child = fakeChild();
  const handlers = {};
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: (s, cb) => { handlers[s] = cb; }, procOff: () => {}, exit: () => {},
  });
  // all four are registered on the parent...
  for (const s of ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP']) {
    assert.strictEqual(typeof handlers[s], 'function', `handler registered for ${s}`);
  }
  // ...but tty signals (delivered to the child by the shared group) are NO-OPs:
  // forwarding them would double-deliver and break the TUI's twice-to-exit UX.
  handlers.SIGINT();
  handlers.SIGQUIT();
  assert.deepStrictEqual(child.killed, [], 'tty signals must not be forwarded');
  // directed signals reach only the launcher pid, so they ARE forwarded to the child.
  handlers.SIGTERM();
  handlers.SIGHUP();
  assert.deepStrictEqual(child.killed, ['SIGTERM', 'SIGHUP']);
});

test('runBundle removes its signal handlers when the child exits', () => {
  const child = fakeChild();
  const registered = new Set();
  const removed = new Set();
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child,
    procOn: (s) => { registered.add(s); },
    procOff: (s) => { removed.add(s); },
    exit: () => {},
  });
  child.emit('exit', 0, null);
  assert.deepStrictEqual([...removed].sort(), [...registered].sort(),
    'every registered signal handler is torn down on exit');
});

test('runBundle reports a launch error and exits 1', () => {
  const child = fakeChild();
  let exited = null;
  let msg = '';
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC,
    env: { CLODE_ENGINE: 'node' },
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, procOff: () => {},
    stderr: { write: (s) => { msg += s; } },
  });
  child.emit('error', new Error('boom'));
  assert.strictEqual(exited, 1);
  assert.match(msg, /clode: failed to launch node: boom/);
});

// S4: the default (tjs) launch has NO silent host-Node fallback. When the engine
// can't launch, fail loud pointing to build-tjs / CLODE_TJS / the =node oracle.
test('runBundle default(tjs) launch failure fails loud with build/oracle guidance', () => {
  const child = fakeChild();
  let exited = null;
  let msg = '';
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC,
    env: {}, // unset CLODE_ENGINE => tjs (the default)
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, procOff: () => {},
    stderr: { write: (s) => { msg += s; } },
  });
  child.emit('error', new Error('ENOENT'));
  assert.strictEqual(exited, 1);
  assert.match(msg, /failed to launch tjs/);
  assert.match(msg, /build-tjs\.mjs/);
  assert.match(msg, /CLODE_ENGINE=node/);
  assert.doesNotMatch(msg, /failed to launch node/); // no node fallback message
});

// --- runBundle: real spawn (exit-code passthrough end to end) -----------------
test('runBundle really spawns node and passes through its exit code', () => {
  return new Promise((resolve, reject) => {
    const dir = tmpdir();
    const cli = path.join(dir, 'fake-cli.cjs');
    fs.writeFileSync(cli, 'process.exit(7);\n');
    runBundle({
      node: NODE, cliPath: cli, args: [], settingsPath: null, self: 'x',
      libexec: REAL_LIBEXEC, env: { ...process.env },
      procOn: () => {}, procOff: () => {},
      exit: (c) => {
        try { assert.strictEqual(c, 7); resolve(); } catch (e) { reject(e); }
      },
    });
  });
});

// --- runBundle: end-to-end exit-status mapping, SAFELY isolated ----------------
// This exercises the REAL child.on('exit') path (code AND signal) without the test
// process ever ORIGINATING a signal. We spawn a helper that calls runBundle with a
// fake bundle; when the signal case is under test the fake bundle KILLS ITSELF
// (process.kill(process.pid, ...)). The helper is spawned {detached:true} so it is a
// new session/process-group leader — fully isolated from this test's group — and the
// only signal in play is the grandchild signalling its own pid. Nothing here can
// reach the test runner's process group.
const { spawn: realSpawn } = require('node:child_process');

function runHelper(cliBody) {
  return new Promise((resolve, reject) => {
    const dir = tmpdir();
    const cli = path.join(dir, 'fake-cli.cjs');
    fs.writeFileSync(cli, cliBody);
    const helper = path.join(dir, 'helper.cjs');
    const runPath = path.resolve(REAL_LIBEXEC, 'clode-run.cjs');
    fs.writeFileSync(helper,
      `const { runBundle } = require(${JSON.stringify(runPath)});\n` +
      `runBundle({\n` +
      `  node: process.execPath,\n` +
      `  cliPath: ${JSON.stringify(cli)},\n` +
      `  args: [], settingsPath: null, self: 'x',\n` +
      `  libexec: ${JSON.stringify(REAL_LIBEXEC)},\n` +
      `  env: { ...process.env },\n` +
      `});\n`);
    // detached:true => new session + process group; the helper (and its grandchild)
    // are isolated from the test runner's group. stdio ignored to keep output clean.
    const proc = realSpawn(process.execPath, [helper], { detached: true, stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('runBundle (real, isolated): a self-signalled child maps to 128+signum', {
  skip: process.platform === 'win32'
    ? 'real POSIX signal self-delivery has no Windows analog; the 128+signum mapping logic is covered by the fakeChild unit test above'
    : false,
}, async () => {
  // The fake bundle kills ITSELF with SIGTERM; runBundle must exit 128+15 = 143.
  const { code, signal } = await runHelper("process.kill(process.pid, 'SIGTERM');\n");
  assert.strictEqual(signal, null, 'the launcher itself exits normally, not by signal');
  assert.strictEqual(code, 128 + os.constants.signals.SIGTERM);
});

test('runBundle (real, isolated): a child that exits 7 maps to 7', async () => {
  const { code } = await runHelper('process.exit(7);\n');
  assert.strictEqual(code, 7);
});

test('runBundle (real, isolated): a child that exits 0 maps to 0', async () => {
  const { code } = await runHelper('process.exit(0);\n');
  assert.strictEqual(code, 0);
});
