'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { builtQuaude } = require('./built-binary.cjs');

test('builtQuaude returns a real executable, or a reason it could not', () => {
  const r = builtQuaude();
  if (r.skip) {
    assert.ok(r.skip.length > 20, 'a skip that cannot say what it wanted hides a failure');
    return;
  }
  assert.ok(fs.existsSync(r.path), `builtQuaude said ${r.path} but nothing is there`);
  assert.ok(fs.statSync(r.path).mode & 0o111, 'the built product must be executable');
});

test('a prebuilt binary is honoured instead of building', () => {
  const prev = process.env.CLODE_QUAUDE;
  process.env.CLODE_QUAUDE = process.execPath;   // any real executable stands in
  try {
    assert.strictEqual(builtQuaude().path, process.execPath,
      'CLODE_QUAUDE must win — CI and slow boxes supply a binary rather than pay 14s');
  } finally {
    if (prev === undefined) delete process.env.CLODE_QUAUDE; else process.env.CLODE_QUAUDE = prev;
  }
});
