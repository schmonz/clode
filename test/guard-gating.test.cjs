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
