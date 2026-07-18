'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { runNaude } = require('../libexec/naude-entry.cjs');

function fakeSea() {
  const assets = { 'cli.cjs': 'CLI', 'bun-shim.cjs': 'SHIM', 'deps.tar': '', 'deps.sig': 'sig0' };
  return { isSea: () => true, getRawAsset: (n) => { const b = Buffer.from(assets[n] || ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}

// The default `sea` MUST be the node:sea module — the thing whose getRawAsset the
// materializers call. Passing naude-sea.cjs (the HELPERS module) here type-checks
// and unit-passes, then dies in the real SEA with "sea.getRawAsset is not a
// function" on the very first boot. Every other test in this file injects both a
// fake sea AND stubbed materializers, so nothing else exercises this seam: assert
// on the DEFAULT, with only the materializers stubbed, or the bug hides again.
test('first pass defaults `sea` to the node:sea module, not the helpers module', () => {
  const seen = {};
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    // NOTE: no `sea` override — the default is what is under test.
    materializeDeps: ({ sea }) => { seen.deps = sea; return '/deps'; },
    materializeAssets: ({ sea, destDir }) => { seen.assets = sea; return destDir; },
    spawn: () => ({ on() {} }),
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  for (const [who, sea] of Object.entries(seen)) {
    assert.strictEqual(typeof sea?.getRawAsset, 'function',
      `materialize${who === 'deps' ? 'Deps' : 'Assets'} was handed an object with no getRawAsset — it cannot read a single embedded asset`);
    assert.strictEqual(typeof sea?.isSea, 'function', 'the sea seam must be the node:sea module');
  }
  assert.ok(!('materializeDeps' in (seen.deps || {})),
    'the helpers module leaked in as `sea` — that is the shape of the boot-killing bug');
});

// A fake child that records the signals it is asked to kill with (mirrors the
// clode-run.test.cjs fakeChild, adapted to naude's spawn seam shape which returns
// a plain object rather than an EventEmitter — naude drives exit via the onExit seam).
function fakeChild() {
  return { killed: [], kill(sig) { this.killed.push(sig); return true; }, on() {} };
}

// Run the first pass with sensible defaults, letting the caller override seams and
// capture what happened. Returns { call, child, exited, handlers, registered, removed }.
function firstPass(overrides = {}) {
  const captured = { call: null, exited: 'unset', handlers: {}, registered: [], removed: [] };
  const child = overrides.child || fakeChild();
  runNaude(Object.assign({
    argv: ['--version'], execPath: '/naude',
    sea: fakeSea(), env: {}, cacheDir: os.tmpdir(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    workDir: '/work',
    spawn: (cmd, args, opts) => { captured.call = { cmd, args, opts }; return child; },
    procOn: (s, cb) => { captured.handlers[s] = cb; captured.registered.push(s); },
    procOff: (s) => { captured.removed.push(s); },
    exit: (c) => { captured.exited = c; },
  }, overrides));
  captured.child = child;
  return captured;
}

test('first pass (isSea, no sentinel) re-invokes execPath in run-as-node with cli.cjs + NODE_PATH', () => {
  let call = null; let exited = null;
  runNaude({
    argv: ['--version'], execPath: '/naude',
    sea: fakeSea(), env: {}, cacheDir: require('os').tmpdir(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    workDir: '/work',
    spawn: (cmd, args, opts) => { call = { cmd, args, opts }; return { on(){}, }; },
    procOn: () => {}, procOff: () => {}, exit: (c) => { exited = c; },
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.cmd, '/naude');
  // path.join/-delimiter, not POSIX literals: runNaude builds these with
  // path.join, so on Windows they come back '\work\cli.cjs' and
  // '\deps\node_modules'. Literals here asserted a POSIX-only shape and failed
  // every windows-latest run. (The test at :160 below already had this right.)
  assert.strictEqual(call.opts.env.NAUDE_RUN_AS_NODE, path.join('/work', 'cli.cjs'));
  assert.ok(call.opts.env.NODE_PATH.includes(path.join('/deps', 'node_modules')),
    `NODE_PATH lacks the materialized deps dir: ${call.opts.env.NODE_PATH}`);
  assert.deepStrictEqual(call.args, ['--version']);
  assert.strictEqual(exited, 0);
});

test('second pass (sentinel set) runs the target cli.cjs as main', () => {
  let required = null;
  const env = { NAUDE_RUN_AS_NODE: '/work/cli.cjs' };
  runNaude({
    argv: ['--version'], execPath: '/naude',
    env,
    requireMain: (p, argv) => { required = { p, argv }; },
  });
  assert.strictEqual(required.p, '/work/cli.cjs');
  assert.deepStrictEqual(required.argv, ['/naude', '/work/cli.cjs', '--version']);
  // Minor: the sentinel is stripped before the target runs, so the baked cli.cjs
  // never sees NAUDE_RUN_AS_NODE (and never mistakes itself for a first pass).
  assert.ok(!('NAUDE_RUN_AS_NODE' in env), 'sentinel deleted from the target env');
});

// --- first pass: exit-status mapping (ports of clode-run's exit semantics) ----
test('first pass: a signal death maps to 128+signum (SIGTERM -> 143)', () => {
  const { exited } = firstPass({ onExit: (cb) => cb(null, 'SIGTERM') });
  assert.strictEqual(exited, 128 + os.constants.signals.SIGTERM);
  assert.strictEqual(exited, 143);
});

test('first pass: a null exit code maps to 1', () => {
  const { exited } = firstPass({ onExit: (cb) => cb(null, null) });
  assert.strictEqual(exited, 1);
});

test('first pass: a non-zero exit code passes through', () => {
  const { exited } = firstPass({ onExit: (cb) => cb(7, null) });
  assert.strictEqual(exited, 7);
});

// --- first pass: signal model (tty vs directed) -------------------------------
test('first pass: ignores tty signals (SIGINT/SIGQUIT), forwards directed (SIGTERM/SIGHUP)', () => {
  const cap = firstPass({ onExit: () => {} });
  for (const s of ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP']) {
    assert.strictEqual(typeof cap.handlers[s], 'function', `handler registered for ${s}`);
  }
  // tty signals reach the child directly via the shared foreground group; forwarding
  // would double-deliver, so these handlers are NO-OPs.
  cap.handlers.SIGINT();
  cap.handlers.SIGQUIT();
  assert.deepStrictEqual(cap.child.killed, [], 'tty signals must not be forwarded');
  // directed signals reach only our pid, so they ARE forwarded to the child.
  cap.handlers.SIGTERM();
  cap.handlers.SIGHUP();
  assert.deepStrictEqual(cap.child.killed, ['SIGTERM', 'SIGHUP']);
});

test('first pass: every registered signal handler is torn down when the child exits', () => {
  const cap = firstPass({ onExit: (cb) => cb(0, null) });
  assert.deepStrictEqual([...cap.removed].sort(), [...cap.registered].sort(),
    'every registered signal handler is removed on exit');
});

// --- first pass: NAUDE_CACHE env plumbs the deps-materialization cache dir -----
test('first pass: NAUDE_CACHE env sets the cacheDir passed to materializeDeps', () => {
  let seenCacheDir = null;
  runNaude({
    argv: ['--version'], execPath: '/naude',
    sea: fakeSea(), env: { NAUDE_CACHE: '/custom' },
    materializeDeps: ({ cacheDir }) => { seenCacheDir = cacheDir; return '/deps'; },
    materializeAssets: ({ destDir }) => destDir,
    spawn: () => ({ on() {} }),
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(seenCacheDir, '/custom');
});

// --- first pass: NODE_PATH prepend preserves a prior value --------------------
test('first pass: NODE_PATH prepends the deps node_modules, preserving a prior value', () => {
  const { call } = firstPass({ env: { NODE_PATH: '/pre' }, onExit: () => {} });
  assert.strictEqual(
    call.opts.env.NODE_PATH,
    path.join('/deps', 'node_modules') + path.delimiter + '/pre');
});

// --- first pass: the target-env contract lands in the child's env ------------
test('first pass shapes the child env with the target contract', () => {
  let call = null;
  runNaude({
    argv: [], execPath: '/naude', env: { PATH: '/usr/bin' }, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  // The contract the runner used to apply at launch; naude applies it to itself.
  assert.strictEqual(call.env.DISABLE_INSTALLATION_CHECKS, '1');
  assert.strictEqual(call.env.NODE_USE_ENV_PROXY, '1');
  // NODE_PATH stays naude's own business (materialized deps), not target-env's.
  // path.join, not a POSIX literal — see the note at the first-pass test above.
  assert.ok(call.env.NODE_PATH.includes(path.join('/deps', 'node_modules')),
    `NODE_PATH lacks the materialized deps dir: ${call.env.NODE_PATH}`);
  // No `builder` override here (the default seam) -> bakedBuilder(sea) is null
  // for this fakeSea() (no getAsset) -> CLODE_SELF must stay unset. A regression
  // in that guard would otherwise go unnoticed by every OTHER test in this file
  // (they all pass `builder` explicitly).
  assert.strictEqual(call.env.CLODE_SELF, undefined, 'no builder baked -> updater must fail loud, not spawn something wrong');
});

test('first pass points CLODE_SELF at the clode that built this naude', () => {
  let call = null;
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    builder: '/usr/local/bin/clode',            // an explicit override (not the asset seam)
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.env.CLODE_SELF, '/usr/local/bin/clode',
    'a baked naude cannot update itself; the in-TUI updater must call the builder');
});

// --- the DEFAULT builder path: sourced from the SEA `builder` asset, not an -----
// --- esbuild define. [[naude-real-on-node24-host]]: over-stubbed DI tests once ---
// --- let a 100%-fatal boot bug ship green because EVERY test stubbed both `sea` --
// --- and `builder`, so the seam between them never ran. These two tests pass a --
// --- fake `sea` and DELIBERATELY do NOT override `builder`, so the real default -
// --- (reading `sea.getAsset('builder', 'utf8')`) is what's under test.
test('first pass: no `builder` override -> reads the builder asset off the real `sea` seam', () => {
  let call = null;
  const sea = Object.assign(fakeSea(), {
    getAsset: (name, enc) => {
      if (name !== 'builder') throw new Error(`no such asset: ${name}`);
      assert.strictEqual(enc, 'utf8');
      return '/usr/local/bin/clode';
    },
  });
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea,
    // NOTE: no `builder` override — the default (bakedBuilder(sea)) is under test.
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.env.CLODE_SELF, '/usr/local/bin/clode',
    'the default builder path must come from the sea.getAsset(\'builder\') seam');
});

test('first pass declares CLODE_TARGET_KIND=naude and CLODE_TARGET=<the naude exe>', () => {
  let call = null;
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.env.CLODE_TARGET_KIND, 'naude');
  assert.strictEqual(call.env.CLODE_TARGET, '/naude');
});

// --- guard dispatch: `--clode-update-guard` short-circuits everything else ----
// A fake stdin that synchronously drives the standard flowing-mode `.on('data',
// ...)` / `.on('end', ...)` pair naude-entry uses to read stdin — matches how a
// real process.stdin behaves closely enough for this seam (data emitted before
// end), without needing a real stream.
function fakeStdin(jsonStr) {
  return {
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(jsonStr));
      if (event === 'end') cb();
      return this;
    },
  };
}

function fakeStdout() {
  const chunks = [];
  return { chunks, write(s) { chunks.push(s); } };
}

test('guard dispatch: --clode-update-guard reads stdin, emits the deny verdict, exits 0, never spawns', () => {
  const stdout = fakeStdout();
  let exited = 'unset';
  let spawnCalled = false;
  runNaude({
    argv: ['--clode-update-guard'],
    stdin: fakeStdin(JSON.stringify({ tool_input: { command: 'claude update' } })),
    stdout,
    exit: (c) => { exited = c; },
    spawn: () => { spawnCalled = true; return { on() {} }; },
  });
  assert.strictEqual(exited, 0);
  assert.strictEqual(spawnCalled, false, 'the bundle must never be spawned for the guard-dispatch invocation');
  assert.strictEqual(stdout.chunks.length, 1);
  const verdict = JSON.parse(stdout.chunks[0]);
  assert.strictEqual(verdict.hookSpecificOutput.permissionDecision, 'deny');
});

test('guard dispatch: allowed command -> no stdout write, exit 0, no spawn', () => {
  const stdout = fakeStdout();
  let exited = 'unset';
  let spawnCalled = false;
  runNaude({
    argv: ['--clode-update-guard'],
    stdin: fakeStdin(JSON.stringify({ tool_input: { command: 'ls -la' } })),
    stdout,
    exit: (c) => { exited = c; },
    spawn: () => { spawnCalled = true; return { on() {} }; },
  });
  assert.strictEqual(exited, 0);
  assert.strictEqual(spawnCalled, false);
  assert.strictEqual(stdout.chunks.length, 0, 'an allowed command emits nothing (bare exit 0 = allow)');
});

test('guard dispatch: unparseable stdin fails OPEN (no crash, no stdout, exit 0)', () => {
  const stdout = fakeStdout();
  let exited = 'unset';
  runNaude({
    argv: ['--clode-update-guard'],
    stdin: fakeStdin('not json'),
    stdout,
    exit: (c) => { exited = c; },
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.strictEqual(exited, 0);
  assert.strictEqual(stdout.chunks.length, 0);
});

// --- guard injection: CLODE_TARGET wires --settings into the child argv ------
test('first pass: env.CLODE_TARGET set -> child argv gets --settings <file>, file wires the PreToolUse guard hook', () => {
  // NOTE: no onExit override here — the default (registers on the fake child's
  // inert `on('exit', ...)`) never fires, so the settings file survives long
  // enough to inspect. (A firing onExit would run cleanup() and unlink it —
  // see the dedicated cleanup test below.)
  const cap = firstPass({ env: { CLODE_TARGET: '/opt/naude' } });
  const idx = cap.call.args.indexOf('--settings');
  assert.ok(idx !== -1, '--settings must be appended to the child argv');
  const file = cap.call.args[idx + 1];
  assert.ok(file, '--settings must be followed by a path');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(
    written.hooks.PreToolUse[0].hooks[0].command,
    '"/opt/naude" --clode-update-guard');
  assert.strictEqual(written.hooks.PreToolUse[0].matcher, 'Bash');
  fs.rmSync(file, { force: true });
});

test('first pass: env.CLODE_TARGET unset -> no --settings added to the child argv', () => {
  const cap = firstPass({ onExit: (cb) => cb(0, null) });
  assert.strictEqual(cap.call.args.indexOf('--settings'), -1);
});

test('first pass: the guard settings file is best-effort removed when the child exits', () => {
  let writtenFile = null;
  const cap = firstPass({
    env: { CLODE_TARGET: '/opt/naude' },
    onExit: (cb) => cb(0, null),
  });
  const idx = cap.call.args.indexOf('--settings');
  writtenFile = cap.call.args[idx + 1];
  assert.strictEqual(fs.existsSync(writtenFile), false, 'the ephemeral settings file must be removed on exit');
});

test('first pass: no `builder` override + the builder asset is absent (getAsset throws) -> CLODE_SELF unset', () => {
  let call = null;
  const sea = Object.assign(fakeSea(), {
    getAsset: () => { throw new Error('No such asset: builder'); },
  });
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea,
    // NOTE: no `builder` override here either — the null path must come from
    // bakedBuilder catching the thrown getAsset, not from a stubbed `builder`.
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.env.CLODE_SELF, undefined,
    'no builder asset -> updater must fail loud, not spawn something wrong');
});
