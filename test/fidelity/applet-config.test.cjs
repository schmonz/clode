// test/fidelity/applet-config.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { appletEnv, discovered } = require('../fidelity/applet-config.mjs');

test('appletEnv exposes only the requested applets on PATH', () => {
  const base = { PATH: '/nonexistent-empty-xyz' };
  const env = appletEnv({ rg: true, ugrep: false, bfs: false }, base);
  assert.ok(discovered('rg', env), 'rg present when requested');
  assert.strictEqual(discovered('ugrep', env), null, 'ugrep absent when not requested');
});

test('all-absent config discovers no search applet', () => {
  const env = appletEnv({ rg: false, ugrep: false, bfs: false }, { PATH: '/nonexistent-empty-xyz' });
  assert.strictEqual(discovered('rg', env), null);
});
