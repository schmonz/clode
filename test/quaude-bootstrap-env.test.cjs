'use strict';
// The bootstrap's env seam. quaude applies the target contract with TJS
// primitives (there is no node:fs here — the node-shim loader has not booted).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { shapeTargetEnv, probePaths, mapPlatform } = require('../libexec/target-env.cjs');

// quaude-bootstrap.mjs has a top-level `await main()` (gated on globalThis.tjs,
// so it's a no-op under host node) — that alone makes the module ASYNC, and
// Node's synchronous require(esm) refuses any async module outright
// (ERR_REQUIRE_ASYNC_MODULE), whether or not the await actually fires. Load it
// with dynamic import(), the same way test/quaude-argv.test.cjs already does.
const BOOTSTRAP = pathToFileURL(path.resolve(__dirname, '../libexec/quaude-bootstrap.mjs')).href;
const loadBootstrap = () => import(BOOTSTRAP);

// POSIX file-type bits, mirroring libexec/quaude-bootstrap.mjs's own constants
// (verified against a real tjs.stat in the review: a regular file's mode is
// 0o100644/0o100755, a directory's 0o040755).
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

// tjs's stat is ASYNC and throws on missing — there is no statSync. The fake
// mirrors that exactly; a fake with a sync stat would test a tjs that does not
// exist. `present` maps path -> a mode (defaults to an executable regular
// file, 0o100755) so tests can model a directory or a non-executable file at a
// path — the fake used to hardcode { mode: 0o755 } for every present path, a
// field bootstrapTargetEnv never actually read; that unread field is exactly
// what let the exists-vs-isExec bug (Finding 1) hide.
function fakeTjs(over = {}) {
  const present = new Map(
    Array.isArray(over.present)
      ? over.present.map((p) => [p, S_IFREG | 0o755])
      : Object.entries(over.present || {}),
  );
  return {
    env: over.env || { PATH: '/usr/bin' },
    stat: async (p) => {
      if (!present.has(p)) throw new Error('ENOENT: ' + p);
      return { mode: present.get(p) };
    },
  };
}
// Platform arrives via navigator.userAgentData.platform under tjs, not tjs.system.
// shape/probe/map are injected directly here — outside the real fused binary
// there is no globalThis.__clodeShapeTargetEnv/__clodeProbePaths/__clodeMapPlatform
// (those are set only by main(), which never runs under host node); the
// module's default params read those globals, exactly as the fused path
// installs them.
const opts = (over = {}) => Object.assign({ uaPlatform: 'Linux', shape: shapeTargetEnv, probe: probePaths, map: mapPlatform }, over);

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

// Finding 1's repro, at the quaude layer: tjs.stat does not throw on a
// directory (or a non-executable file) named rg — it exists, same as a real
// binary would. bootstrapTargetEnv must reject it via the mode bits, not treat
// "tjs.stat did not throw" as "runnable".
test('a directory named rg on PATH does not win — quaude rejects it too', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs({
    env: { PATH: '/usr/bin' },
    present: { '/usr/bin/rg': S_IFDIR | 0o755 },
  });
  await bootstrapTargetEnv(tjs, opts({ builder: null }));
  assert.strictEqual(tjs.env.USE_BUILTIN_RIPGREP, undefined, 'a directory must not disable the embedded-search fallback');
  assert.strictEqual(tjs.env.PATH, '/usr/bin', 'PATH must not be rewritten for an unrunnable candidate');
});

test('a non-executable file named rg on PATH does not win either', async () => {
  const { bootstrapTargetEnv } = await loadBootstrap();
  const tjs = fakeTjs({
    env: { PATH: '/usr/bin' },
    present: { '/usr/bin/rg': S_IFREG | 0o644 }, // regular file, no +x anywhere
  });
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
