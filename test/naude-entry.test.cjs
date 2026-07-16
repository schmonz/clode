'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
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
  assert.strictEqual(call.opts.env.NAUDE_RUN_AS_NODE, '/work/cli.cjs');
  assert.match(call.opts.env.NODE_PATH, /\/deps\/node_modules/);
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
