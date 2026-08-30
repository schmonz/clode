'use strict';
// scripts/make-min-provider.cjs shrinks an upstream provider to something a MEMORY-POOR
// guest can build from — the netbsd-sparc leg fuses inside a sun4m VM with 512MB, the
// hardware ceiling, under TCG, where a 376MB binary simply OOMs.
//
// IT HAD NO TEST, AND IT ROTTED. When upstream went code-split at 2.1.243 the extractor
// learned the new shape but this did not, so it exited 1 with "no entrypoints/cli.js
// @bun-cjs block (format changed?)". That surfaced on 2026-08-25 as a red netbsd-sparc —
// a PUBLISHING leg, hard-gated — roughly three hours into the slowest job in the matrix,
// long after twelve other legs had gone green.
//
// It is also called with two different error semantics, which is its own hazard:
//     build-leg:689   `... 2>/dev/null; then`   failure SWALLOWED, falls through
//     build-leg:728   bare call                 failure FATAL (this is the sparc path)
// So the same breakage is invisible at one call site and fatal at the other. Until those
// are unified (see BACKLOG), this file is what keeps the script honest.
//
// The contract, both shapes: the minimised provider must be RECOGNISED as the same shape
// as its input and must decode/carve to the SAME entry content. Small is worthless if it
// is not equivalent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'make-min-provider.cjs');
const { isSplitBundle } = require('../libexec/extract-claude-js.cjs');
const { carveBlocks } = require('../libexec/bundle-carve.cjs');
const { loadGraph, loadGraphFull } = require('../libexec/bun-graph.cjs');

// Resolve providers the way the product does, then anything the fixtures know about.
// Skips report WHERE they looked — a silent skip is how this class of bug survives.
function providers() {
  const found = [], seen = new Set();
  const add = (p) => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); found.push(p); } };
  add(process.env.CLODE_PROVIDER_BIN);
  add(process.env.CLODE_CLAUDE_BIN);
  try {
    add(execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8' }).trim());
  } catch { /* reported in the skip message */ }
  try {
    const { VERSIONS, providerBin } = require('./golden-shas-lib.cjs');
    for (const v of VERSIONS) add(providerBin(v));
  } catch { /* fixture lib unavailable */ }
  return found;
}

const PROVIDERS = providers();
const opts = {
  skip: PROVIDERS.length ? false
    : 'no Claude provider found (CLODE_PROVIDER_BIN, CLODE_CLAUDE_BIN, scripts/find-provider.mjs, or the golden-shas store)',
};

function minimise(src) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'min-prov-')), 'provider-min');
  const r = execFileSync(process.execPath, [SCRIPT, src, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { out, log: r };
}

test('every provider minimises, and the result keeps its SHAPE', opts, () => {
  for (const bin of PROVIDERS) {
    const { out } = minimise(bin);
    assert.ok(fs.existsSync(out), `${bin}: no output written`);
    assert.strictEqual(isSplitBundle(out), isSplitBundle(bin),
      `${bin}: minimised provider changed shape (split=${isSplitBundle(bin)} -> ${isSplitBundle(out)})`);
    // NOT-LARGER, not strictly-smaller: minimising an ALREADY-minimised provider is a
    // no-op, and demanding it shrink again turned that correct behaviour into a red.
    assert.ok(fs.statSync(out).size <= fs.statSync(bin).size,
      `${bin}: minimised provider is LARGER than its input`);
    // IDEMPOTENT: running it again must not change the result. That is the property
    // that actually matters — the CI calls it once, but a pipeline that ever calls it
    // twice must not produce a third thing.
    const { out: twice } = minimise(out);
    assert.strictEqual(fs.statSync(twice).size, fs.statSync(out).size,
      `${bin}: minimising twice changed the size`);
    // And a REAL upstream provider (hundreds of MB) must shrink substantially — that is
    // the entire reason this script exists.
    if (fs.statSync(bin).size > 100 * 1024 * 1024) {
      assert.ok(fs.statSync(out).size < fs.statSync(bin).size / 2,
        `${bin}: a full provider must minimise to well under half`);
    }
  }
});

test('a CJS provider minimises to the SAME carved entry body', opts, () => {
  let checked = 0;
  for (const bin of PROVIDERS) {
    if (isSplitBundle(bin)) continue;
    const before = carveBlocks(fs.readFileSync(bin, 'latin1'))
      .find((b) => b.name && /entrypoints\/cli\.js$/.test(b.name));
    if (!before) continue;
    const { out } = minimise(bin);
    const after = carveBlocks(fs.readFileSync(out, 'latin1'))
      .find((b) => b.name && /entrypoints\/cli\.js$/.test(b.name));
    assert.ok(after, `${bin}: minimised provider has no carvable entry`);
    assert.strictEqual(after.body.length, before.body.length, `${bin}: entry body length changed`);
    assert.strictEqual(after.body, before.body, `${bin}: entry body CONTENT changed`);
    checked++;
  }
  if (!checked) return;                 // no CJS-shaped provider present
  assert.ok(checked > 0);
});

test('a SPLIT provider minimises to the same module graph, entry included', opts, () => {
  let checked = 0;
  for (const bin of PROVIDERS) {
    if (!isSplitBundle(bin)) continue;
    const before = loadGraph(bin);
    const beforeEntry = loadGraphFull(bin).entryName;
    const { out } = minimise(bin);
    const after = loadGraph(out);
    assert.strictEqual(after.size, before.size, `${bin}: module count changed`);
    assert.strictEqual(loadGraphFull(out).entryName, beforeEntry, `${bin}: entry name changed`);
    // Content equality on every module — the point of minimising is to drop bytecode
    // blobs and asset rows, never to alter a single byte of JS.
    for (const [name, src] of before) {
      assert.ok(after.has(name), `${bin}: ${name} missing after minimising`);
      assert.strictEqual(after.get(name), src, `${bin}: ${name} content changed`);
    }
    checked++;
  }
  if (!checked) return;                 // no split-shaped provider present
  assert.ok(checked > 0);
});

test('minimising REFUSES loudly on a non-provider rather than writing junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-prov-bad-'));
  const bad = path.join(dir, 'not-a-provider');
  fs.writeFileSync(bad, 'this is not a Bun binary');
  const out = path.join(dir, 'out');
  let status = 0, stderr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, bad, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { status = e.status; stderr = (e.stderr || '') + (e.stdout || ''); }
  assert.notStrictEqual(status, 0, 'must exit nonzero on a file that is not a provider');
  assert.match(stderr, /make-min-provider/, 'the refusal must name itself');
  assert.strictEqual(fs.existsSync(out), false, 'must not leave a partial output behind');
});

