'use strict';
// A GATE THAT DOES NOT RUN IN CI TURNS CI RED (observability plan Task 5; user doctrine 2026-10-05:
// "Job 0 is always to be able to observe our current state more accurately than yesterday").
//
// test/ci-gates.cjs is the manifest (which job must run which gate) and holds the two checks; this
// file registers them as guards:
//   ci-gate-placement  every suite run: the manifest agrees with the gate registry (loaded, not
//                      parsed: test/ci-gates.cjs's loadRegistry), the tree and the workflows.
//   gates-ran-in-ci    CI's gates-ran-in-ci job only (CLODE_GATES_RAN=<dir of gates-ran-* artifacts>):
//                      every gate each job must run passed there, by name. A skip, a failure, a gate
//                      that never appeared, or a job that uploaded no gate list, is a finding.
// The second one skips everywhere else (it has nothing to read), and is itself EXEMPT in the manifest:
// it is the aggregator job's own verdict.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const G = require('./ci-gates.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
function trackedFiles() {
  const { execFileSync } = require('node:child_process');
  return new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean));
}
function workflowTexts(manifest) {
  const out = {};
  for (const p of new Set([...manifest.jobs.map((j) => j.workflow), manifest.aggregator.workflow, G.CI])) {
    try { out[p] = read(p); } catch { /* absent: checkPlacement names it */ }
  }
  return out;
}

// Every caller of tjs-legs.yml, in every workflow, with the legs it builds: computed by scripts/tjs-legs.mjs itself,
// exactly as tjs-legs.yml's plan step runs it (tier, only), so the overlap check reads the real partition.
function legCallers() {
  const { execFileSync } = require('node:child_process');
  const out = [];
  const dir = path.join(REPO, '.github', 'workflows');
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    for (const c of G.legCallersIn(`.github/workflows/${f}`, fs.readFileSync(path.join(dir, f), 'utf8'))) {
      const legs = JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'scripts', 'tjs-legs.mjs'), c.tier, c.only], { encoding: 'utf8' }));
      out.push({ ...c, legs: legs.map((l) => l.leg) });
    }
  }
  return out;
}

// ---- fixtures: a tiny world the controls and unit tests share ------------------------------------
const FX_CI = [
  'jobs:',
  '  oracle:',
  '    steps:',
  '      - run: node --test --test-reporter=./test/cell-reporter.mjs test/a.test.cjs test/node-shim-*.test.cjs',
  '      - uses: actions/upload-artifact@v7.0.2',
  '        with: { name: gates-ran-oracle, overwrite: true }',
  '  gates-ran-in-ci:',
  '    needs: [test, oracle]',
  '    steps:',
  '      - uses: actions/download-artifact@v8.0.2',
  '        with: { pattern: gates-ran-* }',
  '      - env: { NEEDS: ${{ toJSON(needs) }} }',
  '        run: CLODE_GATES_RAN=x node --test test/gates-ran-in-ci.test.cjs',
  '',
].join('\n');
const FX_SUITE = [
  'jobs:',
  '  suite:',
  '    strategy: { matrix: { include: [ { os: ubuntu-latest } ] } }',
  '    steps:',
  '      - run: npm test',
  '        env: { CLODE_GATES_REPORT: x }',
  '      - uses: actions/upload-artifact@v7.0.2',
  '        with: { name: gates-ran-test-${{ matrix.os }}, overwrite: true }',
  '',
].join('\n');
const fxManifest = (over = {}) => ({
  jobs: [
    { id: 'test-ubuntu-latest', workflow: 'suite.yml', job: 'suite', carries: ['os: ubuntu-latest'], suite: true },
    { id: 'oracle', workflow: G.CI, job: 'oracle' },
  ],
  placed: { b: { jobs: ['oracle'], why: 'needs an engine' } },
  exempt: {},
  files: {},
  aggregator: { workflow: G.CI, job: 'gates-ran-in-ci' },
  ...over,
});
const FX_REGISTRY = [{ name: 'a', file: 'test/a.test.cjs' }, { name: 'b', file: 'test/a.test.cjs' }];
const fxPlacement = (over = {}) => ({
  manifest: fxManifest(over.manifest),
  registry: over.registry || FX_REGISTRY,
  texts: { [G.CI]: FX_CI, 'suite.yml': FX_SUITE, ...(over.texts || {}) },
  files: new Set(['test/a.test.cjs', ...(over.files || [])]),
  legCallers: over.legCallers || [{ workflow: 'w.yml', job: 'fast', only: 'fast', legs: ['a'] }, { workflow: 'w.yml', job: 'slow', only: 'slow', legs: ['b'] },
    { workflow: 'r.yml', job: 'all', only: '', legs: ['a', 'b'] }],
});
const rec = (name, extra = {}) => ({ type: 'test:pass', file: '/home/runner/work/clode/clode/test/a.test.cjs', name, ...extra });
const fxRan = (over = {}) => ({
  manifest: fxManifest(over.manifest),
  registry: FX_REGISTRY,
  records: new Map(Object.entries({
    'test-ubuntu-latest': [rec('guard gate: a'), rec('guard gate: b', { skip: 'no engine' })],
    oracle: [rec('guard gate: b')],
    ...(over.records || {}),
  })),
});

