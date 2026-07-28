'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('naude sea-config embeds the baked cli.cjs + bun-shim + deps, NOT the extractor', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const cfg = naudeSeaConfig({ mainBundle: '/b/entry.js', cliCjs: '/cache/cli.cjs',
    bunShim: '/lx/bun-shim.cjs', tar: '/o/deps.tar', sig: '/o/deps.sig', out: '/o',
    targetUpdateCheck: '/lx/target-update-check.cjs' });
  assert.strictEqual(cfg.assets['cli.cjs'], '/cache/cli.cjs');
  assert.strictEqual(cfg.assets['bun-shim.cjs'], '/lx/bun-shim.cjs');
  assert.ok(cfg.assets['deps.tar'] && cfg.assets['deps.sig']);
  assert.ok(!('extract-claude-js.cjs' in cfg.assets), 'naude must NOT embed the extractor');
  assert.strictEqual(cfg.main, '/b/entry.js');
});

// Task 5 (auto-update notify-only, naude parity): the baked cli.cjs's own
// PRELUDE resolves target-update-check.cjs dynamically off __dirname at
// runtime (naude-entry.cjs's materialized workDir) — it MUST ride as a real
// SEA asset, the same way bun-shim.cjs and cli.cjs do, or the notify-only
// autoupdater 404s the moment it fires. See naudeSeaConfig's own comment for
// the full rationale.
test('naude sea-config embeds target-update-check.cjs (the notify-only autoupdater dependency)', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const cfg = naudeSeaConfig({ mainBundle: '/b/entry.js', cliCjs: '/cache/cli.cjs',
    bunShim: '/lx/bun-shim.cjs', tar: '/o/deps.tar', sig: '/o/deps.sig', out: '/o',
    targetUpdateCheck: '/lx/target-update-check.cjs' });
  assert.strictEqual(cfg.assets['target-update-check.cjs'], '/lx/target-update-check.cjs');
});