// WHAT AN ASSET IS, DECIDED ONCE AND HELD THERE. bun-graph.cjs decides what a FULL carve
// stages; this script decides what a MINIMISED provider still contains; the carve's
// referenced-but-unserved gate decides what a dropped row means. If those disagree, a minimised
// build and a real one carve different graphs and the difference is invisible until a leg dies —
// which is exactly how loader 5 shipped broken in 2.1.251. The script now DERIVES its set from
// the gate's LOADER_POLICY; this test pins bun-graph, the last un-derived copy, to it — read as
// TEXT, the way test/scc-merge.test.cjs pins the node-shim transform.
test('ONE loader policy: what the minimiser keeps is what the carve serves', () => {
  // THREE FILES USED TO RESTATE THE SAME DECISION — bun-graph's loadAssetsFromBytes, this
  // script's KEEP literal, and (now) the carve's referenced-but-unserved gate. That decision
  // has been wrong twice (2.1.246 loader 13, 2.1.251 loader 5) and each time only one or two
  // of the copies got fixed. LOADER_POLICY in libexec/extract-claude-js.cjs is the source;
  // KEEP is DERIVED from it. This test holds the last un-derived copy (bun-graph's) to it.
  const min = fs.readFileSync(SCRIPT, 'utf8');
  const bg = fs.readFileSync(path.join(REPO, 'libexec', 'bun-graph.cjs'), 'utf8');
  const { LOADER_POLICY } = require(path.join(REPO, 'libexec', 'extract-claude-js.cjs'));

  assert.ok(!/const KEEP = new Set\(\[[0-9, ]+\]\)/.test(min),
    'KEEP must be DERIVED from LOADER_POLICY, not restated as a literal here');
  assert.match(min, /const KEEP = new Set\(Object\.keys\(LOADER_POLICY\)/,
    'make-min-provider must derive its kept loaders from LOADER_POLICY');

  const served = new Set(Object.keys(LOADER_POLICY)
    .filter((n) => LOADER_POLICY[n] !== 'excluded').map(Number));
  assert.ok(served.has(1), 'the js loader is always served');
  assert.strictEqual(LOADER_POLICY[10], 'excluded',
    'loader 10 (napi) is native code no target loads — it must stay an explicit, measured exclusion');

  const asset = /if \(r\.loader !== ([0-9]+) && r\.loader !== ([0-9]+)\) continue;/.exec(bg);
  assert.ok(asset, 'bun-graph loadAssetsFromBytes must name the asset loaders it takes');
  const staged = new Set([Number(asset[1]), Number(asset[2])]);

  assert.deepStrictEqual([...served].sort(), [1, ...staged].sort(),
    'LOADER_POLICY must serve exactly the js loader plus the asset loaders bun-graph stages — '
    + 'otherwise the gate passes a graph whose assets the minimiser dropped, or vice versa');
});

// THE PLATFORM MUST SURVIVE MINIMISATION. `providerPlatformOf` reads the first 16 bytes for a
// Mach-O/PE/ELF header, and the minimised provider used to be a purely synthetic container with
// none — so it answered "unknown". Every leg that builds goes through stage-provider.mjs, which
// minimises unconditionally, so the platform half of the extract cache key was "unknown" for
// exactly the providers CI builds from, and a linux carve and a darwin carve of the same version
// still shared a key. That is the bug that shipped a darwin quaude unable to read the login
// Keychain (see test/provider-platform.test.cjs); the cache key was fixed, this half was not.
test('a minimised provider still reports the platform it was carved from', opts, () => {
  const { providerPlatformOf } = require('../libexec/extract-claude-js.cjs');
  for (const bin of PROVIDERS) {
    const before = providerPlatformOf(bin);
    if (!before) continue;               // already-minimised or synthetic input: nothing to carry
    const { out } = minimise(bin);
    assert.strictEqual(providerPlatformOf(out), before,
      `${bin}: minimising lost the platform (${before} -> ${providerPlatformOf(out)}); the `
      + 'extract cache key cannot tell two platforms apart');
    // ... and the result must still decode, i.e. the header prefix did not disturb the layout.
    // A split provider decodes as a graph; a CJS one has no Bun trailer and carves instead.
    if (isSplitBundle(out)) {
      assert.ok(loadGraph(out).size > 0, `${bin}: minimised provider no longer decodes`);
    } else {
      const blocks = carveBlocks(fs.readFileSync(out, 'latin1'));
      assert.ok(blocks.some((bl) => (bl.name || '').endsWith('entrypoints/cli.js')),
        `${bin}: minimised CJS provider no longer carves`);
    }
  }
});

// THE MINIMISED PROVIDER MUST NOT NEED A ZSTD DECODER, and this is the whole reason it is
// minimised on the RUNNER and carried into a guest. From Claude Code 2.1.251 upstream embeds
// its text assets as zstd frames (101 loader-5 rows), and this script copied those frames
// through verbatim. Carving them back out needs a decoder, and the runtimes that receive a
// minimised provider are exactly the ones that have none:
//
//   * tjs has no zstd, and `node-shim/modules/zlib.cjs` deliberately has none, so a shipped
//     clode can only reach one by SPAWNING a host `zstd` (libexec/host-provision.cjs);
//   * the netbsd-sparc guest is our own pinned wd0 image, and it has NO zstd, unzstd or
//     zstdcat anywhere — verified 2026-08-29 by booting that exact image under
//     qemu-system-sparc: `which zstd` -> not found, /usr/bin/{zstd,unzstd,zstdcat} absent,
//     sets base/comp/etc/gpufw/misc/modules/rescue/tests. It has no guest-packages either,
//     so there is nowhere for one to come from.
//
// So the sparc leg died on every run with `smoke-exit=1` about four minutes in, and the
// minimiser is the right place to fix it: it already rewrites the container, it runs on a fat
// x64 runner where a decoder is free, and decompressing there means the 512MB TCG guest does
// less work rather than more. Upstream's own reader is magic-conditional
// (`s(t)?Bun.zstdDecompressSync(t):t`), so a plain row is not a workaround — it is the other
// half of the shape upstream already supports.
//
// The check is BEHAVIOURAL, not a byte scan: re-carve the minimised provider in a child with
// `zlib.zstdDecompressSync` removed, PATH emptied and an isolated data dir (so host-provision
// can neither find a tool nor reuse a cached winner), and require the assets to come back
// IDENTICAL to what the real provider carves with a decoder present. Absence of frames alone
// would pass on a provider that lost its assets entirely.
const NO_ZSTD_PROBE = `
  const zlib = require('node:zlib');
  delete zlib.zstdDecompressSync;                 // tjs and node-shim both lack it
  const bg = require(process.argv[1]);          // libexec/bun-graph.cjs
  const a = bg.loadAssets(process.argv[2]);     // the minimised provider
  const o = {};
  for (const [k, v] of a) o[k] = require('node:crypto').createHash('sha256').update(v).digest('hex');
  process.stdout.write(JSON.stringify(o));
`;
test('a minimised provider carves with NO zstd anywhere, to the SAME assets', opts, () => {
  const BG = path.join(REPO, 'libexec', 'bun-graph.cjs');
  const { loadAssets: loadAssetsHere } = require('../libexec/bun-graph.cjs');
  for (const bin of PROVIDERS) {
    if (!isSplitBundle(bin)) continue;            // pre-split providers embed no zstd rows
    const { out } = minimise(bin);
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'no-zstd-'));
    const env = { ...process.env, PATH: '', HOME: isolated, XDG_DATA_HOME: isolated,
                  CLODE_DEPS: path.join(isolated, 'deps'), CLODE_CACHE: path.join(isolated, 'cache') };
    delete env.CLODE_ZSTD;
    let got;
    try {
      got = JSON.parse(execFileSync(process.execPath, ['-e', NO_ZSTD_PROBE, BG, out],
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      const lines = String(e.stderr || e.message || '').split('\n');
      const err = lines.find((l) => /^\s*\w*Error: /.test(l)) || lines[0] || '';
      assert.fail(`${bin}: a runtime with no zstd cannot carve the MINIMISED provider — which is `
        + `the only runtime the netbsd-sparc guest has. ${err.trim()}`);
    }
    // Equivalence, not just decodability: the real provider's assets, decoded here where a
    // decoder exists, must be exactly what the zstd-less carve produced.
    const want = {};
    for (const [k, v] of loadAssetsHere(bin)) want[k] = require('node:crypto').createHash('sha256').update(v).digest('hex');
    assert.deepStrictEqual(got, want,
      `${bin}: the minimised provider's assets differ from the real one's once decompressed`);
  }
});