// ---- the static guard ----------------------------------------------------------------------------
// Both manifests, ci.yml's and release.yml's, each against its own workflow; findings carry the manifest's name.
function scanPlacements(input) {
  if (!input.manifests) return G.checkPlacement(input);
  const findings = [];
  let examined = 0;
  const notes = [];
  for (const m of input.manifests) {
    const r = G.checkPlacement({ ...input, manifest: m, texts: workflowTexts(m) });
    findings.push(...r.findings.map((f) => `${m.name}: ${f}`));
    examined += r.examined;
    notes.push(`${m.name}: ${r.note}`);
  }
  return { findings, examined, note: notes.join('\n  ') };
}
guardTests(defineGuard({
  name: 'ci-gate-placement',
  // One per declared job, placement, exemption and gate file, over both manifests: measured 2026-11-19, ci.yml
  // 38 + 47 + 2 + 44 = 131 and release.yml 43 + 4 + 45 + 2 = 94, 225 in all. Fewer means a manifest lost entries
  // without anyone re-measuring what the jobs run.
  floor: 225,
  read: () => {
    const registry = G.loadRegistry();
    return { manifests: [G.MANIFEST, G.RELEASE_MANIFEST], registry, files: trackedFiles(), legCallers: legCallers() };
  },
  scan: scanPlacements,
  // A placement naming a gate nobody registered, and a suite row that uploads under the oracle's artifact name
  // (with overwrite, one list would silently replace the other).
  control: () => fxPlacement({ manifest: { placed: { b: { jobs: ['oracle'], why: 'x' }, gone: { jobs: ['oracle'], why: 'x' } } },
    texts: { 'suite.yml': FX_SUITE.replace('gates-ran-test-${{ matrix.os }}', 'gates-ran-oracle') } }),
}));

