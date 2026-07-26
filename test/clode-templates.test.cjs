'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseManifest, listTargets, resolveTarget, TemplatesError } = require('../libexec/clode-templates.cjs');

const FIX = JSON.stringify({
  schema: 1,
  tjsPin: 'v26.6.0-1a230d3',
  targets: {
    'linux-x64':    { tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-deadbeef',    sha256: 'a'.repeat(64), verified: 'smoke' },
    'netbsd-sparc': { tag: 'netbsd-10.1-sparc',    engine: 'tjs-netbsd-sparc-cafef00d', sha256: 'b'.repeat(64), verified: 'attest-only' },
  },
});

test('parseManifest returns schema/pin/targets', () => {
  const m = parseManifest(FIX);
  assert.strictEqual(m.tjsPin, 'v26.6.0-1a230d3');
  assert.strictEqual(Object.keys(m.targets).length, 2);
});

test('parseManifest throws TemplatesError on bad JSON / missing targets', () => {
  assert.throws(() => parseManifest('{not json'), (e) => e instanceof TemplatesError);
  assert.throws(() => parseManifest('{"schema":1}'), (e) => e instanceof TemplatesError && /targets/.test(e.message));
});

test('listTargets is sorted with name/tag/verified', () => {
  const l = listTargets(parseManifest(FIX));
  assert.deepStrictEqual(l.map((t) => t.name), ['linux-x64', 'netbsd-sparc']);
  assert.strictEqual(l[0].verified, 'smoke');
});

test('resolveTarget returns the entry or null', () => {
  const m = parseManifest(FIX);
  assert.strictEqual(resolveTarget(m, 'linux-x64').engine, 'tjs-linux-x64-deadbeef');
  assert.strictEqual(resolveTarget(m, 'nope'), null);
});
