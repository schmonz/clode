'use strict';
// THE BUNDLE'S CELLSEGMENTER POOL RESETS NEVER CHANGE A FRAME (CellSegmenter phase 5).
//
// WHAT RESETS. Upstream's TUI (2.1.278 on) keeps its Bun.ant.CellSegmenter behind a wrapper
// whose pools only grow, and throws the whole segmenter away for a new one when a pool passes
// a threshold stated in the bundle (16384 / 2048): a fresh segmenter from OUR constructor, the
// wrapper re-reading its pools and re-interning every grapheme. No real session gets near
// those thresholds, so that path runs in no other gate. scripts/lib/reset-patch.cjs states
// the sites and the patch.
//
// THE ORACLE IS A QUAUDE, NOT NATIVE. Native's thresholds live inside the Bun binary and
// cannot be lowered. So a TEST-ONLY quaude is built from a copy of the carve with both
// thresholds at 0 (the wrapper then resets before EVERY segment() call) and judged against the
// UNPATCHED quaude, which interactive-session-diff.test.cjs proves identical to native, over
// every session in sessions.cjs: the frame sequences must be identical cell for cell, by
// judgeSessions, the judgement every session gate shares.
//
// TWO GUARDS.
//   reset-patch-landed   the test build is what it claims: the copied graph.json holds the
//                        patched conditions and none of the originals, AND the two built
//                        quaudes differ in exactly what the patch changes -- of every module
//                        compiled into graph.qbc, only the patched one differs; the prelude
//                        differs by exactly the tally; every other member is byte-identical
//                        (the same bun-shim.cjs, unicode-text.cjs, node-shim); and the patched
//                        quaude's --clode-attest verifies, with a graph.qbc hash that is not
//                        the unpatched one's. Any failure reads BROKEN (a judgement of frames
//                        over a build that is not the patch alone proves nothing).
//   reset-invisibility   the frames are identical, AND the resets FIRED: the patched quaude's
//                        tally (reset-patch.cjs's tallyPrelude) shows segment() calls in every
//                        session and none of them on a segmenter that had segmented before. A
//                        patched condition that compiled but never ran would make "invisible"
//                        mean nothing.
//
// THE TEST BUILD. The provider's carve is staged into a scratch CLODE_CACHE of this run's own
// (seeded from built-binary.cjs's STABLE_CACHE when it holds the provider, then brought up to
// date by the build's own staging, libexec/clode-extract.cjs extractIfNeeded), patched there,
// and built with buildQuaude({ cache }). The shared caches are never written. The copy's
// graph-merged.json (quaude-blobulate.js MERGED_CACHE_FILE, merge-step.mjs's cache) is DELETED
// before the build: a merge cached from the unpatched graph would otherwise be reused, silently,
// over the patched one. (A carve merged at staging, as 2.1.251 and 2.1.278 are, never reads it;
// the landed guard's compiled-module comparison is the proof either way.)
//
// SKIP OR BROKEN. A carve with NO CellSegmenter consumer (no module in its graph names it:
// 2.1.251, CI's pin) has nothing to reset: both guards SKIP with the one named reason,
// reset-patch.cjs's NO_CONSUMER. A carve WITH one whose reset sites are not found exactly once
// was renamed or restructured upstream: both read BROKEN, never a skip, never a pass.
//
// MEASURED 2026-09-25 (darwin-arm64, native 2.1.278, fresh quaudes of this tree): identical,
// every frame settled on both sides, settle times indistinguishable from the unpatched build
// (so no limit of its own) -- type-edit 6 frames / 2035 cells, resize 6 / 2675, scroll 8 /
// 15341, slash-menu 7 / 2968; 1958 compiled modules compared, only the wrapper's differs.
// Resets fired, one run (the call counts follow how many renders a step takes, so they vary
// run to run; the frames do not): every segment() call on a freshly reset segmenter --
// type-edit 161 of 161, resize 237 of 237, scroll 588 of 589 (the other is the 320-column
// grow-and-retry), slash-menu 187 of 187. The unpatched build constructs ONE segmenter per
// session and runs every later call on it. The refreshGenerations branch is patched too, but
// no session moves the style or chalk generation, so it fired 0 times (it calls the same
// resetNative(); test/reset-patch.test.cjs runs it).
//
// PROVEN RED: a shim whose constructor carries the previous segmenter's grapheme index into
// the new one (stale pool state across a reset) differs in all four sessions at step "boot"
// (179 glyph cell-classes, the banner), while the same shim in an UNPATCHED build paints all
// four identically to the good one: no other session gate can see it.
//
// Gated by test/live-frame-gate.cjs as a SESSION gate (live render, not inside the concurrent
// full suite, the PTY harness, a provider, a native claude), then by a tjs engine, the carve,
// and a built quaude beside the native (quaudeBesideNative). No credentials, no tokens: the
// canned mock answers.
//
// THE PROVIDER IS CARVED, NEVER RUN. CI builds from a minimised provider
// (scripts/stage-provider.mjs), which is not an executable and answers --version with nothing;
// asking it (as this gate first did) skipped every CI run as "not the native's version", before
// and after the pin moves (measured 2026-09-26). So its version is judged by what is built from
// it: the unpatched quaude beside the native (quaudeBesideNative: a skip naming both versions)
// and the patched quaude beside the unpatched one (BROKEN).
const { before, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { liveFrameGate, quaudeBesideNative, quaudeVersion } = require('../live-frame-gate.cjs');
const { captureSessions } = require('../frame-oracle.cjs');
const { judgeSessions, syntheticSession, cloneFrame } = require('../frame-diff.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { buildQuaude, STABLE_CACHE } = require('../built-binary.cjs');
const { readTrailerIndex, readManifest } = require('../quaude-archive.cjs');
const { providerBin } = require('../provider-resolve.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');
const { apeCmd } = require('../e2e-pty.cjs');
const { SESSIONS } = require('./sessions.cjs');
const { nativeVersion } = require('../../scripts/lib/native-oracle.cjs');
const R = require('../../scripts/lib/reset-patch.cjs');
const { followWrapper, cacheKey } = require('../../libexec/clode-resolve.cjs');
const { extractIfNeeded } = require('../../libexec/clode-extract.cjs');
const { ATTEST_VERIFIED } = require('../../libexec/clode-attest.cjs');

const LIBEXEC = path.resolve(__dirname, '..', '..', 'libexec');
const { NO_CONSUMER } = R;
const FLOOR = 1000;          // reset-invisibility: the reference's painted cells, as every session gate
const MODULE_FLOOR = 1000;   // reset-patch-landed: compiled modules compared (2.1.278 compiles 1958)
const SIDES = [
  // The reference stands where native stands in the other session gates (the same blank-frame
  // and settle findings): interactive-session-diff proves it paints every session as native does.
  { who: 'unpatched quaude', native: true },
  { who: 'patched quaude' },
];
const DIFFERS = 'the patched quaude (a pool reset before every segment() call) painted the session '
  + 'differently from the unpatched quaude';
// Members the patch changes (graph.idx: the offsets after the patched module move), and the
// one member every build writes afresh (manifest.json: builtAt and the hashes of the others).
const PATCHED_MEMBERS = ['graph.qbc', 'graph.idx', 'graph-prelude.cjs'];
const BUILD_MEMBERS = ['manifest.json'];

let SKIP = null, BROKEN = null, LANDED = null, CAPS = null, WHAT = '';
before(async () => {
  const gate = liveFrameGate({ session: true });
  if (gate.skip) { SKIP = gate.skip; return; }
  if (!tjsPath()) { SKIP = 'no tjs engine (set CLODE_TJS) to build the patched quaude with'; return; }
  // Carved, never run: see THE PROVIDER IS CARVED, NEVER RUN in the header.
  const provider = followWrapper(providerBin(process.env));
  const nv = nativeVersion(gate.native);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-invisibility-'));
  process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  let staged, doc, where;
  try {
    staged = stageCarve(provider, path.join(root, 'cache'));
    const graphPath = path.join(staged.dir, 'graph.json');
    if (!fs.existsSync(graphPath)) {
      const cli = fs.readFileSync(path.join(staged.dir, 'cli.cjs'), 'utf8');
      if (!R.hasCellSegmenterConsumer(cli)) { SKIP = `${NO_CONSUMER} (the carve of ${provider})`; return; }
      BROKEN = `${provider} carves to one cli.cjs that names CellSegmenter; the reset patch knows only a staged graph`;
      return;
    }
    doc = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    where = R.resetModule(doc);
  } catch (e) { BROKEN = `the carve of ${provider}: ${e.message}`; return; }
  if (!where.consumer) { SKIP = `${NO_CONSUMER} (the carve of ${provider})`; return; }

  const q = quaudeBesideNative(gate.native);
  if (q.skip) { SKIP = q.skip; return; }

  // The patch and the tally, into the copy; then the merged cache out of it (see the header).
  const tallyDir = path.join(root, 'tally');
  fs.mkdirSync(tallyDir);
  const patch = R.patchResetThresholds(doc.sources[where.module]);
  doc.sources[where.module] = patch.source;
  const unpatchedPrelude = doc.prelude;
  doc.prelude += R.tallyPrelude(tallyDir);
  fs.writeFileSync(path.join(staged.dir, 'graph.json'), JSON.stringify(doc));
  doc = null;
  fs.rmSync(path.join(staged.dir, 'graph-merged.json'), { force: true });

  const built = buildQuaude({ cache: staged.cache });
  if (built.skip) { BROKEN = `the patched quaude did not build: ${built.skip}`; return; }
  const bv = quaudeVersion(built.path);
  if (bv !== q.version) { BROKEN = `the patched quaude says ${JSON.stringify(bv)}, the unpatched ${JSON.stringify(q.version)}`; return; }
  WHAT = `native ${gate.native} (${nv}); unpatched ${q.quaude} vs patched ${built.path} (${where.module} reset thresholds at ${R.RESET_THRESHOLD})`;

  // What the build read, as it left it on disk; and what the two builds hold.
  LANDED = {
    module: where.module, patch,
    graph: JSON.parse(fs.readFileSync(path.join(staged.dir, 'graph.json'), 'utf8')),
    tally: R.tallyPrelude(tallyDir), unpatchedPrelude,
    unpatched: archiveOf(q.quaude), patched: archiveOf(built.path),
    attest: { unpatched: attestOf(q.quaude), patched: attestOf(built.path) },
    what: WHAT,
  };

  CAPS = {};
  for (const name of Object.keys(SESSIONS)) {
    for (const f of fs.readdirSync(tallyDir)) fs.rmSync(path.join(tallyDir, f));
    const cap = await captureSessions({ ...SESSIONS[name], ref: q.quaude, sub: built.path });
    CAPS[name] = { ...cap, mustShow: SESSIONS[name].mustShow, tally: readTallies(tallyDir) };
  }
});

// The provider's carve, staged in `cache` (see the header). -> { cache, dir }
function stageCarve(provider, cache) {
  const key = cacheKey(provider);
  const dir = path.join(cache, key);
  const warm = path.join(STABLE_CACHE, key);
  if (fs.existsSync(path.join(warm, '.extractor-sig'))) fs.cpSync(warm, dir, { recursive: true });
  extractIfNeeded({ bin: provider, cacheDir: dir, libexec: LIBEXEC, key });
  return { cache, dir };
}

// A built quaude's members and its compiled graph, module by module (graph.idx names each
// module's slice of graph.qbc).
function archiveOf(file) {
  const { names, member } = readTrailerIndex(file);
  const members = new Map(names.map((n) => [n, member(n).data]));
  const idx = members.has('graph.idx') ? JSON.parse(members.get('graph.idx').toString('utf8')) : { modules: [] };
  const qbc = members.get('graph.qbc') || Buffer.alloc(0);
  return { members, modules: idx.modules.map((m) => ({ name: m.name, bytes: qbc.subarray(m.off, m.off + m.len) })) };
}

// --clode-attest's verdict, and the graph.qbc hash its manifest records.
function attestOf(file) {
  const w = apeCmd([file, '--clode-attest']);
  const r = spawnSync(w[0], w.slice(1), { encoding: 'utf8', timeout: 120000 });
  const m = readManifest(file).members['graph.qbc'];
  return { verified: r.status === 0 && String(r.stdout).includes(ATTEST_VERIFIED), graphSha: m ? m.sha256 : null };
}

// Every tally-<pid>.json the patched quaude wrote, summed; null when it wrote none.
function readTallies(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^tally-\d+\.json$/.test(f));
  if (!files.length) return null;
  const t = { processes: files.length, constructed: 0, segments: 0, fresh: 0, retries: 0, stale: 0 };
  for (const f of files) {
    const one = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const k of ['constructed', 'segments', 'fresh', 'retries', 'stale']) t[k] += one[k];
  }
  return t;
}

