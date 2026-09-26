'use strict';
// scripts/lib/reset-patch.cjs, unit by unit: the lowered-threshold patch that makes upstream's
// CellSegmenter wrapper reset its pools on every segment() call (CellSegmenter phase 5, reset
// invisibility; the live gate is test/fidelity/reset-invisibility.test.cjs).
//
// THE FIXTURE IS THE CARVE'S OWN TEXT. MF_2_1_278 is upstream 2.1.278's minified wrapper class,
// verbatim from the carved graph.json (module /$bunfs/root/chunk-rp2p2mxd.js, darwin-arm64,
// read 2026-09-25) from its threshold declarations through resetNative(), closed after it: the
// two reset conditions spelled exactly as the build patches them. It is also RUN, with stubs
// for the names it closes over, so the tests prove the patched wrapper really resets on every
// call, not only that its text changed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../scripts/lib/reset-patch.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const MF_2_1_278 = 'var Og=10,gC=255,bC=256,vC=2048,Cf=16384;class Mf{stylePool;charPool;native=vs(qot);'
  + 'cells=new Int32Array(512);runs=new Int32Array(512);count=0;reordered=!1;graphemes=this.native.graphemes;'
  + 'sgrKeys=this.native.sgrKeys;sgrCloseKeys=this.native.sgrCloseKeys;uris=this.native.uris;'
  + 'charMap=new Int32Array(256);charMapLength=0;styleIds=new Int32Array(64);styleGeneration;chalkGeneration=T5t();'
  + 'linkIds=new Int32Array(16);hyperlinkPool;words=new Int32Array(64);'
  + 'constructor(n,s){this.stylePool=n;this.charPool=s;this.styleGeneration=n.generation}'
  + 'segment(n,s){if(this.sgrKeys.length>Cf||this.uris.length>Cf||this.graphemes.length>4*Cf)this.resetNative();'
  + 'this.refreshGenerations();let u=this.native.segment(n,this.cells,this.runs,s);if(u<0){let f=Math.max(-u,'
  + 'this.cells.length);this.cells=new Int32Array(2*f),this.runs=new Int32Array(2*f),u=this.native.segment(n,'
  + 'this.cells,this.runs,s)}return this.count=u,this.reordered=s,u}'
  + 'refreshGenerations(){let n=T5t();if(this.stylePool.generation===this.styleGeneration&&n===this.chalkGeneration)'
  + 'return;if(this.styleGeneration=this.stylePool.generation,this.chalkGeneration=n,this.sgrKeys.length>vC)'
  + 'this.resetNative();else this.styleIds.fill(0)}'
  + 'resetNative(){this.native=vs(qot),this.graphemes=this.native.graphemes,this.sgrKeys=this.native.sgrKeys,'
  + 'this.sgrCloseKeys=this.native.sgrCloseKeys,this.uris=this.native.uris,this.charMapLength=0,'
  + 'this.linkIds.fill(0),this.styleIds=new Int32Array(64)}'
  + '}';
const SEGMENT_ENTRY = 'this.sgrKeys.length>Cf||this.uris.length>Cf||this.graphemes.length>4*Cf)this.resetNative()';
const GENERATION = 'this.sgrKeys.length>vC)this.resetNative()';

// Run a wrapper class text with stubs: vs() builds a stand-in segmenter whose pools start the
// way bun-shim.cjs's do (sgrKeys and uris hold one reserved entry) and whose segment() interns
// one grapheme. Returns the class and a count of vs() calls (every construction: the field
// initialiser's, then one per reset).
function load(src) {
  const state = { built: 0, chalk: 0 };
  const vs = () => {
    state.built++;
    const n = { graphemes: [], sgrKeys: [''], sgrCloseKeys: [''], uris: [''] };
    n.segment = (text) => { n.graphemes.push(text); return 1; };
    return n;
  };
  const Mf = new Function('vs', 'qot', 'T5t', `${src};return Mf;`)(vs, [], () => state.chalk);
  return { Mf, state };
}

test('the 2.1.278 carve holds each reset site exactly once, found by structure', () => {
  const s = R.findResetSites(MF_2_1_278);
  assert.deepStrictEqual(s, { counts: { segmentEntry: 1, generation: 1 }, segmentEntry: SEGMENT_ENTRY, generation: GENERATION });
});

