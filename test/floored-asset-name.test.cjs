'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { flooredAssetName } = require('../scripts/floored-asset-name.cjs');

test('floored leg: dashed <os>-<floor>-<arch>, canonical os/arch', () => {
  assert.strictEqual(flooredAssetName('netbsd-amd64', '0.1.2', '9.4'), 'clode-0.1.2-netbsd-9.4-amd64');
  assert.strictEqual(flooredAssetName('darwin-x64', '0.1.2', '10.6'), 'clode-0.1.2-macos-10.6-amd64');
  assert.strictEqual(flooredAssetName('omnios-amd64', '0.1.2', 'r151056'), 'clode-0.1.2-omnios-r151056-amd64');
});
test('unfloored (no floor) is bare, canonicalized, keeps any libc suffix', () => {
  assert.strictEqual(flooredAssetName('windows-arm64', '0.1.2', ''), 'clode-0.1.2-windows-arm64');
  assert.strictEqual(flooredAssetName('linux-x64-musl', '0.1.2', undefined), 'clode-0.1.2-linux-amd64-musl');
});
