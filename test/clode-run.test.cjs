'use strict';
// Unit tests for libexec/clode-run.cjs — the JS port of bin/clode's bundle-launch
// path. Mirrors the sh-side coverage in test/test_update_guard_wiring.bats for the
// guard-settings wiring, and adds coverage for the exec_bundle env setup + the
// spawn-child-with-signal-forwarding stand-in for `exec`.
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
  // exact JSON shape (byte-for-byte with sh printf) + node + guard-script command
  const guard = path.join(REAL_LIBEXEC, 'clode-update-guard.cjs');
  assert.strictEqual(
    body,
    `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${NODE} ${guard}"}]}]}}\n`);
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
  const env = {};
  let call = null;
  const child = fakeChild();
  runBundle({
    node: NODE, cliPath: '/cache/cli.cjs', args: ['-p', 'hi'],
    settingsPath: '/cache/clode/guard.json', self: '/self/clode', libexec: REAL_LIBEXEC, env,
    spawn: (cmd, a, o) => { call = { cmd, a, o }; return child; },
    procOn: () => {}, exit: () => {}, killParent: () => {},
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
    self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: (cmd, a) => { call = { cmd, a }; return child; },
    procOn: () => {}, exit: () => {}, killParent: () => {},
  });
  assert.deepStrictEqual(call.a, ['/cache/cli.cjs', '--version']);
});

// --- runBundle: exit-code + signal semantics ---------------------------------
test('runBundle passes through the child exit code', () => {
  const child = fakeChild();
  let exited = null;
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, killParent: () => {},
  });
  child.emit('exit', 3, null);
  assert.strictEqual(exited, 3);
});

test('runBundle maps a null exit code to 1', () => {
  const child = fakeChild();
  let exited = null;
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, killParent: () => {},
  });
  child.emit('exit', null, null);
  assert.strictEqual(exited, 1);
});

test('runBundle re-raises a killing signal instead of exiting', () => {
  const child = fakeChild();
  let exited = 'unset';
  let raised = null;
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, killParent: (s) => { raised = s; },
  });
  child.emit('exit', null, 'SIGINT');
  assert.strictEqual(raised, 'SIGINT');
  assert.strictEqual(exited, 'unset', 'exit() must not be called when the child was signalled');
});

test('runBundle forwards terminating signals to the child', () => {
  const child = fakeChild();
  const handlers = {};
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: (s, cb) => { handlers[s] = cb; }, exit: () => {}, killParent: () => {},
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    assert.strictEqual(typeof handlers[s], 'function', `handler registered for ${s}`);
    handlers[s]();
  }
  assert.deepStrictEqual(child.killed, ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
});

test('runBundle reports a launch error and exits 1', () => {
  const child = fakeChild();
  let exited = null;
  let msg = '';
  runBundle({
    node: NODE, cliPath: '/cli.cjs', args: [], settingsPath: null, self: 'x', libexec: REAL_LIBEXEC, env: {},
    spawn: () => child, procOn: () => {}, exit: (c) => { exited = c; }, killParent: () => {},
    stderr: { write: (s) => { msg += s; } },
  });
  child.emit('error', new Error('boom'));
  assert.strictEqual(exited, 1);
  assert.match(msg, /clode: failed to launch node: boom/);
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
      procOn: () => {}, killParent: () => {},
      exit: (c) => {
        try { assert.strictEqual(c, 7); resolve(); } catch (e) { reject(e); }
      },
    });
  });
});
