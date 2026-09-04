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
