const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { sandbox, runClode, mkProvider } = require('./e2e.cjs');

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

test('--clode-help prints clode-specific options and exits 0', (t) => {
  const sbx = withProvider(t);
  const r = runClode(sbx, ['--clode-help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /--clode-verbose/);
  assert.match(r.output, /--clode-version/);
  assert.match(r.output, /clode-specific options/i);
});

test('--clode-verbose is stripped before clode-flag dispatch (works in any position)', (t) => {
  const sbx = withProvider(t);
  const r = runClode(sbx, ['--clode-verbose', '--clode-help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /run the latest Claude Code/);
});

test('default launch emits NO clode chatter (only the bundle output)', (t) => {
  const sbx = withProvider(t);
  const r = runClode(sbx, []);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /CLODE-FIXTURE tok/);          // the bundle ran
  assert.doesNotMatch(r.output, /extracting JS/);       // ...but clode stayed quiet
  assert.doesNotMatch(r.output, /^clode:/m);
});

test('--clode-verbose un-mutes clode progress, and is consumed (bundle still boots)', (t) => {
  const sbx = withProvider(t);
  const r = runClode(sbx, ['--clode-verbose']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /extracting JS/);
  assert.match(r.output, /CLODE-FIXTURE tok/);          // flag consumed, not passed on
});

test('CLODE_VERBOSE=1 env is equivalent to the flag', (t) => {
  const sbx = withProvider(t);
  const r = runClode(sbx, [], { env: { CLODE_VERBOSE: '1' } });
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /extracting JS/);
});
