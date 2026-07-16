'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('naude sea-config embeds the baked cli.cjs + bun-shim + deps, NOT the extractor', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const cfg = naudeSeaConfig({ mainBundle: '/b/entry.js', cliCjs: '/cache/cli.cjs',
    bunShim: '/lx/bun-shim.cjs', tar: '/o/deps.tar', sig: '/o/deps.sig', out: '/o' });
  assert.strictEqual(cfg.assets['cli.cjs'], '/cache/cli.cjs');
  assert.strictEqual(cfg.assets['bun-shim.cjs'], '/lx/bun-shim.cjs');
  assert.ok(cfg.assets['deps.tar'] && cfg.assets['deps.sig']);
  assert.ok(!('extract-claude-js.cjs' in cfg.assets), 'naude must NOT embed the extractor');
  assert.strictEqual(cfg.main, '/b/entry.js');
});

// Bug 1 (--out for naude): the flag used to be forwarded by clode-fuse.cjs but
// silently ignored here — build-naude.mjs's only argv parsing was --cli, so a
// user-requested destination was dropped and the binary landed at the default
// build/<tag>/naude instead, with exit 0 and no complaint. parseOutArg is the
// fix's parsing half (buildBinary honoring the result is proven end-to-end by
// a real build in test/naude-smoke.test.cjs and the task's manual VERIFY step).
test('parseOutArg: absent -> null (caller falls back to the default seaBin path)', async () => {
  const { parseOutArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseOutArg(['--cli', '/x/cli.cjs']), null);
});

test('parseOutArg: resolves a given path to absolute', async () => {
  const { parseOutArg } = await import('../scripts/build-naude.mjs');
  const path = require('node:path');
  assert.strictEqual(parseOutArg(['--out', 'relative/naude']), path.resolve('relative/naude'));
  assert.strictEqual(parseOutArg(['--out', '/abs/naude']), '/abs/naude');
});
