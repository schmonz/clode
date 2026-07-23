'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldInjectGuard, SUBCOMMANDS } = require('../libexec/update-guard.cjs');

test('shouldInjectGuard: default/model command injects, subcommands skip', () => {
  assert.strictEqual(shouldInjectGuard([]), true, 'interactive default');
  assert.strictEqual(shouldInjectGuard(['-p', 'do a thing']), true, '-p headless');
  assert.strictEqual(shouldInjectGuard(['--print']), true, '--print');
  assert.strictEqual(shouldInjectGuard(['--debug', '-p', 'x']), true, 'bool flag then -p');
  assert.strictEqual(shouldInjectGuard(['fix the remote-control bug']), true, 'multi-word prompt');
  assert.strictEqual(shouldInjectGuard(['remote-control']), false, 'remote-control subcommand');
  assert.strictEqual(shouldInjectGuard(['rc']), false, 'remote-control alias');
  assert.strictEqual(shouldInjectGuard(['doctor']), false, 'doctor subcommand');
  assert.strictEqual(shouldInjectGuard(['mcp', 'add', 'x']), false, 'nested subcommand keyword first');
  assert.strictEqual(shouldInjectGuard(['--debug', 'remote-control']), false, 'bool flag then subcommand');
});

test('SUBCOMMANDS contains the reported case and its alias', () => {
  assert.ok(SUBCOMMANDS.has('remote-control'));
  assert.ok(SUBCOMMANDS.has('rc'));
});

test('bridge-spawned model sessions ARE guarded (they carry --print)', () => {
  // A Remote Control bridge is a non-model server (skipped, above), but when a
  // phone/claude.ai starts coding, the bridge spawns a model session via the
  // quaude binary with `--print --sdk-url … --session-id … --input-format
  // stream-json`. That spawn re-enters quaude-bootstrap step 7.6, and --print
  // must make shouldInjectGuard return true so the update-guard covers the
  // model session (which CAN run Bash). This locks that coverage.
  const spawnArgv = ['--print', '--sdk-url', 'wss://bridge.example', '--session-id',
    'cse_abc', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  assert.strictEqual(shouldInjectGuard(spawnArgv), true);
  // --print wins even if a subcommand-like token precedes it (defensive).
  assert.strictEqual(shouldInjectGuard(['rc', '--print', 'x']), true);
});
