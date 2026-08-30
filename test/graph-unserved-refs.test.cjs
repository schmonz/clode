// THE GATE THAT WOULD HAVE CAUGHT ALL THREE LOADER MOVES.
//
// Upstream has twice relaid content between Bun loaders and silently broken a built target,
// and a third case was broken in every target ever built without anyone noticing:
//
//   2.1.246  164 files moved out of JS into loader 13 (text). Targets booted and died on the
//            first turn: "cannot resolve /$bunfs/root/loopAutonomousPreamble-*.md".
//   2.1.251  94 of those moved again into loader 5 (file), zstd-compressed.
//   2.1.250  four loader-5 rows (mermaid/hljs/chart/payload) were REFERENCED AND UNSERVED in
//            every target ever built — read only when a chart renders, so no smoke saw them.
//
// libexec/extract-claude-js.cjs now cross-checks, after staging, the names the graph
// REFERENCES against the names it SERVES. This file is the proof that the check has teeth and
// that its scoping rule — a loader is served, excluded by decision, or a finding — holds.
//
// TWO LAYERS, same doctrine as test/bun-graph.test.cjs:
//   1. hermetic, on synthetic rows: the policy itself.
//   2. real providers, gated: the scan is NOT VACUOUS on real bytes, and it is silent on
//      the current shape while firing on the historical one.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const ex = require('../libexec/extract-claude-js.cjs');
const { graphReferences, unservedReferences, assertGraphServesWhatItReferences, LOADER_POLICY } = ex;
const { loadGraphFull, loadGraphFromBytes } = require('../libexec/bun-graph.cjs');

const B = '/$bunfs/root/';
const row = (name, loader) => ({ name: B + name, loader });

// ---- layer 1: the policy, on synthetic rows ----------------------------------

test('the module exports the gate at all', () => {
  for (const [k, v] of Object.entries({ graphReferences, unservedReferences, assertGraphServesWhatItReferences })) {
    assert.strictEqual(typeof v, 'function', `extract-claude-js.cjs must export ${k}()`);
  }
  assert.strictEqual(typeof LOADER_POLICY, 'object', 'the loader policy must be inspectable');
});

test('graphReferences finds container names quoted in module source', () => {
  const refs = graphReferences({
    [B + 'a.js']: 'import{x}from"/$bunfs/root/chunk-aa.js";readFileSync("/$bunfs/root/SKILL-bb.md")',
  });
  assert.ok(refs.has(B + 'chunk-aa.js'), 'static import specifier');
  assert.ok(refs.has(B + 'SKILL-bb.md'), 'asset read by literal path');
});

test('graphReferences also sees the WINDOWS virtual-fs prefix', () => {
  // A windows-built provider names its rows B:/~BUN/root/..., not /$bunfs/root/... . A scan
  // that only knew the POSIX prefix would report a clean bill of health for every windows
  // carve, forever — silence indistinguishable from correctness.
  const refs = graphReferences({ 'B:/~BUN/root/a.js': 'from"B:/~BUN/root/chunk-zz.js"' });
  assert.ok(refs.has('B:/~BUN/root/chunk-zz.js'));
});

test('a referenced TEXT row (loader 13) that the graph does not serve is a finding', () => {
  // The 2.1.246 regression, in miniature.
  const res = unservedReferences({
    rows: [row('a.js', 1), row('SKILL-bb.md', 13)],
    sources: { [B + 'a.js']: 'readFileSync("/$bunfs/root/SKILL-bb.md")' },
    assets: {},
  });
  assert.deepStrictEqual(res.findings.map((f) => [f.loader, f.name]), [[13, B + 'SKILL-bb.md']]);
  assert.throws(() => assertGraphServesWhatItReferences(res),
    (e) => /loader 13/.test(e.message) && e.message.includes(B + 'SKILL-bb.md'),
    'the refusal must name BOTH the loader number and the row');
});

test('a referenced FILE row (loader 5) that the graph does not serve is a finding', () => {
  // The 2.1.251 regression, and the 2.1.250 latent one.
  const res = unservedReferences({
    rows: [row('a.js', 1), row('mermaid.min.js', 5)],
    sources: { [B + 'a.js']: 'readFileSync("/$bunfs/root/mermaid.min.js")' },
    assets: {},
  });
  assert.deepStrictEqual(res.findings.map((f) => [f.loader, f.name]), [[5, B + 'mermaid.min.js']]);
});

