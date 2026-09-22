'use strict';
// The build gates inside `scripts/carve-probe.mjs`: the daily "can clode carve newer
// upstream than the pin yet?" instrument, and the refusals it is made of.
//
// WHY THIS FILE EXISTS. The probe's whole product is a report of CHANGE — it compares what
// it just measured against the outcome UPSTREAM_PIN records and refuses (exit 1) when they
// differ. That is "derives a verdict, then refuses" exactly, so the production-gate sweep
// counted it the moment it landed and was right to; an exclusion entry would have been
// false. This is the control.
//
// WHAT HAS TO BE PROVEN, and why the obvious test is not it. The interesting failure mode
// of a change-detector is a comparator that can only move ONE way. A suite that exercises
// the happy path ("it carves, the record says carves, green") passes on a comparator with
// `return { ok: true }` written into three of its five branches — and the branch that would
// then never fire is precisely the one BACKLOG.md asked for: "red if it started working
// (absorb now)". So the direction table below IS the guard, and its control is a
// one-way comparator: a stand-in that always answers `ok`, which MUST be reported.
//
// AND A COMPARATOR THAT CANNOT SEE ITS OWN SUBJECT (review FINDING 5). `compare()` originally
// read only `outcome` — never `modules`, never `merge` — so a run that carved THREE modules,
// or one in which the SCC merge never ran at all, reported "carves, as recorded". The last of
// those is not a silly hypothetical: one upstream re-chunk that removes the final cyclic
// require gets it, and the probe would then go green for the rest of its life while watching
// nothing. Three rows of the direction table and the floor tests below are that distinction.
//
// The network half — install `next`, carve 200MB, merge, compile ~1950 modules — is CI's
// job (upstream-drift.yml's `carve` job). Everything here runs offline, except the two
// compile-stage cases, which need only the engine the suite already resolved.
//
// The literal relative require below is load-bearing for the production-gate population
// sweep (test/guards-population.cjs), which derives "which guard controls this production
// gate" by reading that exact string out of this file's own source. require() of an ES
// module is how a CommonJS guard reaches an ESM script; it is synchronous because the probe
// has no top-level await, which is also what defineGuard's synchronous read()/control()
// need.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const { STAGES, CARVES, BLOCKED, MODULE_FLOOR, MEASURED, SKIPPED, CHANGED, parsePinFile, compare,
  floorShortfalls, announce, measure, compileStagedGraph } = require('../../scripts/carve-probe.mjs');

const REPO = path.resolve(__dirname, '..', '..');
const PIN = path.join(REPO, 'UPSTREAM_PIN');

// ---- gate 1: the recorded expectation is one the probe can still read -----------------
//
// The comparison has two halves: what the run measured (fresh every day) and what
// UPSTREAM_PIN records. The second half is a line a human edits, in a file that is
// otherwise prose, and the probe's parser ignores anything it cannot read — which would
// leave the daily job printing "NO RECORDED EXPECTATION" as its whole output: a red that
// says the instrument is broken rather than anything about upstream. Catching that here
// costs nothing and does not wait for 05:23 UTC.
//
// `examined` counts carve-probe RECORDS, so a file that has lost the line entirely reads
// BROKEN under floor 1 rather than "no findings". "Examined nothing" and "found nothing"
// are opposite results, and this is exactly the case where they diverge: no record at all
// is the worst state, not the cleanest.
//
// scan() takes the stage vocabulary as DATA so the stage names are never restated here —
// they come from the probe's own export, which is also what its parser uses. A stage
// renamed in one place and not the other is then a finding, not a silent pass.
function scanExpectation({ pinText, stages }) {
  const findings = [];
  const records = String(pinText).split('\n')
    .map((l) => l.trim()).filter((l) => l.startsWith('carve-probe '));
  const parsed = parsePinFile(pinText);
  for (const line of parsed.malformed) {
    findings.push(`UPSTREAM_PIN: unreadable carve-probe record — ${line}`);
  }
  if (records.length > 1) {
    findings.push(`UPSTREAM_PIN: ${records.length} carve-probe records; the probe reads the `
      + 'last one, so the others are dead prose a human reader would still believe');
  }
  const e = parsed.expectation;
  if (e && e.outcome !== CARVES) {
    if (!stages.includes(e.stage)) {
      findings.push(`UPSTREAM_PIN: carve-probe record names stage '${e.stage}', which the `
        + `probe cannot produce (${stages.join(', ')})`);
    }
    if (!e.reason) {
      findings.push('UPSTREAM_PIN: a blocked carve-probe record with no reason matches every '
        + 'failure, so it can never report "blocked differently"');
    }
  }
  if (e && !/^\d+(\.\d+)+$/.test(e.version)) {
    findings.push(`UPSTREAM_PIN: carve-probe record names '${e.version}', which is not a `
      + 'version — a reader cannot tell when this was measured');
  }
  return { findings, examined: records.length };
}