// ---- the runtime guard ---------------------------------------------------------------------------
function readRan() {
  const root = process.env.CLODE_GATES_RAN;
  if (!root) {
    return { skip: 'not the gates-ran-in-ci job (CLODE_GATES_RAN unset): that job downloads every CI job\'s gate list and runs this' };
  }
  if (!fs.existsSync(root)) throw new Error(`CLODE_GATES_RAN=${root} does not exist: the download found no gate list at all`);
  // NEEDS is ci.yml's `${{ toJSON(needs) }}`: each judged job's result, so a list missing because infra cancelled
  // the job is named UNOBSERVED rather than DARK. Unset (a local run), every finding is DARK.
  let needs = null;
  if (process.env.NEEDS) {
    try { needs = JSON.parse(process.env.NEEDS); } catch (e) { throw new Error(`NEEDS is not JSON (${e.message}): ${process.env.NEEDS.slice(0, 200)}`); }
  }
  // CLODE_GATES_MANIFEST: which workflow's jobs these lists come from (release.yml's gates-ran-in-release says
  // `release`); unset, ci.yml's.
  const manifest = G.MANIFESTS[process.env.CLODE_GATES_MANIFEST || 'ci'];
  if (!manifest) throw new Error(`CLODE_GATES_MANIFEST=${process.env.CLODE_GATES_MANIFEST} names no manifest (${Object.keys(G.MANIFESTS).join(', ')})`);
  return { manifest, records: G.readRecords(root, manifest.jobs), registry: G.loadRegistry(), needs };
}
guardTests(defineGuard({
  name: 'gates-ran-in-ci',
  floor: 1,
  read: readRan,
  scan: G.checkRan,
  // The failure this exists for: a gate placed in a job skipped there, and another job uploaded nothing.
  control: () => fxRan({ records: { oracle: [rec('guard gate: b', { skip: 'no engine' })] },
    manifest: { jobs: [...fxManifest().jobs, { id: 'silent', workflow: G.CI, job: 'oracle' }] } }),
}));

test('gates-ran-in-ci: what each CI job ran, listed', (t) => {
  const inputs = readRan();
  if ('skip' in inputs) { t.skip(inputs.skip); return; }
  t.diagnostic(G.checkRan(inputs).note);
});

// ---- the checks, unit by unit --------------------------------------------------------------------
test('ci-gate-placement: the fixture world is clean', () => {
  const r = G.checkPlacement(fxPlacement());
  assert.deepStrictEqual(r.findings, []);
});

test('ci-gate-placement: each way the manifest can disagree with the tree is named', () => {
  const cases = [
    [{ manifest: { placed: { zz: { jobs: ['oracle'], why: 'x' } } } }, /PLACED names zz, which is not a registered gate/],
    [{ manifest: { placed: { b: { jobs: ['nowhere'], why: 'x' } } } }, /names job nowhere, which JOBS does not declare/],
    [{ manifest: { placed: { b: { jobs: ['oracle'], why: '' } } } }, /PLACED b gives no why/],
    [{ manifest: { exempt: { a: '' } } }, /EXEMPT a gives no reason/],
    [{ manifest: { exempt: { b: 'x' } } }, /b is both PLACED and EXEMPT/],
    [{ manifest: { files: { 'test/gone.test.cjs': { jobs: ['oracle'] } } } }, /FILES names test\/gone.test.cjs, which is not in the tree/],
    [{ manifest: { files: { 'test/c.test.cjs': { jobs: ['oracle'] } } }, files: ['test/c.test.cjs'] }, /FILES test\/c.test.cjs in oracle, which never runs it/],
    [{ registry: [...FX_REGISTRY, { name: 'b', file: 'test/z.test.cjs' }] }, /gate b is registered twice/],
    [{ registry: [{ name: 'a', file: 'test/a.test.cjs' }, { name: 'b', file: 'test/b.test.cjs' }] }, /PLACED b in oracle, which never runs test\/b.test.cjs/],
    [{ texts: { 'suite.yml': FX_SUITE.replace('CLODE_GATES_REPORT', 'X') } }, /test-ubuntu-latest .*never sets CLODE_GATES_REPORT/],
    [{ texts: { 'suite.yml': FX_SUITE.replace('os: ubuntu-latest', 'os: macos-latest') } }, /does not carry "os: ubuntu-latest"/],
    [{ texts: { [G.CI]: FX_CI.replace('needs: [test, oracle]', 'needs: [test]') } }, /the aggregator does not wait for oracle/],
    [{ texts: { [G.CI]: FX_CI.replace('  gates-ran-in-ci:', '  other:') } }, /the aggregator: .* has no job gates-ran-in-ci/],
    [{ texts: { [G.CI]: FX_CI.replace('NEEDS: ${{ toJSON(needs) }}', 'X: y') } }, /the aggregator never passes NEEDS/],
    [{ texts: { [G.CI]: FX_CI.replace('gates-ran-oracle, overwrite: true', 'gates-ran-oracle') } }, /job oracle uploads gates-ran-oracle without overwrite: true/],
    [{ texts: { [G.CI]: FX_CI.replace("        with: { name: gates-ran-oracle, overwrite: true }", "        with:\n          name: gates-ran-oracle\n          overwrite: true\n          path: |\n            a\n            b") } },
      /job oracle uploads gates-ran-oracle from a multi-line path/],
    [{ texts: { 'suite.yml': FX_SUITE.replace('gates-ran-test-${{ matrix.os }}', 'gates-ran-oracle') } }, /artifact gates-ran-oracle is uploaded by suite.yml:suite and .*:oracle/],
    [{ legCallers: [{ workflow: 'w.yml', job: 'fast', only: 'fast', legs: ['a', 'b'] }, { workflow: 'w.yml', job: 'slow', only: 'slow', legs: ['b', 'c'] }] },
      /w.yml: jobs fast \(only: fast\) and slow \(only: slow\) both build b/],
    [{ texts: { [G.CI]: `${FX_CI}  stray:\n    steps:\n      - run: node --test test/a.test.cjs\n` } }, /ci.yml job stray runs gate file\(s\) test\/a.test.cjs but is not in JOBS/],
  ];
  for (const [over, re] of cases) {
    const r = G.checkPlacement(fxPlacement(over));
    assert.ok(r.findings.some((f) => re.test(f)), `${re} not among:\n${r.findings.join('\n')}`);
  }
});