// ---- reset-patch-landed --------------------------------------------------------------

// Pure. Any finding makes `examined` 0: the verdict is BROKEN, with the findings in the note.
function scanLanded(i) {
  if (i.broken) return { examined: 0, findings: [i.broken], note: `${i.broken}` };
  const findings = [];
  const src = i.graph.sources[i.module];
  const sites = typeof src === 'string' ? R.findResetSites(src) : { segmentEntry: null, generation: null };
  if (sites.segmentEntry !== i.patch.patched[0] || sites.generation !== i.patch.patched[1]) {
    findings.push(`the copied graph.json's ${i.module} does not hold the patched reset conditions `
      + `(segment entry ${JSON.stringify(sites.segmentEntry)}, generation ${JSON.stringify(sites.generation)})`);
  }
  for (const o of i.patch.original) {
    const at = i.graph.order.filter((n) => typeof i.graph.sources[n] === 'string' && i.graph.sources[n].includes(o));
    if (at.length) findings.push(`the copied graph.json still holds the original ${JSON.stringify(o)} (${at.join(', ')})`);
  }
  const a = i.unpatched, b = i.patched;
  const names = (x) => x.modules.map((m) => m.name).join('\n');
  if (names(a) !== names(b)) {
    findings.push(`the two quaudes compiled different module lists (${a.modules.length} vs ${b.modules.length})`);
  } else {
    const differ = a.modules.filter((m, k) => !m.bytes.equals(b.modules[k].bytes)).map((m) => m.name);
    if (!differ.includes(i.module)) {
      findings.push(`the patched quaude's compiled ${i.module} is byte-identical to the unpatched one's: the build did not compile the patched source`);
    }
    const others = differ.filter((n) => n !== i.module);
    if (others.length) findings.push(`compiled module(s) other than the patched one differ: ${others.slice(0, 5).join(', ')}${others.length > 5 ? ` (+${others.length - 5})` : ''}`);
  }
  const pa = a.members.get('graph-prelude.cjs'), pb = b.members.get('graph-prelude.cjs');
  if (!pa || !pb || pa.toString('utf8') !== i.unpatchedPrelude || pb.toString('utf8') !== i.unpatchedPrelude + i.tally) {
    findings.push('the patched quaude\'s prelude is not the unpatched prelude plus the reset tally');
  }
  const skipped = new Set([...PATCHED_MEMBERS, ...BUILD_MEMBERS]);
  const all = new Set([...a.members.keys(), ...b.members.keys()]);
  const unequal = [...all].filter((n) => !skipped.has(n) && !(a.members.has(n) && b.members.has(n) && a.members.get(n).equals(b.members.get(n))));
  if (unequal.length) {
    findings.push(`the two quaudes differ in ${unequal.slice(0, 5).join(', ')}${unequal.length > 5 ? ` (+${unequal.length - 5})` : ''}: `
      + 'they are not two builds of one tree and one provider, so their frames do not isolate the resets');
  }
  if (!i.attest.patched.verified) findings.push('the patched quaude\'s --clode-attest did not verify');
  if (!i.attest.patched.graphSha || i.attest.patched.graphSha === i.attest.unpatched.graphSha) {
    findings.push(`the patched quaude's attested graph.qbc hash (${i.attest.patched.graphSha}) is the unpatched one's`);
  }
  if (findings.length) return { examined: 0, findings, note: `${i.what}; ${findings.join('; ')}` };
  return { examined: a.modules.length, findings,
    note: `${i.what}; ${a.modules.length} compiled modules compared, only ${i.module} differs` };
}