guardTests(defineGuard({
  name: 'carve-probe-recorded-expectation',
  floor: 1,
  read: () => ({ pinText: fs.readFileSync(PIN, 'utf8'), stages: STAGES }),
  scan: scanExpectation,
  // A record naming a stage the probe can never emit. The probe's own parser files it
  // under `malformed`, which is the point: a record the instrument cannot act on has to be
  // visible before the daily job runs, not as tomorrow's confusing red.
  control: () => ({
    pinText: 'claude-code 2.1.251\ncarve-probe 2.1.999 blocked linkage something went wrong\n',
    stages: STAGES,
  }),
}));

// ---- gate 2: the verdict moves in BOTH directions -------------------------------------

const CARVED = { outcome: CARVES, modules: 1958, merge: { groups: [8, 4, 61, 4] } };
const BLOCKED_MERGE = { outcome: BLOCKED, stage: 'stage',
  message: 'scc-merge: group 1 renamed __m28_get into a contextual-keyword position — `…`' };
const BLOCKED_COMPILE = { outcome: BLOCKED, stage: 'compile',
  message: 'graph-meta: compiling /$bunfs/root/__clode-scc-1.js failed: invalid property name' };
const RECORD_CARVES = { version: '2.1.278', outcome: CARVES, stage: null, reason: null };
const RECORD_BLOCKED = { version: '2.1.257', outcome: BLOCKED, stage: 'compile',
  reason: 'invalid property name' };
// THE THREE WAYS A RUN CAN REPORT "carves" WITHOUT HAVING MEASURED ANYTHING (review FINDING
// 5). The first is the one that matters and it is not hypothetical: if upstream removes its
// last cyclic require, `doc.sccMerge` is never set, the SCC merge NEVER RUNS, and a probe
// whose entire job is to watch the merger reports "carves, as recorded" — green while
// watching nothing. `merge` was write-only data before this; now it is evidence.
const CARVED_NO_MERGE = { outcome: CARVES, modules: 1958, merge: null };
const CARVED_TINY = { outcome: CARVES, modules: 3, merge: { groups: [2] } };
const CARVED_NO_GROUPS = { outcome: CARVES, modules: 1958, merge: { groups: [] } };

// Every direction the comparator can be asked to move, with the answer it OWES. Two of
// these are greens and the rest are reds; a comparator that has lost either polarity — or
// its floor — fails here by name rather than by being quietly agreeable.
const DIRECTIONS = [
  { name: 'recorded carves, and it carves', expectation: RECORD_CARVES, measured: CARVED, red: false },
  { name: 'recorded blocked, and it CARVES — absorb now', expectation: RECORD_BLOCKED, measured: CARVED, red: true },
  { name: 'recorded carves, and it is BLOCKED — a fresh blocker', expectation: RECORD_CARVES, measured: BLOCKED_MERGE, red: true },
  { name: 'blocked at a different STAGE than recorded', expectation: RECORD_BLOCKED, measured: BLOCKED_MERGE, red: true },
  { name: 'blocked at the recorded stage for a different REASON', expectation: RECORD_BLOCKED,
    measured: { outcome: BLOCKED, stage: 'compile', message: 'graph-meta: compiling x failed: unexpected token' }, red: true },
  { name: 'blocked at the recorded stage for the recorded reason', expectation: RECORD_BLOCKED, measured: BLOCKED_COMPILE, red: false },
  { name: 'no record at all', expectation: null, measured: CARVED, red: true },
  { name: 'carves, but the SCC merge never ran', expectation: RECORD_CARVES, measured: CARVED_NO_MERGE, red: true },
  { name: 'carves, but almost nothing was staged', expectation: RECORD_CARVES, measured: CARVED_TINY, red: true },
  { name: 'carves, but ZERO groups were merged', expectation: RECORD_CARVES, measured: CARVED_NO_GROUPS, red: true },
];

