'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

test('shim Buffer supports base64url (feross v6.0.3 rejects it natively)', (t) => {
  if (skipUnlessTjs(t)) return;
  const entry = path.join(REPO, 'test/fixtures/base64url-oracle.cjs');
  const r = runLoader(entry, [], { timeout: 15000 });
  assert.match(r.stdout, /RESULT PASS/, `oracle output:\n${r.stdout}\n${r.stderr}`);
});