// A synthetic pair of builds for the control and the unit tests: two modules and the members
// the scan reads, patched as a build would patch them; each option set false (or `shim`
// changed) breaks one thing the scan must notice.
const SYNTHETIC_SITES = 'if(a.sgrKeys.length>C||a.uris.length>C||a.graphemes.length>4*C)a.resetNative();'
  + 'if(a.sgrKeys.length>V)a.resetNative()';
function syntheticLanded({ compiled = true, prelude = true, shim = 'S' } = {}) {
  const module = '/$bunfs/root/m.js';
  const patch = R.patchResetThresholds(SYNTHETIC_SITES);
  const tally = '/* tally */';
  const build = (mBytes, pre, s, sha) => ({
    modules: [{ name: '/$bunfs/root/a.js', bytes: Buffer.from('A') }, { name: module, bytes: Buffer.from(mBytes) }],
    members: new Map([['graph.qbc', Buffer.from('A' + mBytes)], ['graph.idx', Buffer.from('i')],
      ['graph-prelude.cjs', Buffer.from(pre)], ['bun-shim.cjs', Buffer.from(s)], ['manifest.json', Buffer.from(sha)]]),
  });
  return {
    module, patch, tally, unpatchedPrelude: 'P',
    graph: { order: ['/$bunfs/root/a.js', module], sources: { '/$bunfs/root/a.js': 'a', [module]: patch.source } },
    unpatched: build('M', 'P', 'S', '1'),
    patched: build(compiled ? 'N' : 'M', prelude ? 'P' + tally : 'P', shim, '2'),
    attest: { unpatched: { verified: true, graphSha: '1' }, patched: { verified: true, graphSha: '2' } },
    what: 'synthetic',
  };
}