test('ci-gate-placement: a glob in the job\'s text runs the files it matches, and only those', () => {
  assert.ok(G.names('node --test test/node-shim-*.test.cjs', 'test/node-shim-net.test.cjs'));
  assert.ok(!G.names('node --test test/node-shim-*.test.cjs', 'test/node-shim/x.test.cjs'));
  assert.ok(!G.names('node --test test/node-shim-*.test.cjs', 'test/shim-surface.test.cjs'));
});

test('gates-ran-in-ci: the fixture world passes, and every declared gate counts', () => {
  const r = G.checkRan(fxRan({ records: { 'test-ubuntu-latest': [rec('guard gate: a'), rec('guard gate: b', { skip: 'no engine' })] } }));
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 2);
});

test('gates-ran-in-ci: each way a job can fail to run a gate is named', () => {
  const cases = [
    [{ records: { oracle: null } }, /oracle uploaded no gate list \(artifact gates-ran-oracle\)/],
    [{ records: { oracle: [] } }, /oracle uploaded no gate list/],
    [{ records: { oracle: [rec('guard gate: b', { skip: 'no engine' })] } }, /oracle: gate b skipped \(no engine\)/],
    [{ records: { oracle: [rec('guard gate: b', { type: 'test:fail' })] } }, /oracle: gate b failed/],
    [{ records: { oracle: [rec('guard gate: b'), rec('guard gate: b', { skip: 'second run' })] } }, /oracle: gate b skipped \(second run\)/],
    [{ records: { oracle: [rec('something else')] } }, /oracle: gate b never reported/],
    [{ records: { 'test-ubuntu-latest': [rec('guard gate: a', { skip: 'no x' })] } }, /test-ubuntu-latest: gate a skipped \(no x\).*places or exempts it/],
    // A gate only the records know (registered dynamically) still defaults to the suite.
    [{ records: { 'test-ubuntu-latest': [rec('guard gate: a'), rec('guard gate: dyn', { skip: 'y' })] } }, /test-ubuntu-latest: gate dyn skipped/],
    [{ manifest: { exempt: { a: 'measured: runs nowhere' } } }, /gate a is EXEMPT but passed in test-ubuntu-latest/],
  ];
  for (const [over, re] of cases) {
    const r = G.checkRan(fxRan(over));
    assert.ok(r.findings.some((f) => re.test(f)), `${re} not among:\n${r.findings.join('\n')}`);
  }
});

