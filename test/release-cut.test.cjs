'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pendingCut, applyReleaseCut } = require('./release-cut.cjs');

test('a VERSION with no tag is a pending cut; a tagged one is not', () => {
  assert.strictEqual(pendingCut('0.20261125.1\n', ['v0.20260831.1']), '0.20261125.1');
  assert.strictEqual(pendingCut('0.20260831.1\n', ['v0.20260831.1']), null);
});

test('no visible tags (a shallow clone) is unknowable, not a cut', () => {
  assert.strictEqual(pendingCut('0.20261125.1', []), null);
});

function root(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cut-'));
  fs.writeFileSync(path.join(d, 'VERSION'), `${version}\n`);
  return d;
}

test('on a cut the suite judges as the release: CLODE_EVIDENCE_RELEASE=1 (the 0.20261125.1 miss)', () => {
  const env = {};
  const line = applyReleaseCut(root('0.20261125.1'), env, ['v0.20260831.1']);
  assert.strictEqual(env.CLODE_EVIDENCE_RELEASE, '1');
  assert.match(line, /release cut/);
});

test('between releases nothing changes, and an explicit value is never overridden', () => {
  const env = {};
  assert.strictEqual(applyReleaseCut(root('0.20260831.1'), env, ['v0.20260831.1']), null);
  assert.strictEqual(env.CLODE_EVIDENCE_RELEASE, undefined);
  const optOut = { CLODE_EVIDENCE_RELEASE: '0' };
  assert.strictEqual(applyReleaseCut(root('0.20261125.1'), optOut, ['v0.20260831.1']), null);
  assert.strictEqual(optOut.CLODE_EVIDENCE_RELEASE, '0');
});

test('test/run.mjs applies it before any test runs', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8');
  const at = src.indexOf("('./release-cut.cjs').applyReleaseCut(ROOT)");
  assert.ok(at > 0, 'run.mjs must call release-cut.cjs');
  assert.ok(at < src.indexOf('discoverTests('), 'and before it discovers or runs tests');
});