guardTests(defineGuard({
  name: 'reset-patch-landed',
  floor: MODULE_FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    if (BROKEN) return { broken: BROKEN };
    return LANDED;
  },
  scan: scanLanded,
  // The patch never reached the compiled graph: the build compiled the unpatched source.
  control: () => syntheticLanded({ compiled: false }),
}));

test('reset-patch-landed: each way the test build can fail to be the patch alone is a finding', () => {
  const ok = { ...syntheticLanded() };
  const clean = scanLanded(ok);
  assert.deepStrictEqual(clean.findings, []);
  assert.strictEqual(clean.examined, 2);
  const one = (x) => { const r = scanLanded(x); assert.strictEqual(r.examined, 0, 'a finding reads BROKEN'); return r.findings; };
  assert.match(one(syntheticLanded({ compiled: false }))[0], /compiled \/\$bunfs\/root\/m\.js is byte-identical .* did not compile the patched source/);
  assert.match(one(syntheticLanded({ prelude: false }))[0], /prelude is not the unpatched prelude plus the reset tally/);
  assert.match(one(syntheticLanded({ shim: 'T' }))[0], /differ in bun-shim\.cjs: they are not two builds of one tree/);
  // A build that re-staged over the copy: the original conditions are back in graph.json.
  const reverted = syntheticLanded();
  reverted.graph.sources[reverted.module] = SYNTHETIC_SITES;
  const f = one(reverted);
  assert.strictEqual(f.length, 3);
  assert.match(f[0], /copied graph\.json's \/\$bunfs\/root\/m\.js does not hold the patched reset conditions \(segment entry "a\.sgrKeys\.length>C\|\|/);
  assert.match(f[1], /still holds the original "a\.sgrKeys\.length>C\|\|.*" \(\/\$bunfs\/root\/m\.js\)/);
  assert.match(f[2], /still holds the original "a\.sgrKeys\.length>V\)a\.resetNative\(\)" \(\/\$bunfs\/root\/m\.js\)/);
  const sameSha = syntheticLanded();
  sameSha.attest.patched = { verified: false, graphSha: '1' };
  assert.deepStrictEqual(one(sameSha).map((f) => f.slice(0, 40)), [
    'the patched quaude\'s --clode-attest did ',
    'the patched quaude\'s attested graph.qbc ',
  ]);
  const extra = syntheticLanded();
  extra.patched.modules[0] = { ...extra.patched.modules[0], bytes: Buffer.from('B') };
  assert.match(one(extra)[0], /compiled module\(s\) other than the patched one differ: \/\$bunfs\/root\/a\.js/);
  assert.deepStrictEqual(scanLanded({ broken: 'the carve of x: occurs 0 time(s)' }),
    { examined: 0, findings: ['the carve of x: occurs 0 time(s)'], note: 'the carve of x: occurs 0 time(s)' });
});

// ---- reset-invisibility ----------------------------------------------------------------

// How a session's tally shows the resets did not fire on every call, or at all.
function tallyFindings(name, t) {
  if (!t) return [`${name}: the patched quaude wrote no reset tally, so nothing shows its resets fired`];
  if (t.segments === 0) return [`${name}: the patched quaude made no segment() call, so no reset could fire and the session judged nothing about resets`];
  if (t.stale > 0) {
    return [`${name}: ${t.stale} of ${t.segments} segment() call(s) ran on a segmenter that had segmented before -- `
      + 'the lowered thresholds did not reset before every call'];
  }
  return [];
}

// Pure: every session, unpatched against patched, by judgeSessions; then each tally.
function scanInvisible(i) {
  if (i.broken) return { examined: 0, findings: [i.broken], note: `${i.broken}` };
  const findings = [];
  const fired = [];
  let examined = 0;
  for (const [name, s] of Object.entries(i.sessions)) {
    const j = judgeSessions({ session: name, a: s.ref, b: s.sub, sides: SIDES, mustShow: s.mustShow, differs: DIFFERS });
    examined += j.examined;
    findings.push(...j.findings, ...tallyFindings(name, s.tally));
    const frames = s.ref ? `${s.ref.frames.length} frames ${j.examined} cells` : 'no capture';
    fired.push(`${name} ${frames}, ` + (s.tally ? `${s.tally.fresh} of ${s.tally.segments} segment() calls on a freshly `
      + `reset segmenter (${s.tally.constructed} built, ${s.tally.retries} retries, ${s.tally.stale} stale)` : 'no tally'));
  }
  return { examined, findings, note: `${i.what}; ${fired.join('; ')}` };
}

const TALLY_OK = { processes: 1, constructed: 5, segments: 4, fresh: 4, retries: 0, stale: 0 };

// The control: a stale cell in frame N+1 only, with resets that fired.
function plantedControl() {
  const ref = syntheticSession(4);
  const sub = cloneFrame(ref);
  sub.frames[2].frame.cells[1][5] = { ...sub.frames[2].frame.cells[1][5], c: 'Z' };
  return { sessions: { control: { ref, sub, mustShow: null, tally: TALLY_OK } }, what: 'synthetic control' };
}

guardTests(defineGuard({
  name: 'reset-invisibility',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    if (BROKEN) return { broken: BROKEN };
    return { sessions: CAPS, what: WHAT };
  },
  scan: scanInvisible,
  control: plantedControl,
}));