test('gates-ran-in-ci: what is ABSENT from a job that did not succeed is UNOBSERVED; a reported skip, or anything from a job that succeeded, is DARK; both stay red', () => {
  const missing = { records: { oracle: null } };
  const skipped = { records: { oracle: [rec('guard gate: b', { skip: 'no engine' })] } };
  const absent = { records: { oracle: [rec('other')] } };
  const rows = [
    // [case, needs, expected prefix]
    [missing, { oracle: { result: 'cancelled' } }, /^UNOBSERVED \(oracle concluded cancelled\): oracle uploaded no gate list/],
    [missing, { oracle: { result: 'skipped' } }, /^UNOBSERVED \(oracle concluded skipped\): oracle uploaded no gate list/],
    [missing, { oracle: { result: 'failure' } }, /^UNOBSERVED \(oracle concluded failure\): oracle uploaded no gate list/],
    [missing, { oracle: { result: 'success' } }, /^DARK: oracle uploaded no gate list/],
    [missing, null, /^DARK: oracle uploaded no gate list/],
    [skipped, { oracle: { result: 'success' } }, /^DARK: oracle: gate b skipped \(no engine\)/],
    [absent, { oracle: { result: 'success' } }, /^DARK: oracle: gate b never reported/],
    [absent, { oracle: { result: 'cancelled' } }, /^UNOBSERVED \(oracle concluded cancelled\): oracle: gate b never reported/],
    // A recorded skip means the gate was REACHED: DARK whatever the job concluded.
    [skipped, { oracle: { result: 'failure' } }, /^DARK: oracle: gate b skipped \(no engine\)/],
    [{ records: { oracle: [rec('guard gate: b', { type: 'test:fail' })] } }, { oracle: { result: 'failure' } }, /^DARK: oracle: gate b failed/],
  ];
  for (const [over, needs, re] of rows) {
    const r = G.checkRan({ ...fxRan(over), needs });
    assert.ok(r.findings.length > 0, `${re}: no finding, so it would be green`);
    assert.ok(r.findings.some((f) => re.test(f)), `${re} not among:\n${r.findings.join('\n')}`);
  }
  const r = G.checkRan({ ...fxRan({ records: { oracle: null, 'test-ubuntu-latest': [rec('guard gate: a', { skip: 'x' })] } }),
    needs: { oracle: { result: 'cancelled' }, test: { result: 'success' } } });
  assert.match(r.note, /\n  DARK: 1 finding\(s\)/);
  assert.match(r.note, /\n  UNOBSERVED: 1 finding\(s\)/);
});

test('gates-ran-in-ci: a gate file is accounted test by test, skips only by name', () => {
  const files = { 'test/a.test.cjs': { jobs: ['oracle'], skips: { 'opt-in row': 'opt-in' } } };
  const ok = G.checkRan(fxRan({ manifest: { files }, records: { oracle: [rec('guard gate: b'), rec('opt-in row', { skip: 'opt-in' })] } }));
  assert.deepStrictEqual(ok.findings, []);
  const bad = G.checkRan(fxRan({ manifest: { files }, records: { oracle: [rec('guard gate: b'), rec('other row', { skip: 'nope' })] } }));
  assert.ok(bad.findings.some((f) => /test\/a.test.cjs: test "other row" skipped \(nope\)/.test(f)), bad.findings.join('\n'));
  assert.ok(bad.findings.some((f) => /the accepted skip "opt-in row" was never reported/.test(f)), bad.findings.join('\n'));
  const none = G.checkRan(fxRan({ manifest: { files }, records: { oracle: [{ ...rec('guard gate: b'), file: '/x/test/other.test.cjs' }] } }));
  assert.ok(none.findings.some((f) => /oracle: no test of test\/a.test.cjs reported/.test(f)), none.findings.join('\n'));
});

