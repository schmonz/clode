'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

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
  assert.strictEqual(parseOutArg(['--out', 'relative/naude']), path.resolve('relative/naude'));
  assert.strictEqual(parseOutArg(['--out', '/abs/naude']), '/abs/naude');
});

// Duplication audit §5: the two paths used to state OPPOSITE intents about
// bun-shim provenance — quaude took it from the extract STAGE DIR ("version-
// locked to the bundle by the cache"), naude took it from REPO/libexec,
// ignoring the stage dir the --naude branch had just populated. They agreed on
// bytes only BY ACCIDENT: clode-extract.cjs re-copies libexec/bun-shim.cjs over
// the cached one on every cache hit. Pin the shim per bundle version — the
// stated intent — and naude would silently bake a DIFFERENT shim than quaude
// from the same inputs, with the parity oracle none the wiser. The stage dir is
// the decided answer for BOTH.
test('stagedBunShim: the shim comes from the stage dir beside cli.cjs, not the repo', async () => {
  const { stagedBunShim } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(stagedBunShim('/cache/claude-abc123/cli.cjs'),
    path.join('/cache/claude-abc123', 'bun-shim.cjs'));
  // The exact regression: never reach back into the checkout for it.
  const REPO = path.resolve(__dirname, '..');
  assert.notStrictEqual(stagedBunShim('/cache/claude-abc123/cli.cjs'),
    path.join(REPO, 'libexec', 'bun-shim.cjs'));
});

// The provenance rule, stated as the property that matters: whatever stage the
// cli.cjs came from, the shim comes from THAT SAME stage — which is exactly
// what quaude-fuse.js does (`path.join(stageDir, 'bun-shim.cjs')` where
// stageDir is the dir holding cli.cjs). Same inputs => same shim, both targets.
test('stagedBunShim: quaude and naude resolve the same shim for the same stage', async () => {
  const { stagedBunShim } = await import('../scripts/build-naude.mjs');
  for (const stage of ['/cache/v1', '/cache/v2', '/tmp/other/stage']) {
    // quaude-fuse.js's rule, transcribed: join(stageDir, 'bun-shim.cjs').
    const quaudeShim = path.join(stage, 'bun-shim.cjs');
    const naudeShim = stagedBunShim(path.join(stage, 'cli.cjs'));
    assert.strictEqual(naudeShim, quaudeShim,
      `naude and quaude must bake the same shim for stage ${stage}`);
  }
});
