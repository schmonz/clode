'use strict';
// node-shim judged by BEHAVIOUR against node, not by presence (observability plan Task 3, 2026-11-18).
//
// WHY. The shim-surface map (test/shim-surface.test.cjs) answers "does the shim HAVE what the bundle
// reaches for?" It cannot see an fs.statSync that exists and answers dev 0, ino 0; an isFIFO() that
// exists and answers false for a FIFO; a statSync that ignores { throwIfNoEntry: false }; an os with
// no devNull; a write into a closed pipe that says EUNKNOWN where node says EPIPE; a net.createServer
// that is a wall. Each of those was found by a reviewer, one at a time (2026-10-03..05), and each had
// its own hand-written test afterwards. This generalises those tests (stat identity, errno) into one
// differential whose list of calls comes from the carve, so nobody has to predict the next one.
//
// HOW.
//   1. The inventory: every call the 2.1.x carve makes to a builtin of SHIM_MODULES below, with the
//      arguments it passes (test/shim-surface/call-sites.cjs, the shim-surface reader extended from
//      "exists" to "these calls, with these options"), and every non-function export it reads.
//   2. The plan: each call shape replayed with the carve's literals as written and the table's samples
//      where the carve passes an expression (test/shim-differential/plan.cjs, table.cjs), against a
//      fixture tree of every file type (fixtures.cjs).
//   3. The run: the same executor (exec.cjs) under host node (the ORACLE, memory node-only-as-oracle),
//      under tjs + node-shim, and under node again; a field node itself moves between its two runs
//      is named unjudgeable, never compared (run.cjs, compare.cjs).
//   4. The verdict: every judged field must be node's, except where a divergence is KNOWN (known.cjs),
//      and each known one names its BACKLOG.md entry. A known divergence that stops diverging is a
//      finding too (drop it from known.cjs and BACKLOG.md), so the list can only shrink honestly.
//   Coverage is part of the verdict: an inventoried API the table neither drives nor names in
//   UNCOVERED (with why) is a finding, so a new call upstream makes is judged the day the carve has it.
//
// THE ORACLE IS A NODE VERSION. Every answer is judged against the node running the test, so what is
// "node's" moves with it: node 26 drops buffer.SlowBuffer (the carve still names it; it is UNCOVERED),
// adds members to fs.promises and util.types, and rewords error messages. The pairs in
// known-divergences.json were measured under node 24.21.0 (darwin) and 24.22.0 (musl); a job on another
// node may name new divergences, or stale pairs, that are the oracle's move and not the shim's.
// Read such a finding against `node --version` first.
//
// Runs where an engine and a provider are both present: CI's node-shim-oracle (linux musl, against a
// musl node) and node-shim-oracle-darwin, and a dev box with CLODE_TJS / CLODE_PROVIDER_BIN. Elsewhere
// it skips, by name.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, checkControl, checkGate, OK, SKIP } = require('./guard.cjs');
const helper = require('./node-shim-helper.cjs');
const models = require('./oracle-models.cjs');
const refs = require('./shim-surface/bundle-refs.cjs');
const collect = require('./shim-surface/collect.cjs');
const callSites = require('./shim-surface/call-sites.cjs');
const { makePlan } = require('./shim-differential/plan.cjs');
const { runDifferential } = require('./shim-differential/run.cjs');
const { compareRuns } = require('./shim-differential/compare.cjs');
const known = require('./shim-differential/known.cjs');

const REPO = path.resolve(__dirname, '..');
// The modules the brief names, plus zlib (the bundle gzips its event batches with it).
const SHIM_MODULES = ['fs', 'fs/promises', 'os', 'path', 'child_process', 'net', 'stream', 'events',
  'buffer', 'util', 'tty', 'process', 'zlib'];
// Below this many judged cases the verdict means nothing: the inventory or the run went blind.
const FLOOR = 600;

function nodeExports(names) {
  const out = {};
  for (const n of names) {
    const m = require(n);
    out[n] = {};
    for (const k of Object.keys(m)) out[n][k] = typeof m[k];
  }
  return out;
}

// What the carve calls, and how: { inventory, values }.
function inventoryOf(cli) {
  const modules = refs.loadModules(cli);
  const exp = nodeExports(SHIM_MODULES);
  return { inventory: callSites.inventory(modules, SHIM_MODULES, exp), values: callSites.valueReads(modules, SHIM_MODULES, exp) };
}