function scanDirections({ cmp, directions }) {
  const findings = [];
  for (const d of directions) {
    const v = cmp(d.expectation, d.measured);
    if (v.ok === d.red) {
      findings.push(`${d.name}: comparator answered ${v.ok ? 'OK' : 'CHANGED'} where `
        + `${d.red ? 'CHANGED' : 'OK'} is owed — ${v.headline}`);
    }
  }
  return { findings, examined: directions.length };
}

guardTests(defineGuard({
  name: 'carve-probe-verdict-directions',
  // Every direction must be exercised: a table that lost entries is BROKEN, not clean.
  floor: DIRECTIONS.length,
  read: () => ({ cmp: compare, directions: DIRECTIONS }),
  scan: scanDirections,
  // THE ONE-WAY PROBE, modelled exactly: a comparator that always answers "ok". This is
  // what "a probe that cannot go red both ways is not the probe that was asked for" looks
  // like as an input, and the guard must report every red direction it swallowed.
  control: () => ({ cmp: () => ({ ok: true, headline: 'always fine', detail: '' }),
    directions: DIRECTIONS }),
}));


// ---- the floor: "carves" must be a statement about a measurement ------------------------

test('carve-probe: the floor names each way a run can have measured nothing', () => {
  // The rows above prove the COMPARATOR refuses them. This proves the floor itself says WHY,
  // which is what a reader of the daily log gets instead of a bare red.
  assert.deepStrictEqual(floorShortfalls({ outcome: CARVES, modules: 1958,
    merge: { groups: [8, 4, 61, 4] } }), [], 'a real carve clears the floor');
  const noMerge = floorShortfalls({ outcome: CARVES, modules: 1958, merge: null });
  assert.strictEqual(noMerge.length, 1);
  assert.match(noMerge[0], /never ran/,
    'the case that matters must say the SCC merge did not run, not merely "too little"');
  assert.strictEqual(floorShortfalls({ outcome: CARVES, modules: 3, merge: { groups: [2] } }).length, 1);
  assert.strictEqual(floorShortfalls({ outcome: CARVES, modules: 1958, merge: { groups: [] } }).length, 1);
  // Both halves at once, and neither swallows the other.
  assert.strictEqual(floorShortfalls({ outcome: CARVES, modules: 0, merge: null }).length, 2);
  // AND THE FLOOR COMES FIRST, before either polarity. A run under the floor is red on both
  // paths, so the DIRECTIONS table cannot tell them apart — but WHICH red matters enormously:
  // "ABSORB NOW" on the strength of a merge that never ran is the exact mistake this probe
  // exists to prevent, so the headline is asserted here rather than left to the `ok` bit.
  assert.match(compare(RECORD_BLOCKED, CARVED_NO_MERGE).headline, /MEASURED TOO LITTLE/,
    'a run with no merge evidence must never read as "it started working — absorb now"');
  assert.match(compare(RECORD_CARVES, CARVED_NO_MERGE).headline, /MEASURED TOO LITTLE/);
});

test('carve-probe: the floor sits BELOW every module count ever measured', () => {
  // 1839 / 1839 / 1680 / 1958 across .251/.252/.257/.278. An equality floor would be a daily
  // red that means nothing; a floor above the smallest real carve would be a daily red that
  // means the instrument is wrong. This is the one assertion that keeps it honest as upstream
  // re-chunks, and it names the measurements it is derived from.
  for (const measuredCount of [1839, 1680, 1958]) {
    assert.ok(MODULE_FLOOR < measuredCount,
      `MODULE_FLOOR ${MODULE_FLOOR} must sit below the real carve of ${measuredCount} modules`);
  }
  assert.ok(MODULE_FLOOR > 100, 'and far enough above zero to mean "a real bundle was staged"');
});

