const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { NODE, REPO } = require('./e2e.cjs');

// test_update_guard.bats is `standalone` (no test_helper sandbox): it invokes the
// guard script directly with a fixed CLODE_SELF and pipes a hook event JSON on stdin.
// The guard only reads CLODE_SELF from the env and stdin, touching no HOME/state, so a
// minimal constructed-clean env suffices (nothing spread from process.env).
const GUARD = path.join(REPO, 'libexec', 'clode-update-guard.cjs');

function runGuard(input) {  // input = stdin JSON, matching the bats run_guard helper
  return spawnSync(NODE, [GUARD], {
    input,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', CLODE_SELF: '/opt/clode/bin/clode' },
  });
}

test('denies claude update with the clode-self command in the reason', () => {
  const r = runGuard('{"tool_name":"Bash","tool_input":{"command":"claude update"}}');
  const out = r.stdout || '';
  assert.match(out, /"permissionDecision":"deny"/);
  assert.match(out, /\/opt\/clode\/bin\/clode update/);
});

test('denies claude upgrade even with surrounding tokens', () => {
  const r = runGuard('{"tool_name":"Bash","tool_input":{"command":"sudo claude upgrade --yes"}}');
  const out = r.stdout || '';
  assert.match(out, /"permissionDecision":"deny"/);
});

test('allows unrelated bash (no output)', () => {
  const r = runGuard('{"tool_name":"Bash","tool_input":{"command":"npm test"}}');
  assert.strictEqual(r.stdout || '', '');
});

test('allows malformed json, exits 0, no output', () => {
  const r = runGuard('not json at all');
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '') + (r.stderr || ''), '');
});
