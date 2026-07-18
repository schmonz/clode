'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
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

// The builder path (the clode that built this naude, for the in-app updater's
// callback) used to be baked via esbuild --define __CLODE_BUILDER__. Now it's a
// SEA asset — runtime data, not a build-time string burned into the bundle —
// so the SAME esbuilt naude-entry bundle serves every build regardless of who
// built it. naudeSeaConfig writes the builder path to a file and adds it as
// the `builder` asset.
test('naude sea-config: a non-empty `builder` is written to a file and added as an asset', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-sea-config-'));
  try {
    const cfg = naudeSeaConfig({ mainBundle: '/b/entry.js', cliCjs: '/cache/cli.cjs',
      bunShim: '/lx/bun-shim.cjs', tar: '/o/deps.tar', sig: '/o/deps.sig', out,
      builder: '/abs/clode' });
    assert.ok(cfg.assets.builder, 'expected a `builder` asset when `builder` is a non-empty string');
    assert.strictEqual(fs.readFileSync(cfg.assets.builder, 'utf8'), '/abs/clode');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('naude sea-config: a null `builder` adds no `builder` asset (the fail-loud null path)', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-sea-config-'));
  try {
    const cfg = naudeSeaConfig({ mainBundle: '/b/entry.js', cliCjs: '/cache/cli.cjs',
      bunShim: '/lx/bun-shim.cjs', tar: '/o/deps.tar', sig: '/o/deps.sig', out,
      builder: null });
    assert.ok(!('builder' in cfg.assets), 'no builder -> no `builder` asset -> updater fails loud');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
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
  // An already-absolute path survives unchanged. The expectation is built with
  // path.resolve rather than written as a literal because "absolute" is
  // platform-specific: on Windows path.resolve('/abs/naude') is 'D:\abs\naude'
  // (drive-qualified), so the hardcoded POSIX literal this replaces asserted
  // something only true on POSIX and failed every windows-latest CI run.
  const abs = path.resolve(`${path.sep}abs${path.sep}naude`);
  assert.strictEqual(parseOutArg(['--out', abs]), abs);
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

// ---------------------------------------------------------------------------
// Task 5 (clode-fetches-naude-engine): the fetched node + prebuilt bundle +
// carried postject, no esbuild/npm on the user path. The five new flags all
// default to the checkout's own locations/running node, so a plain
// `node scripts/build-naude.mjs --cli ...` keeps working unchanged.
// ---------------------------------------------------------------------------

test('parseNodeArg: absent -> process.execPath (the plain-checkout default)', async () => {
  const { parseNodeArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseNodeArg(['--cli', '/x/cli.cjs']), process.execPath);
});

test('parseNodeArg: --node <path> resolves to an absolute path, NOT process.execPath', async () => {
  const { parseNodeArg } = await import('../scripts/build-naude.mjs');
  const got = parseNodeArg(['--node', '/opt/fetched-node/bin/node']);
  assert.strictEqual(got, path.resolve('/opt/fetched-node/bin/node'));
  assert.notStrictEqual(got, process.execPath);
});

test('parseBundleArg: absent -> the checkout default (build/bundle/naude-entry.bundle.cjs)', async () => {
  const { parseBundleArg } = await import('../scripts/build-naude.mjs');
  const REPO = path.resolve(__dirname, '..');
  assert.strictEqual(parseBundleArg([]), path.join(REPO, 'build', 'bundle', 'naude-entry.bundle.cjs'));
});

test('parseBundleArg: --bundle <path> wins over the default', async () => {
  const { parseBundleArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseBundleArg(['--bundle', '/staged/naude-entry.bundle.cjs']),
    path.resolve('/staged/naude-entry.bundle.cjs'));
});

test('parseNmdirArg: absent -> the checkout default (deps/claude/node_modules)', async () => {
  const { parseNmdirArg } = await import('../scripts/build-naude.mjs');
  const REPO = path.resolve(__dirname, '..');
  assert.strictEqual(parseNmdirArg([]), path.join(REPO, 'deps', 'claude', 'node_modules'));
});

test('parseNmdirArg: --nmdir <path> wins over the default', async () => {
  const { parseNmdirArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseNmdirArg(['--nmdir', '/mat/node_modules']), path.resolve('/mat/node_modules'));
});

test('parsePostjectArg: absent -> the checkout default (deps/clode/node_modules/postject)', async () => {
  const { parsePostjectArg } = await import('../scripts/build-naude.mjs');
  const REPO = path.resolve(__dirname, '..');
  assert.strictEqual(parsePostjectArg([]), path.join(REPO, 'deps', 'clode', 'node_modules', 'postject'));
});

test('parsePostjectArg: --postject <dir> wins over the default', async () => {
  const { parsePostjectArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parsePostjectArg(['--postject', '/mat/postject']), path.resolve('/mat/postject'));
});

// parseBuilderArg: --builder wins; else CLODE_SELF (the historical esbuild
// --define source, kept as an env fallback); else null (fail-loud-not-wrong).
test('parseBuilderArg: --builder <path> wins over CLODE_SELF', async () => {
  const { parseBuilderArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseBuilderArg(['--builder', '/abs/clode'], { CLODE_SELF: '/other/clode' }), '/abs/clode');
});

test('parseBuilderArg: absent --builder falls back to env.CLODE_SELF', async () => {
  const { parseBuilderArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseBuilderArg([], { CLODE_SELF: '/env/clode' }), '/env/clode');
});

test('parseBuilderArg: neither --builder nor CLODE_SELF -> null (fail-loud-not-wrong)', async () => {
  const { parseBuilderArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseBuilderArg([], {}), null);
});

// generateBlob: the SEA-config pass now runs the GIVEN --node, not
// process.execPath. Asserted via the injectable execFileSync seam (matching
// scripts/lib/npm-cli.cjs's pattern) — no real Node >= 24 SEA-config pass runs.
test('generateBlob: runs the GIVEN node, not process.execPath', async () => {
  const { generateBlob } = await import('../scripts/build-naude.mjs');
  const calls = [];
  const fakeExec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); };
  generateBlob('/fake/fetched/node', '/some/sea-config.json', { execFileSync: fakeExec });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, '/fake/fetched/node');
  assert.notStrictEqual(calls[0].cmd, process.execPath);
  assert.deepStrictEqual(calls[0].args, ['--experimental-sea-config', '/some/sea-config.json']);
});

// buildBinary: embeds the GIVEN --node's bytes, not process.execPath's, and
// injects via the GIVEN --postject. Asserted via injectable seams (readNode,
// requirePostject, sign) so this runs with no real postject/codesign.
test('buildBinary: embeds the bytes read from the GIVEN --node, not process.execPath', async () => {
  const { buildBinary } = await import('../scripts/build-naude.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-buildbinary-'));
  try {
    const blob = path.join(dir, 'sea-prep.blob');
    fs.writeFileSync(blob, 'BLOB-BYTES');
    const bin = path.join(dir, 'naude-out', 'naude');
    const fakeNodeBytes = 'FAKE-FETCHED-NODE-BYTES';
    const readCalls = [];
    let injectCall = null;
    const signCalls = [];
    const got = await buildBinary({
      nodePath: '/fake/fetched/node',
      postjectDir: '/fake/postject/dir',
      blob,
      outOverride: bin,
      readNode: (p) => { readCalls.push(p); return Buffer.from(fakeNodeBytes); },
      requirePostject: (dir) => {
        assert.strictEqual(dir, '/fake/postject/dir');
        return { inject: async (binPath, name, data, opts) => { injectCall = { binPath, name, data, opts }; } };
      },
      sign: (phase, binPath) => { signCalls.push({ phase, binPath }); },
    });
    assert.strictEqual(got, bin);
    assert.deepStrictEqual(readCalls, ['/fake/fetched/node']);
    // The bytes actually on disk are what readNode returned, NOT this host's
    // real process.execPath (which would be a real, much larger Mach-O/ELF/PE).
    assert.strictEqual(fs.readFileSync(bin, 'utf8'), fakeNodeBytes);
    assert.ok(injectCall, 'postject.inject was never called');
    assert.strictEqual(injectCall.binPath, bin);
    assert.deepStrictEqual(signCalls.map((c) => c.phase), ['unsign', 'sign']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The deferred wiring THIS task lands: writeSeaConfig used to silently drop
// `builder` instead of passing it to naudeSeaConfig, so every naude built
// through this path baked NO builder asset regardless of --builder/CLODE_SELF.
test('writeSeaConfig: threads `builder` through to the config (the deferred wiring, landed)', async () => {
  const { writeSeaConfig } = await import('../scripts/build-naude.mjs');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-writeseaconfig-'));
  try {
    const cliCjs = path.join(stage, 'cli.cjs');
    fs.writeFileSync(cliCjs, '// staged cli.cjs\n');
    fs.writeFileSync(path.join(stage, 'bun-shim.cjs'), '// staged bun-shim\n');
    const { cfgPath } = writeSeaConfig({
      bundle: '/b/naude-entry.bundle.cjs', cliCjs, tar: '/o/deps.tar', sigFile: '/o/deps.sig',
      builder: '/abs/clode', outDir: stage,
    });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(cfg.assets.builder, 'sea-config.json must carry a `builder` asset when --builder is given');
    assert.strictEqual(fs.readFileSync(cfg.assets.builder, 'utf8'), '/abs/clode');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('writeSeaConfig: a null builder omits the asset (fail-loud-not-wrong, preserved)', async () => {
  const { writeSeaConfig } = await import('../scripts/build-naude.mjs');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-writeseaconfig-null-'));
  try {
    const cliCjs = path.join(stage, 'cli.cjs');
    fs.writeFileSync(cliCjs, '// staged cli.cjs\n');
    fs.writeFileSync(path.join(stage, 'bun-shim.cjs'), '// staged bun-shim\n');
    const { cfgPath } = writeSeaConfig({
      bundle: '/b/naude-entry.bundle.cjs', cliCjs, tar: '/o/deps.tar', sigFile: '/o/deps.sig',
      builder: null, outDir: stage,
    });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(!('builder' in cfg.assets), 'no builder -> no `builder` asset -> updater fails loud');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