test('reset-invisibility: the control\'s finding names the session, the step and the cell', () => {
  const r = scanInvisible(plantedControl());
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /^control: the patched quaude \(a pool reset before every segment\(\) call\) painted the session differently from the unpatched quaude: first difference at step "step 2" \(frame 2 of 0-3\)/);
  assert.match(r.findings[0], /\[glyph\] col 5: A="F" .* \| B="Z"/);
});

test('reset-invisibility: resets that never fired, or not on every call, are findings even when the frames agree', () => {
  const s = (tally) => ({ ref: syntheticSession(4), sub: syntheticSession(4), mustShow: null, tally });
  const r = scanInvisible({ what: 'x', sessions: {
    none: s(null),
    idle: s({ ...TALLY_OK, segments: 0, fresh: 0 }),
    some: s({ ...TALLY_OK, segments: 10, fresh: 3, stale: 7 }),
    fine: s(TALLY_OK),
  } });
  assert.deepStrictEqual(r.findings, [
    'none: the patched quaude wrote no reset tally, so nothing shows its resets fired',
    'idle: the patched quaude made no segment() call, so no reset could fire and the session judged nothing about resets',
    'some: 7 of 10 segment() call(s) ran on a segmenter that had segmented before -- the lowered thresholds did not reset before every call',
  ]);
  assert.strictEqual(r.examined, 4 * 4 * 300);
  assert.match(r.note, /; fine 4 frames 1200 cells, 4 of 4 segment\(\) calls on a freshly reset segmenter \(5 built, 0 retries, 0 stale\)$/);
});

test('both reset guards read BROKEN, naming why, when the carve has a consumer but no patchable sites', () => {
  for (const scan of [scanLanded, scanInvisible]) {
    assert.deepStrictEqual(scan({ broken: 'the carve of p: reset-patch: ... occurs 0 time(s)' }).examined, 0);
  }
  // The skip reason is the one the CI step and the design name, verbatim.
  assert.strictEqual(NO_CONSUMER, 'the pinned bundle has no CellSegmenter consumer to reset');
});
