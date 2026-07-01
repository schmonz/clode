'use strict';
// Task 4: under a SEA the bundle's ext-deps + bun-shim come from embedded assets, not
// npm/libexec. These tests exercise the real seams (prepareRuntimeDeps, applyNodePath,
// extractIfNeeded) with injected fakes — no real SEA, no network.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { prepareRuntimeDeps } = require('../libexec/clode-main.cjs');
const hosttools = require('../libexec/clode-hosttools.cjs');
const { extractIfNeeded } = require('../libexec/clode-extract.cjs');

test('prepareRuntimeDeps under SEA: materializes assets, does NOT call ensureDeps', () => {
  const calls = [];
  const fakeSea = {
    isSea: () => true,
    materializeDeps: (o) => { calls.push(['materializeDeps', o.cacheDir]); return '/cache/sea-deps/SIG/node_modules'; },
    materializeBunShim: (o) => { calls.push(['materializeBunShim', o.destDir]); return '/cache/sea-deps/bun-shim.cjs'; },
  };
  const fakeDeps = { ensureDeps: () => { calls.push(['ensureDeps']); } };
  const out = prepareRuntimeDeps({
    sea: fakeSea, deps: fakeDeps, cacheRoot: '/cache', libexec: '/lib', here: '/bin', verbose: false, env: {},
  });
  assert.strictEqual(out.seaDepsNM, '/cache/sea-deps/SIG/node_modules');
  assert.strictEqual(out.bunShimSrc, '/cache/sea-deps/bun-shim.cjs');
  assert.deepStrictEqual(calls, [
    ['materializeDeps', '/cache'],
    ['materializeBunShim', path.join('/cache', 'sea-deps')],
  ]);
  assert.ok(!calls.some((c) => c[0] === 'ensureDeps'), 'ensureDeps must not run under SEA');
});

test('prepareRuntimeDeps under non-SEA: calls ensureDeps, no materialization', () => {
  const calls = [];
  const fakeSea = {
    isSea: () => false,
    materializeDeps: () => { calls.push(['materializeDeps']); return 'X'; },
    materializeBunShim: () => { calls.push(['materializeBunShim']); return 'Y'; },
  };
  const fakeDeps = { ensureDeps: (o) => { calls.push(['ensureDeps', o.libexec, o.here]); } };
  const out = prepareRuntimeDeps({
    sea: fakeSea, deps: fakeDeps, cacheRoot: '/cache', libexec: '/lib', here: '/bin', verbose: true, env: { X: 1 },
  });
  assert.strictEqual(out.seaDepsNM, null);
  assert.strictEqual(out.bunShimSrc, undefined);
  assert.deepStrictEqual(calls, [['ensureDeps', '/lib', '/bin']]);
});

test('applyNodePath includes the sea-deps node_modules (extraDir), most-authoritative', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seanp-'));
  try {
    const seaNM = path.join(tmp, 'sea-deps', 'SIG', 'node_modules');
    fs.mkdirSync(seaNM, { recursive: true });
    const env = { NODE_PATH: '/user/mods' };
    hosttools.applyNodePath({ env, here: path.join(tmp, 'libexec'), node: process.execPath, extraDir: seaNM });
    const parts = env.NODE_PATH.split(path.delimiter);
    assert.strictEqual(parts[0], '/user/mods', 'user NODE_PATH stays ahead');
    assert.ok(parts.includes(seaNM), 'sea-deps node_modules must be on NODE_PATH');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractIfNeeded sources the bun-shim from the injected bunShimSrc (SEA), not libexec', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seaext-'));
  try {
    // A libexec with its OWN bun-shim + a fake extractor sig target. We drive a cache
    // HIT (cli.cjs + shim present, sig matches) so no real extraction runs; the shim
    // refresh then proves which source wins.
    const libexec = path.join(tmp, 'libexec');
    fs.mkdirSync(libexec, { recursive: true });
    fs.writeFileSync(path.join(libexec, 'bun-shim.cjs'), '// LIBEXEC shim\n');
    // The materialized (SEA) shim, elsewhere.
    const seaShim = path.join(tmp, 'materialized', 'bun-shim.cjs');
    fs.mkdirSync(path.dirname(seaShim), { recursive: true });
    fs.writeFileSync(seaShim, '// SEA shim\n');

    const { sigOf } = require('../libexec/clode-resolve.cjs');
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'cli.cjs'), '// cached cli\n');
    fs.writeFileSync(path.join(cacheDir, 'bun-shim.cjs'), '// stale shim\n');
    const extractorSig = sigOf(path.join(__dirname, '..', 'libexec', 'extract-claude-js.cjs'));
    fs.writeFileSync(path.join(cacheDir, '.extractor-sig'), extractorSig + '\n');

    // libexec here points at the REAL libexec so the extractor-sig matches; the shim
    // source is overridden via bunShimSrc.
    extractIfNeeded({
      bin: '/unused', cacheDir, libexec: path.join(__dirname, '..', 'libexec'),
      bunShimSrc: seaShim, key: 'test',
    });
    assert.strictEqual(fs.readFileSync(path.join(cacheDir, 'bun-shim.cjs'), 'utf8'), '// SEA shim\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