test('the patch sets both thresholds to 0, and the result still compiles', () => {
  const p = R.patchResetThresholds(MF_2_1_278);
  assert.deepStrictEqual(p.original, [SEGMENT_ENTRY, GENERATION]);
  assert.deepStrictEqual(p.patched, [
    'this.sgrKeys.length>0||this.uris.length>0||this.graphemes.length>4*0)this.resetNative()',
    'this.sgrKeys.length>0)this.resetNative()',
  ]);
  assert.ok(!p.source.includes(SEGMENT_ENTRY) && !p.source.includes(GENERATION), 'no original condition is left');
  assert.strictEqual(p.source.length, MF_2_1_278.length - 4, 'three Cf and one vC became 0: nothing else changed');
  assert.doesNotThrow(() => new Function(`${p.source};return Mf;`));
  // The declarations stay: other code in the module may read Cf / vC.
  assert.ok(p.source.startsWith('var Og=10,gC=255,bC=256,vC=2048,Cf=16384;'));
  // A patched source is found as patched: the landed check reads it back this way.
  assert.deepStrictEqual(R.findResetSites(p.source), { counts: { segmentEntry: 1, generation: 1 },
    segmentEntry: p.patched[0], generation: p.patched[1] });
});

test('patched, the wrapper resets before EVERY segment() call, and again when the generations move', () => {
  for (const [how, src, perCall] of [['as carved', MF_2_1_278, 0], ['patched', R.patchResetThresholds(MF_2_1_278).source, 1]]) {
    const { Mf, state } = load(src);
    const pool = { generation: 0 };
    const m = new Mf(pool, {});
    assert.strictEqual(state.built, 1, `${how}: one segmenter from the field initialiser`);
    for (let i = 0; i < 10; i++) m.segment(`g${i}`, false);
    assert.strictEqual(state.built - 1, 10 * perCall, `${how}: resets over 10 calls`);
    pool.generation++;
    m.segment('g', false);
    // As carved, a generation change clears styleIds (sgrKeys is far under 2048); patched it resets.
    assert.strictEqual(state.built - 1, 11 * perCall + perCall, `${how}: resets after a generation change`);
  }
});

test('the match is by structure: other minified names still match, and a text past the patch is left alone', () => {
  const renamed = MF_2_1_278.replace(/\bCf\b/g, 'q$').replace(/\bvC\b/g, 'Z9');
  const p = R.patchResetThresholds(renamed);
  assert.deepStrictEqual(p.patched, [
    'this.sgrKeys.length>0||this.uris.length>0||this.graphemes.length>4*0)this.resetNative()',
    'this.sgrKeys.length>0)this.resetNative()',
  ]);
  // A threshold that is a prefix of another identifier in the site is not a threshold.
  const spaced = 'x.sgrKeys.length > A || x.uris.length > A || x.graphemes.length > 4 * A) x.resetNative();'
    + 'x.sgrKeys.length > AB) x.resetNative()';
  assert.deepStrictEqual(R.patchResetThresholds(spaced).patched, [
    'x.sgrKeys.length > 0 || x.uris.length > 0 || x.graphemes.length > 4 * 0) x.resetNative()',
    'x.sgrKeys.length > 0) x.resetNative()',
  ]);
});

test('a site that is missing or duplicated throws, naming it (an upstream rename is loud)', () => {
  const noUris = MF_2_1_278.replace('||this.uris.length>Cf', '');
  assert.deepStrictEqual(R.findResetSites(noUris).counts, { segmentEntry: 0, generation: 1 });
  assert.strictEqual(R.findResetSites(noUris).segmentEntry, null);
  assert.throws(() => R.patchResetThresholds(noUris), /segment-entry reset condition .* occurs 0 time\(s\), not exactly once/);
  const renamedMethod = MF_2_1_278.replace(/resetNative/g, 'rebuildNative');
  assert.throws(() => R.patchResetThresholds(renamedMethod),
    /segment-entry .* occurs 0 time\(s\).*; the refreshGenerations reset condition .* occurs 0 time\(s\)/);
  const twice = MF_2_1_278 + ';function k(t){if(t.sgrKeys.length>vC)t.resetNative()}';
  assert.throws(() => R.patchResetThresholds(twice), /refreshGenerations reset condition .* occurs 2 time\(s\), not exactly once/);
});