test('gates-ran-in-ci: a record\'s file is repo-relative on every runner', () => {
  assert.strictEqual(G.repoFile('/home/runner/work/clode/clode/test/fidelity/x.test.cjs'), 'test/fidelity/x.test.cjs');
  assert.strictEqual(G.repoFile('D:\\a\\clode\\clode\\test\\x.test.cjs'), 'test/x.test.cjs');
  assert.strictEqual(G.repoFile('file:///Users/runner/work/clode/clode/test/x.test.cjs'), 'test/x.test.cjs');
  assert.strictEqual(G.repoFile(undefined), null);
});

test('gates-ran-in-ci: the artifacts are read one dir per job, at any depth; a missing dir is no list', () => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-ran-'));
  try {
    fs.mkdirSync(path.join(root, 'gates-ran-oracle', 'cells'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gates-ran-oracle', 'cells', 'a.jsonl'), `${JSON.stringify(rec('guard gate: b'))}\nnot json\n`);
    const r = G.readRecords(root, fxManifest().jobs);
    assert.strictEqual(r.get('test-ubuntu-latest'), null);
    assert.strictEqual(r.get('oracle').length, 2);
    assert.strictEqual(r.get('oracle')[1].type, 'test:fail', 'an unparseable line is a failure, never dropped');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// THE LIVE SHAPE, not a hand-made record (CI run 44597568635: the static guard and every unit row here were green, and
// the aggregator's first live run went red, because every fixture record named the gate's own file; the real reporter
// names test/guard.cjs for every guardTests() row). This runs node --test under test/cell-reporter.mjs on a file whose
// only tests are a guard, and judges what the reporter really wrote.
test('gates-ran-in-ci: a gate file whose only tests are guards is accounted from the real reporter\'s records', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-ran-live-'));
  try {
    fs.mkdirSync(path.join(base, 'test'));
    const file = path.join(base, 'test', 'fx.test.cjs');
    // (the fixture names the registering function through a variable: guards-population counts every literal
    // call site of it in test/ source as a migrated guard)
    fs.writeFileSync(file, `const g = require(${JSON.stringify(path.join(REPO, 'test', 'guard.cjs'))}); const define = g['define' + 'Guard'];
g.guardTests(define({ name: 'fx-gate', read: () => ({ n: 1 }), scan: ({ n }) => ({ findings: n ? [] : ['x'], examined: 1 }), control: () => ({ n: 0 }) }));
`);
    const out = path.join(base, 'records.jsonl');
    const r = spawnSync(process.execPath, ['--test', `--test-reporter=${require('./esm-href.cjs').esmHref(path.join(REPO, 'test', 'cell-reporter.mjs'))}`, `--test-reporter-destination=${out}`, file],
      // without NODE_TEST_CONTEXT: inside a node:test run it makes the nested --test report to its parent, not to the reporter
      { cwd: base, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
    assert.strictEqual(r.status, 0, r.stderr);
    const records = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(records.some((x) => /guard\.cjs$/.test(x.file)), `the reporter no longer names guard.cjs: ${JSON.stringify(records)}`);
    const verdict = G.checkRan({
      manifest: fxManifest({ placed: { b: { jobs: ['oracle'], why: 'x' }, 'fx-gate': { jobs: ['oracle'], why: 'x' } }, files: { 'test/fx.test.cjs': { jobs: ['oracle'] } } }),
      registry: [...FX_REGISTRY, { name: 'fx-gate', file: 'test/fx.test.cjs' }],
      records: new Map([['test-ubuntu-latest', [rec('guard gate: a'), rec('guard gate: b', { skip: 'x' })]], ['oracle', [rec('guard gate: b'), ...records]]]),
    });
    assert.deepStrictEqual(verdict.findings, []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
