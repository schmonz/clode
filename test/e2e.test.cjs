const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, runClode } = require('./e2e.cjs');

test('sandbox builds a constructed-clean env with no ambient leak', (t) => {
  process.env.CLODE_LEAK_CANARY = 'leaked';
  const sbx = sandbox(t);
  assert.strictEqual(sbx.env.CLODE_LEAK_CANARY, undefined);      // nothing from process.env
  assert.strictEqual(sbx.env.CLODE_STATE_ROOT, sbx.stateRoot);
  assert.strictEqual(sbx.env.HOME, sbx.home);
  assert.strictEqual(sbx.env.CLODE_NO_WATCH, '1');
  assert.strictEqual(sbx.env.CLODE_OFFLINE, '1');
  assert.ok(sbx.env.CLODE_NODE && path.isAbsolute(sbx.env.CLODE_NODE));
  // render fakes seeded under the sandbox data store
  const semver = path.join(sbx.stateRoot, 'share', 'clode', 'node_modules', 'semver', 'package.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(semver, 'utf8')).version, '0.0.0-clode-test');
  delete process.env.CLODE_LEAK_CANARY;
});

test('runClode boots the launcher end-to-end (--clode-version)', (t) => {
  const sbx = sandbox(t);
  const r = runClode(sbx, ['--clode-version']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /^clode \d+\.\d+\.\d+/m);
});