// PURE: plan findings + the three runs -> findings. `known` is known.cjs (its exact pairs).
function judge({ plan, runs, known: K = known, platform = process.platform }) {
  const findings = [...plan.findings];
  for (const [tag, r] of Object.entries(runs)) {
    if (tag === 'fifo') continue;
    if (!r.done) {
      findings.push(`${tag === 'ours' ? 'quaude' : `node (${tag})`}'s executor did not finish (exit ${r.code}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error}` : ''}): ${String(r.stderr).slice(0, 400)}`);
    }
  }
  if (runs.fifo === false && process.platform !== 'win32') findings.push('no FIFO fixture (mkfifo failed): isFIFO is not judged');
  const c = compareRuns({ cases: plan.cases, node1: runs.node1.results, ours: runs.ours.results, node2: runs.node2.results });
  findings.push(...c.missing);
  const seen = new Set();
  let tolerated = 0;
  for (const [id, lines] of Object.entries(c.divergences)) {
    const unexplained = lines.filter((l) => {
      const leaf = K.leafOf(l);
      const k = leaf !== null && K.knownPair(id, leaf, platform);
      if (k) { seen.add(`${id}\u0000${leaf}`); tolerated++; }
      return !k;
    });
    if (unexplained.length) findings.push(`${id}\n      ${unexplained.slice(0, 8).join('\n      ')}${unexplained.length > 8 ? `\n      (+${unexplained.length - 8} more)` : ''}`);
  }
  // a listed pair that no longer diverges (and that node held still for) is a finding: fixed things
  // leave known-divergences.json in the commit that fixes them
  const stale = K.pairsOn(platform).filter((p) => !seen.has(`${p.id}\u0000${p.leaf}`) && !(c.unjudgeable[p.id] || []).includes(p.leaf));
  const byCause = {};
  for (const p of stale) (byCause[p.cause] = byCause[p.cause] || []).push(`${p.id} ${p.leaf}`);
  for (const [cause, ps] of Object.entries(byCause)) {
    findings.push(`${ps.length} field(s) listed under ${cause} no longer diverge: drop them from test/shim-differential/known-divergences.json (freeze.cjs), and the cause's BACKLOG.md line if none is left: ${ps.slice(0, 6).join('; ')}${ps.length > 6 ? ' ...' : ''}`);
  }
  return { findings, examined: c.compared, unjudgeable: c.unjudgeable, divergent: Object.keys(c.divergences).length, tolerated };
}

let measured = null;
function measure() {
  if (measured) return measured;
  const tjs = helper.tjsPath();
  if (!tjs) return (measured = { skip: 'no tjs binary (CLODE_TJS or the scratch build): nothing to judge' });
  const missing = collect.missingExtDeps();
  if (missing.length) return (measured = { skip: `the shim's ext-dep closure is not installed (${missing.join(', ')}; npm ci --prefix deps/claude)` });
  let staged = null;
  try { staged = models.stageProviderCli({ env: process.env }); } catch (e) { staged = { error: e.message }; }
  const skip = models.providerSkipReason(staged, 'no staged provider bundle (CLODE_PROVIDER_BIN): no carve to take the inventory from');
  if (skip) return (measured = { skip });
  const graph = path.join(staged.cacheDir, 'cli.cjs');
  const { inventory, values } = inventoryOf(fs.existsSync(graph) ? graph : staged.cli);
  const plan = makePlan({ inventory, values });
  const [cmd, argv] = helper.engineSpawn(['run', helper.LOADER]);
  const runs = runDifferential({ cases: plan.cases, subject: [cmd, ...argv] });
  // CLODE_SHIM_DIFF_DUMP=<file>: every divergence of this run, for test/shim-differential/freeze.cjs
  if (process.env.CLODE_SHIM_DIFF_DUMP) {
    const c = compareRuns({ cases: plan.cases, node1: runs.node1.results, ours: runs.ours.results, node2: runs.node2.results });
    fs.writeFileSync(process.env.CLODE_SHIM_DIFF_DUMP, JSON.stringify({ platform: process.platform, divergences: c.divergences,
      apis: Object.fromEntries(plan.cases.map((k) => [k.id, k.api])) }, null, 1));
  }
  return (measured = { plan, runs, inventory, subject: [cmd, ...argv] });
}

