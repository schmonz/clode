'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { environmentStamp } = require('./environment-stamp.cjs');

test('the stamp names the interpreter, platform, pin and gates in effect', () => {
  const s = environmentStamp({
    execPath: '/opt/pkg/bin/node', nodeVersion: 'v26.3.0',
    platform: 'darwin', arch: 'arm64', osRelease: '25.6.0',
    pin: '2.1.251', providerCarve: 'darwin-arm64', engine: 'tjs 26.6.0',
    gates: { CLODE_LIVE_RENDER: '1' },
  });
  for (const needle of ['/opt/pkg/bin/node', 'v26.3.0', 'darwin', 'arm64',
    '2.1.251', 'darwin-arm64', 'CLODE_LIVE_RENDER=1']) {
    assert.ok(s.includes(needle), `stamp must name ${needle}; got: ${s}`);
  }
});

test('an unknown field is named as unknown, never omitted', () => {
  const s = environmentStamp({ execPath: '/n', nodeVersion: 'v26', platform: 'linux',
    arch: 'x64', osRelease: '6', pin: null, providerCarve: null, engine: null, gates: {} });
  assert.match(s, /pin=unknown/,
    'a missing field must READ as unknown — an omitted field looks like a field that '
    + 'did not matter');
});

// gates is meant to be DERIVED by the caller (every CLODE_* env var actually set — see
// test/run.mjs), not a hand-maintained list: a fixed list goes stale the moment a new
// gate is added, and a stale-list stamp prints identically for two runs that actually
// exercised different code (an offline run and a CLODE_LIVE_ONLINE=1 run looked the
// same before this fix). These tests exercise the formatter directly, since deriving
// the object itself is run.mjs's job, not environmentStamp's.
const BASE = { execPath: '/n', nodeVersion: 'v26', platform: 'linux', arch: 'x64',
  osRelease: '6', pin: '1', providerCarve: 'linux-x64', engine: 'tjs' };

test('a gate this list never named still shows up, because it is derived', () => {
  const s = environmentStamp({ ...BASE, gates: { CLODE_LIVE_ONLINE: '1' } });
  assert.ok(s.includes('CLODE_LIVE_ONLINE=1'), `got: ${s}`);
});

// The value side is an ALLOW-list (SAFE_GATE_NAMES), not a deny-list — round 1's deny
// list (/TOKEN|SECRET|KEY|PASSWORD/i) was measured, in review, to let CLODE_CREDENTIALS,
// CLODE_PASS, CLODE_AUTH and CLODE_SESSION straight through with their values printed in
// full. Those four are the regression test for this fix.
test('a known-safe toggle prints its value', () => {
  const s = environmentStamp({ ...BASE, gates: { CLODE_OFFLINE: '1' } });
  assert.ok(s.includes('CLODE_OFFLINE=1'), `got: ${s}`);
});

test('an unrecognised CLODE_* variable withholds its value, name still visible', () => {
  const s = environmentStamp({ ...BASE, gates: { CLODE_SOME_NEW_THING: 'zzz-secretish' } });
  assert.ok(s.includes('CLODE_SOME_NEW_THING=<set>'), `got: ${s}`);
  assert.ok(!s.includes('zzz-secretish'), `value leaked into the stamp: ${s}`);
});

test('the four measured deny-list leaks each withhold their value', () => {
  for (const [name, value] of [
    ['CLODE_CREDENTIALS', 'cred-value'],
    ['CLODE_PASS', 'pw-value'],
    ['CLODE_AUTH', 'auth-value'],
    ['CLODE_SESSION', 'session-value'],
  ]) {
    const s = environmentStamp({ ...BASE, gates: { [name]: value } });
    assert.ok(s.includes(`${name}=<set>`), `${name}: expected <set>, got: ${s}`);
    assert.ok(!s.includes(value), `${name}: its value leaked into the stamp: ${s}`);
  }
});

test('gates=none still prints when no CLODE_* variable is set', () => {
  const s = environmentStamp({ ...BASE, gates: {} });
  assert.ok(s.includes('gates=none'), `got: ${s}`);
});
