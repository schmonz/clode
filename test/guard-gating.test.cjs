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
  assert.strictEqual(shouldInjectGuard(['--verbose', 'remote-control']), false, 'bool flag then subcommand');
});

// I1 (grep-native sandbox round 3): an option's VALUE is not a subcommand. The bundle's own rule decides which tokens
// are values (libexec/update-guard.cjs's tables, gated against the carve by test/guard-subcommands-gate.test.cjs).
// Each row was measured on native 2.1.283 with `--help` after it: the root help means the model command.
test('shouldInjectGuard: an option value that spells a subcommand is a value, not the subcommand (I1)', () => {
  assert.strictEqual(shouldInjectGuard(['--add-dir', 'config']), true, '--add-dir takes `config` (interactive)');
  assert.strictEqual(shouldInjectGuard(['--add-dir', 'a', 'config']), true, '--add-dir is variadic: up to the next flag');
  assert.strictEqual(shouldInjectGuard(['--model', 'doctor']), true, '--model takes a value');
  assert.strictEqual(shouldInjectGuard(['--settings', 'update']), true, '--settings takes a value');
  assert.strictEqual(shouldInjectGuard(['--debug', 'remote-control']), true,
    '--debug [filter]: an optional value is taken when it is not a flag (native: root help)');
  assert.strictEqual(shouldInjectGuard(['--project-config-root', 'config']), true,
    'a commander root option missing from the eager scanner (native: root help)');
  assert.strictEqual(shouldInjectGuard(['--debug', '--verbose', 'doctor']), false, 'an optional value never takes a flag');
  assert.strictEqual(shouldInjectGuard(['--add-dir', 'a', '--verbose', 'mcp']), false, 'variadic stops at a flag');
  assert.strictEqual(shouldInjectGuard(['--add-dir=config', 'doctor']), false, '--opt=value is one token');
  assert.strictEqual(shouldInjectGuard(['--', 'doctor']), false, 'after `--` the next token is the positional');
  assert.strictEqual(shouldInjectGuard(['--system-prompt', '-p']), true,
    'a value option takes its next token even when it looks like a flag');
  assert.strictEqual(shouldInjectGuard(['--append-system-prompt', '--print', 'doctor']), false,
    '`--print` here is --append-system-prompt\'s value, not the print flag');
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
