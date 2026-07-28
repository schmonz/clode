'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sign } = require('../scripts/sea-sign.cjs');

// A run stub that records calls AND emulates rcodesign writing its OUTPUT_PATH (last
// arg) so sea-sign's temp->rename swap succeeds in a unit test.
function capture() {
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'sign' && args.length >= 3) fs.writeFileSync(args[args.length - 1], 'SIGNED');
  };
  return { run, calls };
}

test('target darwin + host darwin -> codesign (unchanged)', () => {
  const c = capture();
  sign('sign', '/b/naude', 'darwin', { host: 'darwin', run: c.run });
  assert.strictEqual(c.calls[0].cmd, 'codesign');
});

test('target darwin + host linux: unsign is a no-op; sign runs rcodesign (temp+swap)', () => {
  const c = capture();
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seasign-')), 'naude');
  fs.writeFileSync(bin, 'MACHO');
  sign('unsign', bin, 'darwin', { host: 'linux', signerBin: '/t/rcodesign', run: c.run });
  assert.strictEqual(c.calls.length, 0, 'unsign is a no-op off-Mac (rcodesign replaces the sig)');
  sign('sign', bin, 'darwin', { host: 'linux', signerBin: '/t/rcodesign', run: c.run });
  assert.strictEqual(c.calls[0].cmd, '/t/rcodesign');
  assert.strictEqual(c.calls[0].args[0], 'sign');
  assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'SIGNED', 'the signed temp was swapped in place');
});

test('target darwin + host linux + NO signer -> throws (never ship unsigned)', () => {
  assert.throws(() => sign('sign', '/b/naude', 'darwin', { host: 'linux', run: () => {} }),
    /rcodesign|signer|needs/i);
});

test('non-darwin target -> no-op', () => {
  const c = capture();
  sign('sign', '/b/naude', 'linux', { host: 'linux', run: c.run });
  assert.strictEqual(c.calls.length, 0);
});
