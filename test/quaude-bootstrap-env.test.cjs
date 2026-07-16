'use strict';
// The bootstrap's env seam. quaude applies the target contract with TJS
// primitives (there is no node:fs here — the node-shim loader has not booted).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { shapeTargetEnv, probePaths } = require('../libexec/target-env.cjs');

// quaude-bootstrap.mjs has a top-level `await main()` (gated on globalThis.tjs,
// so it's a no-op under host node) — that alone makes the module ASYNC, and
// Node's synchronous require(esm) refuses any async module outright
// (ERR_REQUIRE_ASYNC_MODULE), whether or not the await actually fires. Load it
// with dynamic import(), the same way test/quaude-argv.test.cjs already does.
const BOOTSTRAP = pathToFileURL(path.resolve(__dirname, '../libexec/quaude-bootstrap.mjs')).href;
const loadBootstrap = () => import(BOOTSTRAP);

// tjs's stat is ASYNC and throws on missing — there is no statSync. The fake
// mirrors that exactly; a fake with a sync stat would test a tjs that does not exist.
function fakeTjs(over = {}) {
  const present = new Set(over.present || []);
  return {
    env: over.env || { PATH: '/usr/bin' },
    stat: async (p) => { if (!present.has(p)) throw new Error('ENOENT: ' + p); return { mode: 0o755 }; },
  };
}
// Platform arrives via navigator.userAgentData.platform under tjs, not tjs.system.
// shape/probe are injected directly here — outside the real fused binary there
// is no globalThis.__clodeShapeTargetEnv/__clodeProbePaths (those are set only
// by main(), which never runs under host node); the module's default params
// read those globals, exactly as the fused path installs them.
const opts = (over = {}) => Object.assign({ uaPlatform: 'Linux', shape: shapeTargetEnv, probe: probePaths }, over);

test('applies the contract to tjs.env', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs();
  await bootstrapTargetEnv(tjs, opts({ builder: null }));
  assert.strictEqual(tjs.env.DISABLE_INSTALLATION_CHECKS, '1');
  assert.strictEqual(tjs.env.NODE_USE_ENV_PROXY, '1');
});

test('points CLODE_SELF at the builder from the manifest', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs();
  await bootstrapTargetEnv(tjs, opts({ builder: '/usr/local/bin/clode' }));
  assert.strictEqual(tjs.env.CLODE_SELF, '/usr/local/bin/clode',
    'a baked quaude cannot rewrite its own bytecode; the updater must call clode');
});

test('finds a real rg via the async tjs.stat probe', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs({ env: { PATH: '/usr/bin:/opt/rg/bin' }, present: ['/opt/rg/bin/rg'] });
  await bootstrapTargetEnv(tjs, opts({ builder: null }));
  assert.strictEqual(tjs.env.USE_BUILTIN_RIPGREP, '0');
  // shapeTargetEnv's whole-segment membership test (target-env.test.cjs: "leaves
  // PATH ALONE"): rg's dir is already reachable via PATH, so nothing is prepended.
  assert.strictEqual(tjs.env.PATH, '/usr/bin:/opt/rg/bin');
});

test('no rg present: search config untouched', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs({ env: { PATH: '/usr/bin' } });
  await bootstrapTargetEnv(tjs, opts({ builder: null }));
  assert.strictEqual(tjs.env.USE_BUILTIN_RIPGREP, undefined);
});

test("maps navigator's 'macOS' to darwin, and old darwin gets the bundled cert store", async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs();                       // trustd absent
  await bootstrapTargetEnv(tjs, opts({ builder: null, uaPlatform: 'macOS' }));
  assert.strictEqual(tjs.env.CLAUDE_CODE_CERT_STORE, 'bundled');
});

test('modern darwin (trustd present) leaves the cert store alone', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs({ present: ['/usr/libexec/trustd'] });
  await bootstrapTargetEnv(tjs, opts({ builder: null, uaPlatform: 'macOS' }));
  assert.strictEqual(tjs.env.CLAUDE_CODE_CERT_STORE, undefined);
});
