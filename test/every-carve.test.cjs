'use strict';
// forced-win32: spawn-injected: no test here spawns; each calls the pure everyCarveVerdict on literal text
// scripts/lib/every-carve.cjs: the pin-bump question "does ANY platform's carve reach a Bun.ant member the shim does
// not account for?". 2.1.332's windowsPolicyValue existed only in the win32 carves, so only Windows CI saw it.
const test = require('node:test');
const assert = require('node:assert');
const { everyCarveVerdict } = require('../scripts/lib/every-carve.cjs');

const call = (m) => `if(typeof Bun.ant?.${m}!=="function")return;`;

test('every-carve: a member only one platform reaches is named, with that platform', () => {
  const v = everyCarveVerdict([
    { platform: 'linux-x64', text: call('getPeerPid') },
    { platform: 'win32-x64', text: call('getPeerPid') + call('brandNewWindowsThing') },
  ], ['getPeerPid']);
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.unaccounted, { 'win32-x64': ['brandNewWindowsThing'] });
});

test('every-carve: a platform that could not be measured fails the verdict; it is never "clean"', () => {
  const v = everyCarveVerdict([
    { platform: 'linux-x64', text: call('getPeerPid') },
    { platform: 'win32-x64', error: 'HTTP 503' },
  ], ['getPeerPid']);
  assert.strictEqual(v.ok, false);
  assert.ok(v.lines.some((l) => /win32-x64: NOT MEASURED: HTTP 503/.test(l)), v.lines.join('\n'));
  assert.strictEqual(everyCarveVerdict([], []).ok, false, 'nothing measured is not a pass');
});

test('every-carve: members recorded in KNOWN_BUN_ANT or provided by the shim pass', () => {
  const v = everyCarveVerdict([{ platform: 'win32-x64', text: call('windowsPolicyValue') + call('getPeerPid') }], ['getPeerPid']);
  assert.deepStrictEqual(v, { ok: true, lines: ['win32-x64: 2 Bun.ant member(s), all accounted for'], unaccounted: {} });
});