test('resetModule finds the one consumer module in a graph, and refuses any other shape loudly', () => {
  const doc = (sources, order = Object.keys(sources)) => ({ sources, order });
  const consumer = MF_2_1_278 + ';function vs(n){return new Bun.ant.CellSegmenter({substitute:n})}';
  assert.deepStrictEqual(R.resetModule(doc({ a: 'x', b: 'y' })), { consumer: false });
  // 2.1.251's shape: no module names CellSegmenter, whatever else it holds.
  assert.deepStrictEqual(R.resetModule(doc({ a: MF_2_1_278 })), { consumer: false });
  assert.deepStrictEqual(R.resetModule(doc({ a: 'x', m: consumer })), { consumer: true, module: 'm' });
  // A module outside the order is not compiled, so it is not searched.
  assert.deepStrictEqual(R.resetModule(doc({ a: 'x', m: consumer, stale: consumer }, ['a', 'm'])), { consumer: true, module: 'm' });
  assert.throws(() => R.resetModule(doc({ a: 'new Bun.ant.CellSegmenter({})' })),
    /consumes CellSegmenter, but the segment-entry .* occurs 0 time\(s\).*refreshGenerations .* occurs 0 time\(s\)/);
  assert.throws(() => R.resetModule(doc({ m: consumer, n: consumer })), /occurs 2 time\(s\) \(in m, n\)/);
  // The segment entry in one module, the generation condition in another.
  const head = MF_2_1_278.slice(0, MF_2_1_278.indexOf('refreshGenerations(){')) + ';Bun.ant.CellSegmenter';
  assert.throws(() => R.resetModule(doc({ m: head, n: 'function r(t){if(t.sgrKeys.length>vC)t.resetNative()}' })),
    /sit in different modules \(m, n\)/);
});

test('the tally counts constructions and fresh, retried and stale segment() calls, and writes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-tally-'));
  const saved = globalThis.Bun;
  try {
    // A stand-in segmenter: segment() returns the grow request (-2) once when asked to.
    class Seg { segment(text, cells) { return cells === 'grow' ? -2 : 1; } }
    globalThis.Bun = { ant: { CellSegmenter: Seg } };
    new Function('require', R.tallyPrelude(dir))(require);
    const Tallied = globalThis.Bun.ant.CellSegmenter;
    assert.notStrictEqual(Tallied, Seg);
    const a = new Tallied({});
    assert.ok(a instanceof Seg);
    assert.strictEqual(a.segment('x', 'grow'), -2, 'results pass through untouched');
    a.segment('x');       // a retry: right after the grow request
    a.segment('y');       // stale: this segmenter segmented before
    const b = new Tallied({});
    b.segment('z');       // fresh
    new Tallied({});      // constructed, never segmented
    await new Promise((r) => setTimeout(r, 100));
    const files = fs.readdirSync(dir);
    assert.deepStrictEqual(files, [`tally-${process.pid}.json`]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')),
      { constructed: 3, segments: 4, fresh: 2, retries: 1, stale: 1 });
  } finally {
    globalThis.Bun = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// THE PATCH IS TEST-ONLY: no product build may reach it. Every file under libexec/ and
// scripts/ (what `clode build` runs and blobulates) is read, and none but the module itself
// may require or import it.
const REPO = path.resolve(__dirname, '..');
const SELF = 'scripts/lib/reset-patch.cjs';
const REACHES = /\brequire\s*\(\s*['"][^'"]*reset-patch(?:\.cjs)?['"]|\bfrom\s+['"][^'"]*reset-patch(?:\.cjs)?['"]|\bimport\s*\(\s*['"][^'"]*reset-patch(?:\.cjs)?['"]/;

function productFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/\.(?:cjs|mjs|js)$/.test(e.name)) out.push({ rel: r, src: fs.readFileSync(path.join(REPO, r), 'utf8') });
    }
  };
  walk('libexec');
  walk('scripts');
  return out;
}

function scanReaches({ files }) {
  const findings = [];
  for (const f of files) {
    if (f.rel === SELF) continue;
    if (REACHES.test(f.src)) findings.push(`${f.rel} requires or imports ${SELF}, a TEST-ONLY patch: a product build must never reach it`);
  }
  return { findings, examined: files.length, note: `${files.length} file(s) under libexec/ and scripts/` };
}

guardTests(defineGuard({
  name: 'reset-patch-test-only',
  // libexec/ and scripts/ held 142 .cjs/.mjs/.js files on 2026-09-25; far fewer means the walk
  // lost a tree.
  floor: 100,
  read: () => ({ files: productFiles() }),
  scan: scanReaches,
  control: () => ({ files: [{ rel: 'libexec/clode-build.cjs', src: "const r = require('../scripts/lib/reset-patch.cjs');" }] }),
}));

test('the test-only scan sees require, static import and dynamic import, and not the module itself', () => {
  const run = (src, rel = 'libexec/x.cjs') => scanReaches({ files: [{ rel, src }] }).findings.length;
  assert.strictEqual(run("require('./lib/reset-patch')"), 1);
  assert.strictEqual(run("import { x } from '../scripts/lib/reset-patch.cjs';"), 1);
  assert.strictEqual(run("await import('../scripts/lib/reset-patch.cjs')"), 1);
  assert.strictEqual(run('// reset-patch.cjs is test-only'), 0, 'a mention in prose is not a require');
  assert.strictEqual(run("require('./reset-patch.cjs')", SELF), 0);
});