// writeSeaConfig: defaults targetUpdateCheck to the checkout's OWN
// libexec/target-update-check.cjs (clode's own code, not staged per-bundle
// like the bun-shim) — a plain `node scripts/build-naude.mjs --cli ...` keeps
// working with no new flag required.
test('writeSeaConfig: defaults targetUpdateCheck to the checkout libexec/target-update-check.cjs', async () => {
  const { writeSeaConfig } = await import('../scripts/build-naude.mjs');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-writeseaconfig-tuc-'));
  try {
    const cliCjs = path.join(stage, 'cli.cjs');
    fs.writeFileSync(cliCjs, '// staged cli.cjs\n');
    fs.writeFileSync(path.join(stage, 'bun-shim.cjs'), '// staged bun-shim\n');
    const { cfgPath } = writeSeaConfig({
      bundle: '/b/naude-entry.bundle.cjs', cliCjs, tar: '/o/deps.tar', sigFile: '/o/deps.sig',
      outDir: stage,
    });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const REPO = path.resolve(__dirname, '..');
    assert.strictEqual(cfg.assets['target-update-check.cjs'], path.join(REPO, 'libexec', 'target-update-check.cjs'));
    assert.ok(fs.existsSync(cfg.assets['target-update-check.cjs']), 'the default must point at a real, existing file');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

// writeSeaConfig: fail loud (not a silently-missing asset) when an explicit
// targetUpdateCheck override does not exist — mirrors the existing bun-shim
// fail-loud check just above it in the source.
test('writeSeaConfig: fails loud when targetUpdateCheck does not exist', async () => {
  const { writeSeaConfig } = await import('../scripts/build-naude.mjs');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-writeseaconfig-tuc-missing-'));
  try {
    const cliCjs = path.join(stage, 'cli.cjs');
    fs.writeFileSync(cliCjs, '// staged cli.cjs\n');
    fs.writeFileSync(path.join(stage, 'bun-shim.cjs'), '// staged bun-shim\n');
    // build-naude.mjs is ESM and this guard calls process.exit(1) directly —
    // assert it out-of-process (a fresh node importing the module and calling
    // writeSeaConfig with a bogus override) rather than trying to catch an
    // exit call in-process.
    // pathToFileURL, not the raw path: on Windows an absolute path (D:\\...) is not a
    // valid ESM specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME, protocol 'd:').
    const modUrl = pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'build-naude.mjs')).href;
    const script = `
      import(${JSON.stringify(modUrl)}).then(({ writeSeaConfig }) => {
        writeSeaConfig({
          bundle: '/b/naude-entry.bundle.cjs',
          cliCjs: ${JSON.stringify(cliCjs)},
          tar: '/o/deps.tar', sigFile: '/o/deps.sig',
          outDir: ${JSON.stringify(stage)},
          targetUpdateCheck: '/nonexistent/target-update-check.cjs',
        });
      });
    `;
    const r = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /target-update-check\.cjs not found/);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

// The `builder` path (the clode that built this naude, once fed to the in-app
// updater's rebuild callback) is RETIRED: auto-update is notify-only now (a
// version check, no rebuild), so naudeSeaConfig writes no `builder` asset and
// there is no --builder flag to parse. This guards the retirement.
test('naude sea-config: never bakes a `builder` asset (rebuild callback retired)', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-sea-config-'));
  try {
    const cfg = naudeSeaConfig({ mainBundle: '/b/entry.js', cliCjs: '/cache/cli.cjs',
      bunShim: '/lx/bun-shim.cjs', tar: '/o/deps.tar', sig: '/o/deps.sig', out });
    assert.ok(!('builder' in cfg.assets), 'the builder asset is retired (notify-only auto-update)');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('build-naude no longer exports parseBuilderArg (the --builder write-side is retired)', async () => {
  const mod = await import('../scripts/build-naude.mjs');
  assert.strictEqual(mod.parseBuilderArg, undefined, 'parseBuilderArg is gone');
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
// carried postject, no esbuild/npm on the user path. The new flags all
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

// ---------------------------------------------------------------------------
// Task 3 (naude cross-build): the node role split. blob-gen (--experimental-
// sea-config, RUNS) and embed (postject byte-injection, does NOT run) split
// by node VERSION not arch — see build-naude.mjs's parseNodesArg comment.
// ---------------------------------------------------------------------------

test('parseNodesArg: --node sets both roles; --blobgen-node/--embed-node split them', async () => {
  const { parseNodesArg } = await import('../scripts/build-naude.mjs');
  assert.deepStrictEqual(parseNodesArg(['--node', '/n']), { blobgen: '/n', embed: '/n' });
  assert.deepStrictEqual(
    parseNodesArg(['--blobgen-node', '/host', '--embed-node', '/target']),
    { blobgen: '/host', embed: '/target' });
});

test('parseNodesArg: --embed-node alone inherits --blobgen-node for blob-gen only if given', async () => {
  const { parseNodesArg } = await import('../scripts/build-naude.mjs');
  // blobgen missing -> undefined (main resolves/validates); embed explicit
  assert.deepStrictEqual(parseNodesArg(['--embed-node', '/t']), { blobgen: undefined, embed: '/t' });
});

// resolveBuildNodes: the header's documented standalone contract — "a plain
// `node scripts/build-naude.mjs --cli <staged cli.cjs>` still builds a working
// naude" — means neither node flag given must default BOTH roles to the
// running node, not hard-fail. test/oracle-binaries.test.cjs:38 relies on
// exactly this (calls build-naude with bare --cli, no --node).
test('resolveBuildNodes: neither flag given -> both default to the running node (bare --cli contract)', async () => {
  const { resolveBuildNodes } = await import('../scripts/build-naude.mjs');
  assert.deepStrictEqual(resolveBuildNodes({ blobgen: undefined, embed: undefined }, '/run'),
    { blobgen: '/run', embed: '/run' });
});

test('resolveBuildNodes: both split flags given -> passed through unchanged', async () => {
  const { resolveBuildNodes } = await import('../scripts/build-naude.mjs');
  assert.deepStrictEqual(resolveBuildNodes({ blobgen: '/a', embed: '/b' }), { blobgen: '/a', embed: '/b' });
});

test('resolveBuildNodes: exactly one split flag given -> throws (a cross build needs both)', async () => {
  const { resolveBuildNodes } = await import('../scripts/build-naude.mjs');
  assert.throws(() => resolveBuildNodes({ blobgen: undefined, embed: '/t' }), /need a node/);
});

test('buildBinary embeds the GIVEN (foreign) node, independent of the blob-gen node', async () => {
  const { buildBinary } = await import('../scripts/build-naude.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-xembed-'));
  const foreignNode = path.join(d, 'foreign-node'); fs.writeFileSync(foreignNode, 'FOREIGN-NODE-BYTES');
  const blob = path.join(d, 'sea-prep.blob'); fs.writeFileSync(blob, 'BLOB');
  const out = path.join(d, 'naude-x');
  let injected = null, signed = [];
  await buildBinary({
    nodePath: foreignNode, postjectDir: '/pj', blob, outOverride: out,
    readNode: (p) => fs.readFileSync(p),
    requirePostject: () => ({ inject: async (bin) => { injected = fs.readFileSync(bin, 'utf8'); } }),
    sign: (phase) => signed.push(phase),
  });
  assert.strictEqual(injected, 'FOREIGN-NODE-BYTES', 'the FOREIGN node bytes were the SEA base');
  assert.deepStrictEqual(signed, ['unsign', 'sign']);
});

// The retirement, at the writeSeaConfig layer: even if a stale caller still
// passed a `builder`, the produced sea-config.json must carry no `builder`
// asset (notify-only auto-update — nothing reads a builder path anymore).
test('writeSeaConfig: produces no `builder` asset (rebuild callback retired)', async () => {
  const { writeSeaConfig } = await import('../scripts/build-naude.mjs');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-writeseaconfig-'));
  try {
    const cliCjs = path.join(stage, 'cli.cjs');
    fs.writeFileSync(cliCjs, '// staged cli.cjs\n');
    fs.writeFileSync(path.join(stage, 'bun-shim.cjs'), '// staged bun-shim\n');
    const { cfgPath } = writeSeaConfig({
      bundle: '/b/naude-entry.bundle.cjs', cliCjs, tar: '/o/deps.tar', sigFile: '/o/deps.sig',
      outDir: stage,
    });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(!('builder' in cfg.assets), 'the builder asset is retired (notify-only auto-update)');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

// Task 4 (off-Mac darwin signing): --darwin-signer <path> threads the rcodesign
// binary (provisioned by clode-fuse.cjs's naude branch) down to buildBinary's
// two sign() calls. Absent -> null, same "no flag given" contract as every
// other parse* helper in this file.
test('parseDarwinSignerArg: absent -> null; given -> the path', async () => {
  const { parseDarwinSignerArg } = await import('../scripts/build-naude.mjs');
  assert.strictEqual(parseDarwinSignerArg(['--cli', '/x']), null);
  assert.strictEqual(parseDarwinSignerArg(['--darwin-signer', '/t/rcodesign']), '/t/rcodesign');
});

test('buildBinary forwards signerBin into both sign phases', async () => {
  const { buildBinary } = await import('../scripts/build-naude.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-signer-'));
  const node = path.join(d, 'node'); fs.writeFileSync(node, 'N');
  const blob = path.join(d, 'b'); fs.writeFileSync(blob, 'B');
  const seen = [];
  await buildBinary({
    nodePath: node, postjectDir: '/pj', blob, outOverride: path.join(d, 'out'),
    targetOs: 'darwin', signerBin: '/t/rcodesign',
    readNode: (p) => fs.readFileSync(p),
    requirePostject: () => ({ inject: async () => {} }),
    sign: (phase, bin, os, signerBin) => seen.push({ phase, os, signerBin }),
  });
  assert.deepStrictEqual(seen.map((s) => s.signerBin), ['/t/rcodesign', '/t/rcodesign']);
  assert.deepStrictEqual(seen.map((s) => s.phase), ['unsign', 'sign']);
});
