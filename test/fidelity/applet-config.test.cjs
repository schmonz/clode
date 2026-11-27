// test/fidelity/applet-config.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { appletEnv, discovered } = require('../fidelity/applet-config.mjs');

// A real applet dir looked up for real: under the forced-win32 pass (process.platform flipped on a POSIX box) the
// stub is rg.cmd in a POSIX tmpdir joined into PATH with the already-loaded posix path.delimiter, and path-lookup.cjs
// splits PATH on ';' and joins with '\\' as libuv does, so only a real Windows filesystem can answer.
test('appletEnv exposes only the requested applets on PATH',
  { skip: !!process.env.CLODE_FORCED_WIN32 && 'needs a real Windows filesystem (the forced-win32 pass flips process.platform only)' }, () => {
  const base = { PATH: '/nonexistent-empty-xyz' };
  const env = appletEnv({ rg: true, ugrep: false, bfs: false }, base);
  assert.ok(discovered('rg', env), 'rg present when requested');
  assert.strictEqual(discovered('ugrep', env), null, 'ugrep absent when not requested');
});

test('all-absent config discovers no search applet', () => {
  const env = appletEnv({ rg: false, ugrep: false, bfs: false }, { PATH: '/nonexistent-empty-xyz' });
  assert.strictEqual(discovered('rg', env), null);
});