test('a referenced row on a loader NOBODY HAS DECIDED ABOUT is a finding', () => {
  // The half that earns this ratchet its keep. Both real breaks were moves INTO a loader clode
  // did not yet serve, so a check scoped to the loaders we already handle would have been
  // silent on both. An undeclared loader number is exactly the event to refuse on.
  assert.ok(!(6 in LOADER_POLICY), 'this test assumes loader 6 (json) is still undeclared');
  const res = unservedReferences({
    rows: [row('a.js', 1), row('data.json', 6)],
    sources: { [B + 'a.js']: 'readFileSync("/$bunfs/root/data.json")' },
    assets: {},
  });
  assert.deepStrictEqual(res.findings.map((f) => [f.loader, f.policy]), [[6, null]]);
  assert.throws(() => assertGraphServesWhatItReferences(res), /loader 6/);
});

test('napi rows (loader 10) are SERVED BY DECISION, never a finding', () => {
  // scripts/make-min-provider.cjs drops loader 10 on purpose — native .node modules the tjs
  // targets have never had — and every CI leg builds from a minimised provider. A gate that
  // refused here would turn a correct, measured exclusion into a red leg everywhere.
  const res = unservedReferences({
    rows: [row('a.js', 1), row('image-processor.node', 10)],
    sources: { [B + 'a.js']: 'require("/$bunfs/root/image-processor.node")' },
    assets: {},
  });
  assert.deepStrictEqual(res.findings, []);
  assert.strictEqual(res.excludedByDecision, 1, 'the exclusion must be COUNTED, not just skipped');
  assert.doesNotThrow(() => assertGraphServesWhatItReferences(res));
});

test('an unserved row that nothing references is not a finding', () => {
  const res = unservedReferences({
    rows: [row('a.js', 1), row('orphan.md', 13)],
    sources: { [B + 'a.js']: 'import{x}from"/$bunfs/root/a.js"' },
    assets: {},
  });
  assert.deepStrictEqual(res.findings, []);
});

test('a referenced name with no row of its own is not a finding', () => {
  // The carve cannot serve what the container does not contain. Only rows we HAD and DROPPED
  // count — otherwise every path upstream computes at runtime would be a false refusal.
  const res = unservedReferences({
    rows: [row('a.js', 1)],
    sources: { [B + 'a.js']: 'readFileSync("/$bunfs/root/not-in-the-container.md")' },
    assets: {},
  });
  assert.deepStrictEqual(res.findings, []);
});

test('a served asset is not a finding, however it is referenced', () => {
  const res = unservedReferences({
    rows: [row('a.js', 1), row('SKILL-bb.md', 13), row('mermaid.min.js', 5)],
    sources: { [B + 'a.js']: 'f("/$bunfs/root/SKILL-bb.md");g("/$bunfs/root/mermaid.min.js")' },
    assets: { [B + 'SKILL-bb.md']: '# hi', [B + 'mermaid.min.js']: 'x' },
  });
  assert.deepStrictEqual(res.findings, []);
  assert.strictEqual(res.referencedAssets, 2);
});

// ---- the scanner may not report a pass it cannot back up ----------------------

test('ZERO references is a refusal, not a clean bill of health', () => {
  // This whole gate rests on one regex. A regex that matches nothing reports "all clear"
  // forever — the exact defect it exists to catch, wearing the gate's own uniform.
  const res = unservedReferences({ rows: [row('a.js', 1)], sources: { [B + 'a.js']: 'var x=1' }, assets: {} });
  assert.strictEqual(res.references, 0);
  assert.throws(() => assertGraphServesWhatItReferences(res), /scanner going blind|found no/);
});

test('serving assets that the scan never sees referenced is a refusal', () => {
  const res = unservedReferences({
    rows: [row('a.js', 1), row('SKILL-bb.md', 13)],
    sources: { [B + 'a.js']: 'import{x}from"/$bunfs/root/a.js"' },
    assets: { [B + 'SKILL-bb.md']: '# hi' },
  });
  assert.strictEqual(res.referencedAssets, 0);
  assert.throws(() => assertGraphServesWhatItReferences(res), /saw NONE of them referenced/);
});

// ---- layer 2: real providers -------------------------------------------------

// Resolve a provider the way the PRODUCT does first (clode-resolve.cjs — the same function
// `clode build` uses, so a box that can build can prove this), then the CI oracle env vars,
// then the global npm install, then the golden-sha fixture store. Skipping says WHERE we
// looked: a gate that checks somewhere the code does not is a coin flip, not a test.
function providers() {
  const found = [];
  const seen = new Set();
  const add = (p) => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); found.push(p); } };
  add(process.env.CLODE_PROVIDER_BIN);
  add(process.env.CLODE_CLAUDE_BIN);
  try { add(require('../libexec/clode-resolve.cjs').resolveClaudeBin()); } catch { /* none */ }
  try {
    add(execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8' }).trim());
  } catch { /* none on this box; the skip message says so */ }
  try {
    const { VERSIONS, providerBin } = require('./golden-shas-lib.cjs');
    for (const v of VERSIONS) add(providerBin(v));
  } catch { /* fixture lib unavailable */ }
  return found;
}

