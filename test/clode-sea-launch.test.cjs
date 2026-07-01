'use strict';
// Task 4: under a SEA the bundle's ext-deps + support files are materialized from
// embedded assets into dirs shaped like the npm/source tree, then the UNCHANGED
// launcher runs against them. These tests exercise the real seams (prepareRuntimeDeps
// + the unchanged extractIfNeeded/applyNodePath) with injected fakes — no real SEA.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { prepareRuntimeDeps } = require('../libexec/clode-main.cjs');
const hosttools = require('../libexec/clode-hosttools.cjs');
const { extractIfNeeded } = require('../libexec/clode-extract.cjs');

test('prepareRuntimeDeps under SEA: materializes deps+libexec dirs, no ensureDeps', () => {
  const calls = [];
  const fakeSea = {
    isSea: () => true,
    materializeDeps: (o) => { calls.push(['materializeDeps', o.cacheDir]); return '/cache/sea-deps/SIG'; },
    materializeLibexec: (o) => { calls.push(['materializeLibexec', o.destDir]); return '/cache/sea-deps/libexec'; },
  };
  const fakeDeps = { ensureDeps: () => { calls.push(['ensureDeps']); } };
  const out = prepareRuntimeDeps({
    sea: fakeSea, deps: fakeDeps, cacheRoot: '/cache', libexec: '/lib', here: '/bin', verbose: false, env: {},
  });
  assert.strictEqual(out.seaDepsRoot, '/cache/sea-deps/SIG');
  assert.strictEqual(out.seaLibexec, '/cache/sea-deps/libexec');
  assert.deepStrictEqual(calls, [
    ['materializeDeps', '/cache'],
    ['materializeLibexec', path.join('/cache', 'sea-deps', 'libexec')],
  ]);
  assert.ok(!calls.some((c) => c[0] === 'ensureDeps'), 'ensureDeps must not run under SEA');
});

test('prepareRuntimeDeps under non-SEA: calls ensureDeps, dirs undefined', () => {
  const calls = [];
  const fakeSea = {
    isSea: () => false,
    materializeDeps: () => { calls.push(['materializeDeps']); return 'X'; },
    materializeLibexec: () => { calls.push(['materializeLibexec']); return 'Y'; },
  };
  const fakeDeps = { ensureDeps: (o) => { calls.push(['ensureDeps', o.libexec, o.here]); } };
  const out = prepareRuntimeDeps({
    sea: fakeSea, deps: fakeDeps, cacheRoot: '/cache', libexec: '/lib', here: '/bin', verbose: true, env: { X: 1 },
  });
  assert.strictEqual(out.seaDepsRoot, undefined);
  assert.strictEqual(out.seaLibexec, undefined);
  assert.deepStrictEqual(calls, [['ensureDeps', '/lib', '/bin']]);
});

test('the materialized depsRoot flows through applyNodePath unchanged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seanp-'));
  try {
    // Shape a materialized depsRoot: <depsRoot>/node_modules exists.
    const depsRoot = path.join(tmp, 'sea-deps', 'SIG');
    fs.mkdirSync(path.join(depsRoot, 'node_modules'), { recursive: true });
    const env = { NODE_PATH: '/user/mods' };
    // Exactly how runBundle calls it — no SEA-specific arg, just depsRoot.
    hosttools.applyNodePath({ env, here: path.join(tmp, 'libexec'), depsRoot, node: process.execPath });
    const parts = env.NODE_PATH.split(path.delimiter);
    assert.strictEqual(parts[0], '/user/mods', 'user NODE_PATH stays ahead');
    assert.ok(parts.includes(path.join(depsRoot, 'node_modules')), 'materialized node_modules must be on NODE_PATH');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractIfNeeded (unchanged) uses the materialized libexec for shim + extractor sig', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seaext-'));
  try {
    // A materialized libexec dir: bun-shim.cjs + a stand-in extract-claude-js.cjs.
    // (Content of the extractor file is irrelevant here — only its sigOf is read for
    // the cache-hit check; the real extraction is not triggered on a hit.)
    const seaLibexec = path.join(tmp, 'sea-deps', 'libexec');
    fs.mkdirSync(seaLibexec, { recursive: true });
    fs.writeFileSync(path.join(seaLibexec, 'bun-shim.cjs'), '// SEA shim\n');
    fs.writeFileSync(path.join(seaLibexec, 'extract-claude-js.cjs'), '// SEA extractor\n');

    const { sigOf } = require('../libexec/clode-resolve.cjs');
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'cli.cjs'), '// cached cli\n');
    fs.writeFileSync(path.join(cacheDir, 'bun-shim.cjs'), '// stale shim\n');
    // Prime the cache sig to match the materialized extractor's sigOf -> a hit.
    fs.writeFileSync(path.join(cacheDir, '.extractor-sig'),
      sigOf(path.join(seaLibexec, 'extract-claude-js.cjs')) + '\n');

    // Called EXACTLY as the non-SEA path calls it — libexec is just the materialized dir.
    extractIfNeeded({ bin: '/unused', cacheDir, libexec: seaLibexec, key: 'sea' });

    // Cache hit refreshed the shim from the materialized libexec (not the stale one).
    assert.strictEqual(fs.readFileSync(path.join(cacheDir, 'bun-shim.cjs'), 'utf8'), '// SEA shim\n');
    assert.ok(fs.existsSync(path.join(cacheDir, 'cli.cjs')), 'cache hit should be preserved');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
