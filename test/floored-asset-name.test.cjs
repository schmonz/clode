'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { flooredAssetName } = require('../scripts/floored-asset-name.cjs');

test('floored leg injects the floor before the arch segment', () => {
  assert.strictEqual(flooredAssetName('netbsd-amd64', '0.1.2', '9.4'), 'clode-0.1.2-netbsd9.4-amd64');
  assert.strictEqual(flooredAssetName('darwin-x64', '0.1.2', '10.6'), 'clode-0.1.2-darwin10.6-x64');
  assert.strictEqual(flooredAssetName('omnios-amd64', '0.1.2', 'r151056'), 'clode-0.1.2-omniosr151056-amd64');
});
test('unfloored (no floor) is bare', () => {
  assert.strictEqual(flooredAssetName('windows-arm64', '0.1.2', ''), 'clode-0.1.2-windows-arm64');
  assert.strictEqual(flooredAssetName('linux-x64-musl', '0.1.2', undefined), 'clode-0.1.2-linux-x64-musl');
});