// ---- a run that measured NOTHING must not look like a run that measured success ---------

test('carve-probe: every exit path announces WHICH of the three it was', () => {
  // A skip exits 0 on purpose (a persistently broken network must not be a permanent red).
  // But exit 0 is also what success returns, so at the layer that notifies they are the same
  // colour unless the run says otherwise. Outside CI: the machine-readable line, nothing else.
  const lines = [];
  const write = (s) => lines.push(s);
  const priorCI = process.env.GITHUB_ACTIONS;
  const priorSummary = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    assert.strictEqual(announce(SKIPPED, 'no engine', write), SKIPPED);
    assert.deepStrictEqual(lines, ['carve-probe: outcome=skipped\n'],
      'outside CI, exactly the one machine-readable line and no annotations');
    // In CI, the three outcomes must be three DIFFERENT annotation severities — the whole
    // point is that the notification layer can tell them apart without reading prose.
    process.env.GITHUB_ACTIONS = 'true';
    const seen = {};
    for (const outcome of [SKIPPED, MEASURED, CHANGED]) {
      const buf = [];
      announce(outcome, 'a headline\nwith a newline in it', (s) => buf.push(s));
      const ann = buf.find((l) => l.startsWith('::'));
      assert.ok(ann, `${outcome} must emit an annotation under GITHUB_ACTIONS`);
      assert.doesNotMatch(ann.slice(0, -1), /\n/, 'an annotation is one line or it is dropped');
      seen[outcome] = ann.slice(0, ann.indexOf(' '));
    }
    assert.strictEqual(seen[SKIPPED], '::warning',
      'a run that measured NOTHING is a warning, not a notice — that is the whole finding');
    assert.strictEqual(seen[MEASURED], '::notice');
    assert.strictEqual(seen[CHANGED], '::error');
    assert.strictEqual(new Set(Object.values(seen)).size, 3,
      'three outcomes, three distinguishable severities');
  } finally {
    if (priorCI === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = priorCI;
    if (priorSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = priorSummary;
  }
});

test('carve-probe: a SKIPPED run says so in the step summary a notification carries', () => {
  const summary = path.join(os.tmpdir(), `carve-probe-summary-${process.pid}`);
  const priorCI = process.env.GITHUB_ACTIONS;
  const priorSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    fs.writeFileSync(summary, '');
    announce(SKIPPED, 'no tjs engine', () => {});
    assert.match(fs.readFileSync(summary, 'utf8'), /carve-probe: skipped.*no tjs engine/);
  } finally {
    try { fs.rmSync(summary, { force: true }); } catch { /* best effort */ }
    if (priorCI === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = priorCI;
    if (priorSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = priorSummary;
  }
});

// ---- the substring rule, which is deliberate and must not be "tightened" --------------

test('carve-probe: a recorded reason matches as a SUBSTRING of the real message', () => {
  // The merge refusal embeds a 60-byte excerpt of minified upstream, so an EQUALITY
  // comparison would report "blocked differently" on every upstream release that shifts one
  // identifier — a daily red that means nothing, which is how a light stops being read.
  const rec = { version: '2.1.257', outcome: BLOCKED, stage: 'stage',
    reason: 'contextual-keyword position' };
  assert.strictEqual(compare(rec, BLOCKED_MERGE).ok, true);
  assert.strictEqual(
    compare({ ...rec, reason: 'renamed into a contextual-keyword position' }, BLOCKED_MERGE).ok,
    false, 'a reason that is not literally present must not match');
});

// ---- the pin grammar -------------------------------------------------------------------

test('carve-probe: parsePinFile reads the real UPSTREAM_PIN', () => {
  const r = parsePinFile(fs.readFileSync(PIN, 'utf8'));
  assert.match(r.pin, /^\d+(\.\d+)+$/, 'the pinned version must still be readable');
  assert.ok(r.expectation, 'UPSTREAM_PIN must carry a carve-probe record');
  assert.deepStrictEqual(r.malformed, []);
});

test('carve-probe: the record grammar, including what it refuses', () => {
  assert.deepStrictEqual(parsePinFile('carve-probe 2.1.278 carves').expectation,
    { version: '2.1.278', outcome: CARVES, stage: null, reason: null });
  assert.deepStrictEqual(
    parsePinFile(`carve-probe 2.1.257 ${BLOCKED} compile invalid property name`).expectation,
    { version: '2.1.257', outcome: BLOCKED, stage: 'compile', reason: 'invalid property name' });
  // A stage the probe can never produce is MALFORMED, not silently accepted: comparing
  // against a state that cannot occur would be green forever.
  const bad = parsePinFile('carve-probe 2.1.257 blocked linkage something');
  assert.strictEqual(bad.expectation, null);
  assert.strictEqual(bad.malformed.length, 1);
  // A comment line is not a record. UPSTREAM_PIN is mostly prose about this very grammar.
  assert.strictEqual(parsePinFile('#     carve-probe <version> carves').expectation, null);
});

// ---- the compile stage, against the real engine ---------------------------------------

const ENGINE = process.env.CLODE_TJS;

test('carve-probe: an unparseable staged module is classified as a `compile` failure', (t) => {
  if (!ENGINE || !fs.existsSync(ENGINE)) {
    t.skip('no CLODE_TJS engine — the compile stage cannot be exercised without one');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carve-probe-t-'));
  try {
    // A minimal STAGED GRAPH in the shape libexec/graph-meta.js reads, carrying the exact
    // construct the 2.1.257 merge produced: a renamed token inside a unicode escape in an
    // identifier (`\u{b5}s` -> `\__m28_u{b5}s`). The ENGINE's own parser is what answers,
    // so this goes red if the engine stops rejecting it as well as if the probe stops
    // noticing — which is the pairing a hand-written expected-string could not give.
    const graph = path.join(work, 'graph.json');
    fs.writeFileSync(graph, JSON.stringify({
      format: 'clode-bun-graph-v1',
      entry: 'bad.js',
      order: ['ok.js', 'bad.js'],
      sources: {
        'ok.js': 'export const fine = 1;\n',
        'bad.js': 'export const x = Object.freeze({ns:1n,\\__m28_u{b5}s:1000n});\n',
      },
    }));
    const r = compileStagedGraph({ graph, engine: ENGINE, work });
    assert.strictEqual(r.outcome, BLOCKED, JSON.stringify(r));
    assert.strictEqual(r.stage, 'compile');
    assert.match(r.message, /bad\.js/, 'the verdict must name the module that failed');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('carve-probe: a clean staged graph reports carving, with a module count', (t) => {
  if (!ENGINE || !fs.existsSync(ENGINE)) {
    t.skip('no CLODE_TJS engine — the compile stage cannot be exercised without one');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carve-probe-t-'));
  try {
    const graph = path.join(work, 'graph.json');
    fs.writeFileSync(graph, JSON.stringify({
      format: 'clode-bun-graph-v1', entry: 'a.js', order: ['a.js'],
      sources: { 'a.js': 'export const a = 1;\n' },
    }));
    const r = compileStagedGraph({ graph, engine: ENGINE, work });
    assert.strictEqual(r.outcome, CARVES, JSON.stringify(r));
    assert.strictEqual(r.modules, 1);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('carve-probe: a missing provider or engine is a NAMED skip, never a verdict', () => {
  // "The job never reached the build step" must not read as "still blocked" — BACKLOG.md's
  // own condition on this probe. Both preconditions are checked before anything is carved,
  // so neither can be mistaken for a measurement of upstream.
  const noProvider = measure({ provider: '/nonexistent/claude', version: '9.9.9',
    engine: ENGINE || '/nonexistent/tjs', work: os.tmpdir() });
  assert.ok(noProvider.skip, JSON.stringify(noProvider));
  assert.strictEqual(noProvider.outcome, undefined);
  const noEngine = measure({ provider: PIN, version: '9.9.9',
    engine: '/nonexistent/tjs', work: os.tmpdir() });
  assert.ok(noEngine.skip, JSON.stringify(noEngine));
  assert.match(noEngine.skip, /engine/);
});
