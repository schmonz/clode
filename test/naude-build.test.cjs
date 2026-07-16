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
