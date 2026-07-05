'use strict';
// Unit tests for libexec/clode-current.cjs — the single seam for clode's
// active-provider pointer (<providers>/current). Phase A asserts the SYMLINK
// representation; Phase B (later task) re-points these at a pointer file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { currentVersion, currentBin, setCurrent } = require('../libexec/clode-current.cjs');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-current-'));
  const providers = path.join(dir, 'providers');
  fs.mkdirSync(providers, { recursive: true });
  return { dir, providers, env: { CLODE_PROVIDERS: providers } };
}

test('setCurrent + currentVersion round-trip', () => {
  const s = store();
  fs.mkdirSync(path.join(s.providers, '9.9.9'), { recursive: true });
  setCurrent(s.env, '9.9.9');
  assert.strictEqual(currentVersion(s.env), '9.9.9');
});

test('currentVersion is empty when no current exists', () => {
  const s = store();
  assert.strictEqual(currentVersion(s.env), '');
});

test('currentBin returns the resolved provider claude path', () => {
  const s = store();
  const verdir = path.join(s.providers, '9.9.9');
  fs.mkdirSync(verdir, { recursive: true });
  fs.writeFileSync(path.join(verdir, 'claude'), 'x');
  setCurrent(s.env, '9.9.9');
  assert.strictEqual(currentBin(s.env), path.join(fs.realpathSync(verdir), 'claude'));
});

test('currentBin is null when the provider binary is absent', () => {
  const s = store();
  setCurrent(s.env, '9.9.9'); // dangling: no 9.9.9/claude
  assert.strictEqual(currentBin(s.env), null);
});