// What a green run leaves unjudged, said on every run (t.diagnostic), not only when it fails.
function noteOf(plan, r, K) {
  const capped = (plan.capped || []).map((x) => `${x.api} ${x.planned}+${x.left} left`).join(', ');
  const cut = (plan.truncated || []).map((x) => `${x.api} ${x.shapes} shape(s) ${x.from}->${x.to} args`).join(', ');
  return `${r.examined} calls judged against node (${plan.cases.length} planned from the carve, ${r.divergent} diverging, `
    + `${r.tolerated} fields tolerated as listed pairs under ${K.causesIn().length} causes). `
    + `NOT JUDGED: ${plan.uncovered.length} inventoried APIs not driven: ${plan.uncovered.join(', ')}. `
    + `Capped (cases the cap left out): ${capped || 'none'}. Carve arguments cut to the driver's count: ${cut || 'none'}.`;
}

const guard = defineGuard({
  name: 'node-shim-differential',
  floor: FLOOR,
  read: () => {
    const m = measure();
    return m.skip ? { skip: m.skip } : { plan: m.plan, runs: m.runs, known };
  },
  scan: ({ plan, runs, known: K }) => {
    const r = judge({ plan, runs, known: K });
    return { findings: r.findings, examined: r.examined, note: noteOf(plan, r, K) };
  },
  // THE CONTROL is a real escape: fs.statSync on a FIFO as node-shim answered it before eba6c57
  // (2026-10-04): isFIFO() false and ino 0. It is not known, so the guard must name it.
  control: () => {
    const c = { id: 'fs.statSync(<fifo>)', api: 'fs.statSync', style: 'sync', args: [{ path: 'fifo' }] };
    const node = { id: c.id, r: { Stats: 'Stats', kinds: 'isFIFO', ino: 4242 } };
    const ours = { id: c.id, r: { Stats: 'Stats', kinds: '', ino: 0 } };
    const run = (x) => ({ done: true, results: { [c.id]: x } });
    return { plan: { cases: [c], findings: [], uncovered: [], capped: [], truncated: [] }, runs: { node1: run(node), ours: run(ours), node2: run(node), fifo: true }, known };
  },
});

test(`guard control: ${guard.name} can fail`, () => {
  const r = checkControl(guard);
  assert.strictEqual(r.verdict, OK, r.message);
});

test(`guard gate: ${guard.name}`, (t) => {
  const r = checkGate(guard);
  if (r.verdict === SKIP) { t.skip(r.message); return; }
  t.diagnostic(r.message);
  const m = measure();
  const unj = Object.entries(judge({ plan: m.plan, runs: m.runs }).unjudgeable);
  if (unj.length) t.diagnostic(`unjudgeable (node moved between its own runs): ${unj.map(([id, ks]) => `${id}: ${ks.join(',')}`).join('; ').slice(0, 2000)}`);
  assert.strictEqual(r.verdict, OK, r.message);
});

