const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, mkProvider, REPO, NODE } = require('./e2e.cjs');

const BIN = path.join(REPO, 'bin', 'clode');

// test_verbose.bats setup: a fake provider that prints "CLODE-FIXTURE <label>" and
// CLODE_CLAUDE_BIN pointing at it. (CLODE_LIBEXEC/CLODE_CACHE from the bats setup are
// unneeded: the launcher finds REPO/libexec by its own path, and CLODE_STATE_ROOT
// governs the cache.)
function withProvider(t, label = 'tok') {
  const sbx = sandbox(t);
  const bin = path.join(sbx.dir, 'claude');
  mkProvider(bin, label);
  sbx.env.CLODE_CLAUDE_BIN = bin;
  return sbx;
}

// The --help / --verbose dispatch (clode-main.cjs steps 1/4) is clode's
// OWN flag handling — unaffected by the runner's retirement — so it's exercised with
// a direct spawn of bin/clode, not a model runner. (The default-launch cases that used
// to sit alongside these — "emits no chatter", "--verbose un-mutes progress",
// "CLODE_VERBOSE=1 env" — asserted on the runner actually booting the bundle; that
// premise is gone, and they were deleted rather than forced onto a model runner that
// doesn't speak clode's own verbose/extract chatter at all.)
function run(sbx, args = [], opts = {}) {
  const r = spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...sbx.env, ...(opts.env || {}) },
    cwd: opts.cwd || REPO,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: (r.stdout || '') + (r.stderr || '') };
}

test('--help prints clode-specific options and exits 0', (t) => {
  const sbx = withProvider(t);
  const r = run(sbx, ['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /--verbose/);
  assert.match(r.output, /--version/);
  assert.match(r.output, /Options:/);
});

test('--verbose composes as a leading flag before --help (no more any-position stripping)', (t) => {
  const sbx = withProvider(t);
  const r = run(sbx, ['--verbose', '--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /build a standalone Claude Code binary for your machine/);
});