const PROVIDERS = providers();
// CODE-SPLIT ONLY. A pre-2.1.243 bundle is one giant CJS module that names nothing through the
// virtual fs, so it has no rows this gate can have an opinion about. Decided from the container
// (isSplitBundle), never from a version string.
const SPLIT = PROVIDERS.filter((p) => { try { return ex.isSplitBundle(p); } catch { return false; } });
const splitOpts = {
  skip: SPLIT.length ? false
    : `no CODE-SPLIT Claude provider found (looked at CLODE_PROVIDER_BIN, CLODE_CLAUDE_BIN, `
      + `clode-resolve, scripts/find-provider.mjs, the golden-shas store; found `
      + `${PROVIDERS.length ? PROVIDERS.join(', ') : 'nothing'})`,
};

// Both directions off ONE decode, and neither needs the asset CONTENTS — only their names — so
// this runs on a host with no zstd decoder. That is the point: the gate must be provable
// wherever the suite runs, not only where the compressed rows happen to inflate.
function realShape(bin) {
  const g = loadGraphFull(bin);
  const sources = Object.fromEntries(loadGraphFromBytes(new Uint8Array(fs.readFileSync(bin))));
  const assetNames = g.rows.filter((r) => r.loader === 13 || r.loader === 5).map((r) => r.name);
  return { g, sources, assetNames };
}

test('on every real code-split provider the scan is NOT VACUOUS', splitOpts, () => {
  // A silent gate means something only if it can still see. Measured on real darwin providers:
  // 1574 (2.1.246) to 1960 (2.1.251) distinct references, and every non-JS row referenced.
  for (const bin of SPLIT) {
    const { sources, assetNames } = realShape(bin);
    const refs = graphReferences(sources);
    assert.ok(refs.size >= 100,
      `${bin}: the reference scan found only ${refs.size} names; a code-split graph is wired `
      + 'together by thousands of them, so this is the scan going blind');
    assert.ok(assetNames.length === 0 || assetNames.some((n) => refs.has(n)),
      `${bin}: not one of ${assetNames.length} embedded asset rows was seen referenced`);
  }
});

test('a real provider carved with its assets DROPPED is refused, by loader and by name', splitOpts, () => {
  // The historical shape, on the real bytes: serve the JS and nothing else, exactly as clode
  // did before 2.1.246 and again before 2.1.251.
  let checked = 0;
  for (const bin of SPLIT) {
    const { g, sources, assetNames } = realShape(bin);
    if (!assetNames.length) continue;
    const res = unservedReferences({ rows: g.rows, sources, assets: {} });
    assert.ok(res.findings.length > 0,
      `${bin}: dropping all ${assetNames.length} asset rows produced NO finding`);
    for (const f of res.findings) {
      assert.ok(f.loader === 13 || f.loader === 5,
        `${bin}: unexpected finding on loader ${f.loader} (${f.name})`);
    }
    assert.throws(() => assertGraphServesWhatItReferences(res),
      (e) => /REFERENCED by the module graph but NOT SERVED/.test(e.message)
        && e.message.includes(res.findings[0].name),
      `${bin}: the refusal must name the rows`);
    checked++;
  }
  assert.ok(checked > 0,
    `none of ${SPLIT.join(', ')} has embedded asset rows — the refusal proved nothing on real bytes`);
});

test('a real provider carved as clode carves it today is SILENT', splitOpts, () => {
  for (const bin of SPLIT) {
    const { g, sources, assetNames } = realShape(bin);
    const assets = Object.fromEntries(assetNames.map((n) => [n, '']));
    const res = unservedReferences({ rows: g.rows, sources, assets });
    assert.deepStrictEqual(res.findings, [],
      `${bin}: the carve clode ships leaves referenced-but-unserved rows`);
    // Its napi rows ARE referenced and have never been served: they must be counted as
    // excluded-by-decision, not reported. Every CI leg builds from a minimised provider that
    // drops them, so a gate that refused here would be red everywhere.
    if (g.rows.some((r) => r.loader === 10)) {
      assert.ok(res.excludedByDecision > 0, `${bin}: napi rows were not counted as excluded`);
    }
    if (assetNames.length) assert.doesNotThrow(() => assertGraphServesWhatItReferences(res), bin);
  }
});
