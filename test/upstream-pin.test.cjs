'use strict';
// forced-win32: spawn-injected: no test here spawns; upstreamPin reads through an injected reader or the repo file
// libexec/upstream-pin.cjs: the one reader of UPSTREAM_PIN's `claude-code <version>` line.
const test = require('node:test');
const assert = require('node:assert');
const { upstreamPin } = require('../libexec/upstream-pin.cjs');

test('upstreamPin: the claude-code line, not a comment that mentions one', () => {
  const text = '# was: claude-code 2.1.1\ncarve-probe 2.1.9 carves\nclaude-code 2.1.332\n';
  assert.strictEqual(upstreamPin('/r', () => text), '2.1.332');
});

test('upstreamPin: no file or no line is null, never a guess', () => {
  assert.strictEqual(upstreamPin('/r', () => { throw new Error('ENOENT'); }), null);
  assert.strictEqual(upstreamPin('/r', () => '# nothing pinned\n'), null);
});

test('upstreamPin: this tree is pinned', () => {
  assert.match(upstreamPin(), /^\d+\.\d+\.\d+$/);
});
