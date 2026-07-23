'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

test('native WebSocket transport works through the shim under tjs (headers + echo)', (t) => {
  if (skipUnlessTjs(t)) return;
  const entry = path.join(REPO, 'test/fixtures/ws-oracle.cjs');
  const r = runLoader(entry, [], {
    env: { CLODE_BUN_SHIM: path.join(REPO, 'libexec/bun-shim.cjs') },
    timeout: 15000,
  });
  assert.match(r.stdout, /RESULT PASS/, `oracle output:\n${r.stdout}\n${r.stderr}`);
});