// Every known cause names a BACKLOG.md entry that exists and names it, so the list of tolerated
// divergences is the BACKLOG's list, not a private one.
test('every known divergence names its BACKLOG.md entry', () => {
  const text = fs.readFileSync(path.join(REPO, 'BACKLOG.md'), 'utf8');
  assert.ok(text.includes(`## ${known.BACKLOG_HEADING}`), `BACKLOG.md has no "## ${known.BACKLOG_HEADING}"`);
  const missing = known.causesIn().filter((c) => !text.includes(c));
  assert.deepStrictEqual(missing, [], 'causes known-divergences.json tolerates that BACKLOG.md does not name');
  // and every listed pair is one its cause's pattern claims: nothing hand-slipped into the data
  const wrong = [];
  for (const [id, leaves] of Object.entries(known.KNOWN)) {
    const api = id.slice(0, id.search(/[( ]/));
    for (const [leaf, k] of Object.entries(leaves)) if (known.classify(api, id, leaf) !== k.cause) wrong.push(`${id} ${leaf} (${k.cause})`);
  }
  assert.deepStrictEqual(wrong, [], 'listed pairs their cause does not claim');
});

// Every API the carve calls that the gate does not drive is named in BACKLOG.md by name, so what a
// green run leaves unjudged is on the to-do list, not only in a diagnostic.
test('every inventoried API the table does not drive is named in BACKLOG.md', () => {
  const text = fs.readFileSync(path.join(REPO, 'BACKLOG.md'), 'utf8');
  const at = text.indexOf(`## ${known.BACKLOG_HEADING}`);
  const entry = text.slice(at, text.indexOf('\n## ', at + 4));
  const T = require('./shim-differential/table.cjs');
  const missing = Object.keys(T.UNCOVERED).filter((api) => !entry.includes(`\`${api}\``));
  assert.deepStrictEqual(missing, [], 'UNCOVERED APIs the BACKLOG entry does not list (in backticks)');
});

// THE CONTROL THE OLD PATTERNS FAILED: a fs/promises.unlink that does nothing. Under the 2026-11-19
// patterns DIFF-ARG-VALIDATION's id pattern matched every one-path call and tolerated it; with exact
// pairs the gate must name it. Runs the real engine on the unlink cases alone, with an executor that
// replaces unlink by a no-op before the harness's own executor starts.
test('control: a no-op fs/promises.unlink fails the gate', (t) => {
  const m = measure();
  if (m.skip) { t.skip(m.skip); return; }
  const cases = m.plan.cases.filter((c) => c.api === 'fs/promises.unlink');
  assert.ok(cases.length >= 5, `the carve's unlink shapes are planned (${cases.length})`);
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-diff-ctl-'));
  try {
    const broken = path.join(dir, 'broken-exec.cjs');
    fs.writeFileSync(broken, `const fsp = require('fs/promises'); fsp.unlink = async () => {}; require('fs').promises.unlink = fsp.unlink;
require(${JSON.stringify(require('./shim-differential/run.cjs').EXEC)});\n`);
    const runs = runDifferential({ cases, subject: m.subject, subjectExec: broken });
    const r = judge({ plan: { cases, findings: [], uncovered: [] }, runs });
    const named = r.findings.filter((f) => f.startsWith('fs/promises.unlink('));
    assert.ok(named.length >= 3, `a no-op unlink is named (${named.length} cases): ${r.findings.join('\n').slice(0, 1500)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The reader the inventory rests on: a minified call in each binding shape, with the argument
// forms it classifies. If this breaks, the plan shrinks and the floor above catches it too.
test('call-sites: every binding shape and argument form of the carve is read', () => {
  const src = 'import{statSync as z,openSync as o}from"fs";import*as P from"node:path";import F from"fs/promises";'
    + 'z(a,{throwIfNoEntry:!1});z("/home");o(p,w.O_WRONLY|w.O_CREAT|w.O_EXCL|f,384);P.join(a,`x`,"..");'
    + 'F.writeFile(p,d,{encoding:"utf-8",mode:384,flag:q});function z(){};x.z(1)';
  const inv = callSites.callSites([{ id: 'm', src }], ['fs', 'path', 'fs/promises']);
  const shapes = (api) => [...inv.get(api).shapes.values()].map((s) => s.args);
  assert.deepStrictEqual(shapes('fs.statSync'), [[{ expr: true }, { obj: { throwIfNoEntry: { lit: false } } }], [{ lit: '/home' }]]);
  assert.deepStrictEqual(shapes('fs.openSync'), [[{ expr: true }, { flags: ['O_WRONLY', 'O_CREAT', 'O_EXCL'], more: true }, { lit: 384 }]]);
  assert.deepStrictEqual(shapes('path.join'), [[{ expr: true }, { lit: 'x' }, { lit: '..' }]]);
  assert.deepStrictEqual(shapes('fs/promises.writeFile'), [[{ expr: true }, { expr: true }, { obj: { encoding: { lit: 'utf-8' }, mode: { lit: 384 }, flag: { expr: true } } }]]);
  assert.strictEqual(inv.get('fs.statSync').sites, 2, 'a function DEFINITION named like an import, and a method call x.z(), are not calls');
});

// The plan is the carve's: a literal option is replayed as written, an expression takes the table's
// samples, and an API the table neither drives nor excuses is a finding, not a silent skip.
test('plan: the carve decides what is judged; the table only fills expressions', () => {
  const inventory = {
    'fs.statSync': { sites: 3, shapes: [{ args: [{ expr: true }, { obj: { throwIfNoEntry: { lit: false } } }], count: 3 }] },
    'fs.someNewThing': { sites: 1, shapes: [{ args: [], count: 1 }] },
  };
  const plan = makePlan({ inventory, values: { 'os.devNull': { reads: 4, type: 'string' } } });
  const stat = plan.cases.filter((c) => c.api === 'fs.statSync');
  assert.ok(stat.some((c) => c.id === 'fs.statSync(<fifo>, {throwIfNoEntry:false})'));
  assert.ok(stat.some((c) => c.id === 'fs.statSync(<missing>, {throwIfNoEntry:false})'));
  assert.ok(plan.cases.some((c) => c.id === 'os.devNull (value)'));
  assert.ok(plan.findings.some((f) => f.startsWith('fs.someNewThing: the carve calls it')), plan.findings.join('\n'));
});

module.exports = { judge, inventoryOf, SHIM_MODULES };
