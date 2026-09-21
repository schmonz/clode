'use strict';
// The build graph's SHAPE rules (scripts/build-graph.cjs).
//
// WHY THE RULES LIVE IN THE MODULE, NOT IN THESE TEST BODIES. BACKLOG.md:4595 names the
// disease this graph exists to cure -- "a fourth hand-maintained list of what the build
// does, going stale the same silent way" -- and a shape rule written inline in a test body
// has no seam to feed a known-bad graph through. So build-graph.cjs exports FOUR pure
// finding functions (shapeFindings / danglingFindings / cycleFindings / orphanFindings),
// and both halves of every gate below drive the SAME code: the real graph through
// `read()`, and a synthetic violation through `control()`. That is the phase-5 contract
// (test/guard.cjs) and it is what makes these five rules gates rather than five tests that
// happen to be green.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const G = require('../scripts/build-graph.cjs');

const REPO = path.resolve(__dirname, '..');

test('every step declares the required fields, with functions not literals', () => {
  const steps = G.steps();
  assert.ok(steps.length > 0, 'the graph declares no steps');
  assert.deepStrictEqual(G.shapeFindings(steps), [],
    'a step is missing a required field, or declared a LITERAL where the graph requires a '
    + 'function -- literal input/output lists and literal counts are exactly what rotted '
    + 'NODE_CONSTANTS once and engine-recipe.cjs\'s FILES three times');
});

test('gate 5: no orphans — every step is reachable from the root', () => {
  const orphans = G.orphanFindings(G.steps());
  assert.deepStrictEqual(orphans, [],
    `unreachable steps accumulate and the diagram lies by addition: ${orphans}`);
});

test('every `needs` names a step that exists', () => {
  const dangling = G.danglingFindings(G.steps());
  assert.deepStrictEqual(dangling, [], `dangling edges: ${dangling}`);
});

test('the graph is acyclic', () => {
  const cycles = G.cycleFindings(G.steps());
  assert.deepStrictEqual(cycles, [], `cycles: ${cycles}`);
});

test('orderedSteps returns dependencies before dependents', () => {
  const order = G.orderedSteps({ runsOn: 'host' }).map((s) => s.id);
  assert.ok(order.length > 0, 'orderedSteps({runsOn:"host"}) selected nothing — a filter '
    + 'that matches no step is a blind pass, not an ordering proof');
  const pos = new Map(order.map((id, i) => [id, i]));
  for (const s of G.steps()) {
    if (!pos.has(s.id)) continue;
    for (const n of s.needs) if (pos.has(n)) assert.ok(pos.get(n) < pos.get(s.id), `${n} must precede ${s.id}`);
  }
});

// ROOT_ID is the interface Task 2's runner and Task 6's call-site gate both address, so
// "it names a real step" is a property, not a comment. And the root is what `./build`
// builds: nothing may DEPEND on it, or the thing a developer asked for is not the end of
// the build.
test('ROOT_ID names a real step, and nothing depends on it', () => {
  const root = G.stepById(G.ROOT_ID);
  assert.ok(root, `ROOT_ID '${G.ROOT_ID}' names no declared step`);
  const dependents = G.steps().filter((s) => s.needs.includes(G.ROOT_ID)).map((s) => s.id);
  assert.deepStrictEqual(dependents, [],
    `${G.ROOT_ID} is the artifact ./build produces, so nothing may need it: ${dependents}`);
  assert.ok(G.orderedSteps().map((s) => s.id).includes(G.ROOT_ID),
    'the default ordering does not reach the root — ./build would build everything except '
    + 'the thing it exists to build');
});

// Every step is reached from the root by walking `needs` BACKWARDS. Gate 5 above proves no
// step is stranded off the front of the graph; this proves none is stranded off the back —
// a step nothing transitively needs is work `./build` would never do.
test('every step is in the root\'s dependency closure', () => {
  const byId = new Map(G.steps().map((s) => [s.id, s]));
  const seen = new Set();
  const up = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const n of (byId.get(id) || { needs: [] }).needs) up(n);
  };
  up(G.ROOT_ID);
  const stranded = G.steps().map((s) => s.id).filter((id) => !seen.has(id));
  assert.deepStrictEqual(stranded, [],
    `declared but never built: ${stranded} — either wire them into the root's closure or `
    + 'delete them; a step no build reaches is a lie the diagram will draw');
});

// The 42 legs are ONE graph parameterized by target, never 42 graphs. The parameter is
// real only if it can CHANGE something, so this holds `runsOn` to the leg manifest: at
// least one leg must resolve a step somewhere other than the host, or `runsOn` is
// decoration and the fleet view is a drawing.
//
// DISTINCTNESS, not length. The first cut asserted `targets('release').length === 42` and
// passed only BY COUNTING DUPLICATES: canonical-name.cjs's targetName() drops the libc
// qualifier, so the two riscv64 legs and the two s390x legs each collapse onto one name,
// and a Map keyed on that name silently kept the last of each pair. The length assertion
// was asserting the bug. Legs are keyed by their own token now, and both halves are pinned
// here: the tokens are unique, the names are unique after collapsing, and there are FEWER
// names than legs — that last one is what keeps the collision rule below from being
// untested the day the twins go away.
test('the graph is parameterized by leg, and the parameter bites', () => {
  const legs = G.legs('release');
  assert.strictEqual(legs.length, 42,
    `expected the 42 release legs from scripts/tjs-legs.mjs, got ${legs.length}`);
  assert.strictEqual(new Set(legs).size, legs.length,
    `leg tokens must be distinct — they are the key: ${legs.join(',')}`);

  const targets = G.targets('release');
  assert.strictEqual(new Set(targets).size, targets.length,
    `targets() must return DISTINCT names, not one per leg: ${targets.join(',')}`);
  assert.ok(targets.length < legs.length,
    'no canonical target name collapses two legs any more, so the disagreement refusal '
    + 'below guards a case that cannot arise — re-derive it or delete it, do not leave a '
    + 'rule nothing can reach');

  const homes = new Set();
  for (const leg of legs) for (const s of G.steps({ target: leg })) homes.add(s.runsOn);
  assert.ok(homes.size > 1,
    `every step of every leg resolved to the same machine (${[...homes]}) — runsOn cannot `
    + 'then express the class of bug it exists for (a step resolving for the wrong machine)');
});

// A collapsed name selects BOTH legs, and while they agree it still answers. This is the
// pair the old Map answered for by accident; now it answers on purpose.
test('a canonical target naming two legs answers only while they agree', () => {
  const selected = G.legsNamed('linux-riscv64', 'release').map((l) => l.leg).sort();
  assert.deepStrictEqual(selected, ['linux-riscv64', 'linux-riscv64-musl'],
    'the musl/glibc twins no longer collapse onto one canonical name — this test names the '
    + 'pair it was written for, so re-derive it rather than deleting the coverage');
  assert.strictEqual(G.stepById('engine.compile').runsOn, 'host');
  assert.strictEqual(
    G.steps({ target: 'linux-riscv64' }).find((s) => s.id === 'engine.compile').runsOn,
    'container', 'both riscv64 legs cross-build in a container; the collapsed name must say so');
});

// An unknown name has no leg descriptor, so the graph can only say "wherever you are". That
// is honest; silently inventing a machine for it would not be.
test('a name the manifest does not know falls back to the native answer', () => {
  const s = G.steps({ target: 'plan9-mips' });
  assert.deepStrictEqual(s.map((x) => x.runsOn), G.steps().map((x) => x.runsOn));
});

// FINDING 1 (review round 1). `defaultContext().out` used to restate libexec/
// clode-build.cjs's resolveBuildOut rule and keyed `.exe` off the HOST, while the real rule
// keys it off the TARGET — so a windows cross-build declared `clode-native` for a build that
// writes `clode-native.exe`, and Task 4's "did the declared output appear?" check would have
// red on the graph rather than on the build. Composed now, and pinned in both directions so
// a future restatement cannot pass.
test('the declared output name comes from resolveBuildOut, keyed on TARGET not host', () => {
  const { resolveBuildOut } = require('../libexec/clode-build.cjs');
  for (const target of ['macos-arm64', 'linux-amd64', 'windows-amd64', 'windows-arm64']) {
    assert.strictEqual(G.defaultContext({ target }).out,
      resolveBuildOut({ target, self: true, hostPlatform: process.platform }),
      `${target}: the graph's declared output name disagrees with the function clode `
      + 'bootstrap actually calls');
  }
  assert.strictEqual(G.defaultContext({ target: 'windows-amd64' }).out, 'clode-native.exe',
    'a windows TARGET must carry .exe whatever host this test runs on');
  assert.strictEqual(G.defaultContext({ target: 'linux-amd64' }).out, 'clode-native',
    'a non-windows TARGET must NOT carry .exe, even on a windows host');
  // An explicit --out is resolveBuildOut's business too: it gains .exe for a windows target.
  assert.strictEqual(G.defaultContext({ target: 'windows-amd64', out: 'mine' }).out, 'mine.exe');
  assert.strictEqual(path.basename(G.stepById(G.ROOT_ID).outputs({ target: 'windows-amd64' })[0]),
    'clode-native.exe', 'the ROOT step must DECLARE the file the build actually writes');
});

// FINDING 2 (review round 1). The bundle step's non-libexec inputs are read out of the
// emitter, not listed. The proof that the derivation is live rather than merely non-empty:
// it must name the one the hand list had already missed.
test('the bundle step derives its repo inputs from the emitter, including the one a hand list missed', () => {
  const rels = G.bundleInputs(G.defaultContext()).filter((p) => !p.startsWith('libexec/'));
  const emitter = fs.readFileSync(path.join(REPO, G.EMITTER_REL), 'utf8');
  for (const rel of rels) {
    assert.ok(emitter.includes(`'${rel.split('/').pop()}'`) || emitter.includes(`'${rel}'`),
      `${rel} is declared an input but ${G.EMITTER_REL} never names it — the derivation is `
      + 'reading something else');
  }
  assert.ok(rels.includes('scripts/engine-recipe.cjs'),
    'build-clode-main.mjs runs scripts/engine-recipe.cjs to bake __CLODE_BAKED_ENGINE_RECIPE__, '
    + 'and the hand-written list this replaced had missed it. If the emitter stopped baking '
    + 'the recipe, re-derive this expectation; do not drop it.');
  assert.ok(rels.includes('VERSION') && rels.includes('spike/quickjs/PINS.md'),
    `the derivation lost a known define input: ${rels.join(',')}`);
});

// THE CONSTRAINT THAT MAKES A NODE-FREE `./build` POSSIBLE, proven by running it rather
// than by reading the file for `import`. The graph has to be loadable by
// libexec/node-shim/loader.cjs under tjs -- CommonJS, no top-level await, no import.meta --
// because the developer entry point resolves an engine through scripts/bootstrap-engine.sh
// and runs the graph under it, on machines with no node at all. scripts/stage0.mjs is the
// cautionary case this pins: `import.meta` outside Module goal is an EARLY parse error, so
// an ESM graph could not even load far enough to report its own failure. A lint for ESM
// syntax would miss the interesting half (a transitive require that is ESM); actually
// booting it does not.
const TJS = tjsPath();
test('the graph loads and answers under tjs, through the node-shim loader', (t) => {
  if (!TJS || !fs.existsSync(TJS)) {
    t.skip('no engine: neither CLODE_TJS nor the platform-tagged scratch engine '
      + '(node-shim-helper tjsPath()) resolves to an existing binary. Build one with '
      + '`node scripts/build-tjs.cjs`, or set CLODE_TJS=<path to a tjs binary>.');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-graph-'));
  const probe = path.join(dir, 'probe.cjs');
  // Deliberately reaches the LAZY requires too, not just the module body: defaultContext()
  // composes libexec/clode-build.cjs's resolveBuildOut, and bundleInputs() reads the
  // emitter. A probe that only touched orderedSteps() would prove the file parses and
  // nothing about what happens when the graph is actually asked something.
  fs.writeFileSync(probe,
    `const G = require(${JSON.stringify(path.join(REPO, 'scripts', 'build-graph.cjs'))});\n`
    + 'const ctx = G.defaultContext();\n'
    + 'console.log(G.ROOT_ID + " " + G.orderedSteps().map((s) => s.id).join(","));\n'
    + 'console.log(ctx.out);\n'
    + "console.log(G.bundleInputs(ctx).filter((p) => p.indexOf('libexec/') !== 0).join(','));\n");
  const out = execFileSync(TJS, ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'), probe],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n');
  const ctx = G.defaultContext();
  assert.strictEqual(out[0], `${G.ROOT_ID} ${G.orderedSteps().map((s) => s.id).join(',')}`,
    'the graph answered differently under tjs than under node — the declaration is not the '
    + 'same declaration on the engine the developer build actually runs it under');
  assert.strictEqual(out[1], ctx.out,
    'the declared output name differs under tjs — resolveBuildOut is composed lazily, and '
    + 'this is the half a parse-only probe would miss');
  assert.strictEqual(out[2],
    G.bundleInputs(ctx).filter((p) => p.indexOf('libexec/') !== 0).join(','),
    'the emitter-derived inputs differ under tjs');
});

// ---- the controls: each rule, proven able to fail, on a synthetic graph ----------------
//
// The fixtures are deliberately minimal objects, not real steps: a control's job is to
// contain the ONE violation its rule claims to detect, and a control built out of the real
// graph could only be made bad by corrupting the real graph.

const shapeGuard = defineGuard({
  name: 'build-graph shape',
  read: () => G.steps(),
  scan: (steps) => ({ findings: G.shapeFindings(steps), examined: steps.length }),
  // A literal array where the graph requires a function. This is THE violation the rule
  // exists for: `inputs: ['a', 'b']` reads fine, runs fine, and silently stops tracking
  // the single source of truth it was supposed to compose.
  control: () => [{
    id: 'fixture.literal-inputs',
    phase: 'fixture',
    runsOn: 'host',
    needs: [],
    inputs: ['scripts/build-tjs.cjs'],
    outputs: () => [],
    run: () => {},
  }],
});

const danglingGuard = defineGuard({
  name: 'build-graph dangling edges',
  read: () => G.steps(),
  scan: (steps) => ({ findings: G.danglingFindings(steps), examined: steps.length }),
  control: () => [
    { id: 'fixture.one', needs: [] },
    { id: 'fixture.two', needs: ['fixture.renamed-away'] },
  ],
});

const acyclicGuard = defineGuard({
  name: 'build-graph acyclicity',
  read: () => G.steps(),
  scan: (steps) => ({ findings: G.cycleFindings(steps), examined: steps.length }),
  control: () => [
    { id: 'fixture.one', needs: ['fixture.two'] },
    { id: 'fixture.two', needs: ['fixture.one'] },
  ],
});

const orphanGuard = defineGuard({
  name: 'build-graph orphans',
  read: () => G.steps(),
  scan: (steps) => ({ findings: G.orphanFindings(steps), examined: steps.length }),
  // fixture.two/three need each other, so no source step ever reaches them: unreachable
  // WITHOUT any dangling edge, so this control isolates gate 5 from the dangling rule.
  control: () => [
    { id: 'fixture.one', needs: [] },
    { id: 'fixture.two', needs: ['fixture.three'] },
    { id: 'fixture.three', needs: ['fixture.two'] },
  ],
});

// Shape says `inputs` is a function; this says the function ANSWERS. A derivation that
// silently stopped composing its single source of truth -- the whole failure mode the
// function-not-literal rule exists to prevent -- would still pass the shape rule and fail
// here.
const evaluationGuard = defineGuard({
  name: 'build-graph derivations answer',
  read: () => G.evaluate(),
  scan: (records) => ({ findings: G.evaluationFindings(records), examined: records.length }),
  control: () => [
    { id: 'fixture.empty-inputs', inputs: [], outputs: ['/tmp/x'], count: undefined },
    { id: 'fixture.relative-output', inputs: ['/tmp/x'], outputs: ['build/bundle/x.cjs'], count: undefined },
    { id: 'fixture.zero-count', inputs: ['/tmp/x'], outputs: ['/tmp/y'], count: 0 },
  ],
});

// THE RULE THAT PROTECTS THE ENGINE RECIPE, as a gate. Read the real scripts/build-tjs.cjs
// and the real expanded recipe set: a require added there would move the recipe hash and
// rebuild all 42 legs for a change that alters no engine source.
const recipeCouplingGuard = defineGuard({
  name: 'build-graph stays out of the engine recipe',
  read: () => ({
    buildTjsSource: fs.readFileSync(path.join(REPO, 'scripts', 'build-tjs.cjs'), 'utf8'),
    recipeFiles: G.recipeFiles(),
  }),
  scan: (inputs) => ({
    findings: G.recipeCouplingFindings(inputs),
    // The source plus every file the recipe covers: an `examined` of 1 would read the same
    // whether the recipe expanded to fifty files or to none.
    examined: 1 + inputs.recipeFiles.length,
  }),
  control: () => ({
    buildTjsSource: "'use strict';\nconst { steps } = require('./build-graph.cjs');\n",
    recipeFiles: ['scripts/build-tjs.cjs', 'scripts/build-graph.cjs'],
  }),
  floor: 2,
});

guardTests(shapeGuard);
guardTests(danglingGuard);
guardTests(acyclicGuard);
guardTests(orphanGuard);
guardTests(evaluationGuard);
guardTests(recipeCouplingGuard);

// ---- the runner (scripts/build-runner.cjs) ----------------------------------------------
//
// Task 2: running the build FROM the declaration, checking every step's declared boundary.
// The declaration above says what each step consumes and produces; these say that a run
// which violates that declaration STOPS, and that the stop names the path. Every rule here
// is driven through a SYNTHETIC graph carrying exactly one violation -- the same
// control-first contract test/guard.cjs imposes on the file scanners, applied to a runtime
// refusal: a boundary check nobody has watched fire is not a check.

const R = require('../scripts/build-runner.cjs');

// The fixtures. Deliberately minimal steps, not real ones: a control's job is to contain
// the ONE violation its rule claims to detect.
const ABSENT = path.join(os.tmpdir(), 'clode-build-runner-definitely-not-present');

// The gates below all turn on this path NOT existing. If something ever creates it, every
// one of them goes quietly green while checking nothing — the blind-pass shape, arriving
// through the fixture rather than through the code under test.
test('the controls\' absent path really is absent', () => {
  assert.strictEqual(fs.existsSync(ABSENT), false,
    `${ABSENT} exists, so every boundary control below would pass without checking anything`);
});

function fixture(over) {
  return Object.assign({
    id: 'x.one', phase: 'x', runsOn: 'host', needs: [],
    inputs: () => [], outputs: () => [], run: () => {},
  }, over);
}

// Never touches the real trace log (~/.local/share/clode/build-trace.jsonl): a suite that
// appends to the developer's durable timing history would poison the very record this step
// exists to make trustworthy.
function scratchTrace() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clode-runner-trace-')), 'build-trace.jsonl');
}

function runFixture(opts) {
  return R.runGraph(Object.assign({ traceLog: scratchTrace(), logFn: () => {} }, opts));
}

test('gate 1: the runner refuses an id the graph does not declare', () => {
  assert.throws(() => runFixture({ only: 'not.a.step', dryRun: true }),
    /not a declared step/i,
    'a typo in --only must stop the build, not silently select nothing and report success');
});

test('gate 1: the refusal also fires against a synthetic graph', () => {
  assert.throws(() => runFixture({ graph: [fixture({})], only: 'x.nope', dryRun: true }),
    /not a declared step/i);
});

test('gate 2: a step whose declared OUTPUT does not appear fails the run', () => {
  assert.throws(
    () => runFixture({ graph: [fixture({ outputs: () => [ABSENT] })], only: 'x.one' }),
    /declared output.*did not appear/i,
    'a step that exits 0 without writing what it promised is the silent-producer failure '
    + 'the naude cli.cjs incident cost two minutes of runtime path checking to notice');
});

test('gate 2: the output refusal names the path', () => {
  assert.throws(
    () => runFixture({ graph: [fixture({ outputs: () => [ABSENT] })], only: 'x.one' }),
    (e) => e.message.includes(ABSENT));
});

test('gate 2: a step whose declared INPUT is missing fails before it runs', () => {
  let ran = false;
  const fake = [fixture({ id: 'x.two', inputs: () => [ABSENT], run: () => { ran = true; } })];
  assert.throws(() => runFixture({ graph: fake, only: 'x.two' }), /declared input.*missing/i);
  assert.strictEqual(ran, false, 'the step must not run when its inputs are absent');
});

test('the runner records a timing per step it ran', () => {
  let t = 0;
  const out = runFixture({ graph: [fixture({ id: 'x.three' })], only: 'x.three', nowFn: () => (t += 5) });
  assert.deepStrictEqual(out.ran, ['x.three']);
  assert.strictEqual(out.timings.length, 1);
  assert.strictEqual(out.timings[0].id, 'x.three');
  assert.strictEqual(out.timings[0].ms, 5, 'elapsed comes from nowFn, not the clock');
});

// `only` is a SUBGRAPH selector, not a single-step selector: asking for the engine must
// build what the engine needs. A runner that ran the named step alone would fail on its
// declared inputs, or worse, succeed against a stale tree.
test('only selects the step and its transitive needs, in dependency order', () => {
  const out = R.runGraph({ only: 'engine.compile', dryRun: true, logFn: () => {} });
  assert.deepStrictEqual(out.ran, ['engine.source', 'engine.bytecode', 'engine.compile']);
});

test('the default run reaches the root, in dependency order', () => {
  const out = R.runGraph({ dryRun: true, logFn: () => {} });
  assert.deepStrictEqual(out.ran, G.orderedSteps().map((s) => s.id));
  assert.ok(out.ran.includes(G.ROOT_ID));
});

// A dry run must not execute and must not judge: the outputs of a build that has not run
// are absent BY CONSTRUCTION, so checking them would make --plan red on a clean checkout.
test('a dry run neither runs a step nor judges its boundary', () => {
  let ran = false;
  const fake = [fixture({ inputs: () => [ABSENT], outputs: () => [ABSENT], run: () => { ran = true; } })];
  const out = runFixture({ graph: fake, only: 'x.one', dryRun: true });
  assert.strictEqual(ran, false);
  assert.deepStrictEqual(out.ran, ['x.one']);
});

test('runsOn narrows the run to one machine', () => {
  const fake = [fixture({ id: 'x.here' }), fixture({ id: 'x.there', runsOn: 'guest' })];
  const out = runFixture({ graph: fake, runsOn: 'guest' });
  assert.deepStrictEqual(out.ran, ['x.there']);
});

// The house line, in the shape build-tjs's `ccache:`/`ar-determinism:` verdicts already
// use. A build whose steps are invisible in a piped log is a build nobody can diff.
test('every step it runs prints one greppable line in house style', () => {
  const lines = [];
  let t = 0;
  runFixture({
    graph: [fixture({ id: 'x.counted', count: () => 7 })],
    only: 'x.counted', nowFn: () => (t += 12), logFn: (l) => lines.push(l),
  });
  assert.deepStrictEqual(lines,
    ['build-graph: step=x.counted phase=x runsOn=host ms=12 count=7']);
});

// FINDING 3 (review round 1). The line used to render `count=<n>/<n>` — a ratio that is
// ALWAYS 1, because it is printed once, after the step finished, and the graph stops at STEP
// granularity so no partial numerator exists to report. A fraction that can never be
// anything but 1/1 reads as progress and carries none; BACKLOG.md:4686 asks for an honest
// denominator, not a fake percentage. Pinned as a rule rather than as one expected string,
// so the tautology cannot come back for a step nobody wrote a literal for.
test('no step line renders a ratio that is always 1', () => {
  const lines = [];
  R.runGraph({ dryRun: true, logFn: (l) => lines.push(l) });
  assert.ok(lines.length > 1, 'a one-line sample cannot show a rule holding');
  for (const l of lines) {
    const count = l.slice(l.indexOf('count=') + 'count='.length);
    assert.doesNotMatch(count, /^(\d+)\/\1$/,
      `${l} — count=n/n is a fake percentage: this line prints once, after the step is done, `
      + 'so the numerator can only ever equal the denominator');
  }
  assert.ok(lines.some((l) => /count=\d+$/.test(l)),
    'no step reported a derived denominator at all, so this rule proved nothing');
});

test('a step with no derived count says so rather than inventing one', () => {
  const lines = [];
  runFixture({ graph: [fixture({})], only: 'x.one', nowFn: () => 0, logFn: (l) => lines.push(l) });
  assert.deepStrictEqual(lines, ['build-graph: step=x.one phase=x runsOn=host ms=0 count=-']);
});

// BACKLOG.md:4686 asks for "every step's elapsed time written where a piped/CI build keeps
// it, so a regression is a diff and not a feeling". libexec/build-trace.cjs is ALREADY that
// record (one JSON line per build, Chrome-trace step shape, refusing a run with no
// interpreter recorded) and `clode build` already writes it, so the graph runner composes it
// rather than inventing a second timing format that would immediately disagree with the
// first.
test('the run is appended to the durable timing record', () => {
  const log = scratchTrace();
  let t = 0;
  R.runGraph({
    graph: [fixture({ id: 'x.timed', phase: 'engine', count: () => 3 })],
    only: 'x.timed', nowFn: () => (t += 9), traceLog: log, logFn: () => {},
  });
  const runs = require('../libexec/build-trace.cjs').readRuns(log);
  assert.strictEqual(runs.length, 1, 'one line per run');
  assert.deepStrictEqual(runs[0].steps, [{
    component: 'engine', name: 'x.timed', total: 3, done: 3, elapsedMs: 9, state: 'finished',
  }]);
  assert.ok(runs[0].meta.interpreter, 'a timing with no interpreter is not comparable');
  assert.strictEqual(runs[0].meta.target, G.defaultContext().target);
});

// A FAILED run's partial timings are real data too — and the failing step is recorded as
// what it was. This is the half that turns "it got slower, then it broke" into a diff.
test('a failed run still records the steps that ran, and names the one that did not finish', () => {
  const log = scratchTrace();
  const fake = [fixture({ id: 'x.boom', run: () => { throw new Error('boom'); } })];
  assert.throws(() => R.runGraph({ graph: fake, only: 'x.boom', nowFn: () => 0, traceLog: log, logFn: () => {} }),
    /boom/);
  const runs = require('../libexec/build-trace.cjs').readRuns(log);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].steps[0].state, 'failed');
});

// FINDING 1 (review round 1, Important). The record must not call a boundary failure
// "finished". The green line, the timing and the trace entry all used to be written from a
// `finally` that ran BEFORE checkOutputs, so a step that exited 0 and wrote nothing printed a
// normal green line and landed in build-trace.jsonl as `finished` — and was only then
// refused. That is the silent-producer shape this gate exists for, reintroduced in the record
// of the gate firing. Read the trace, not just the throw: the throw was already correct.
test('a step that exits 0 and writes nothing is recorded as FAILED, not finished', () => {
  const log = scratchTrace();
  const fake = [fixture({ id: 'x.liar', count: () => 4, outputs: () => [ABSENT] })];
  assert.throws(
    () => R.runGraph({ graph: fake, only: 'x.liar', nowFn: () => 0, traceLog: log, logFn: () => {} }),
    /declared output.*did not appear/i);
  const runs = require('../libexec/build-trace.cjs').readRuns(log);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].steps[0].state, 'failed',
    'the durable history disagreed with the build\'s own verdict — the next person to diff '
    + 'this log would read a step that produced nothing as a step that worked');
  assert.strictEqual(runs[0].steps[0].done, 0,
    'a step that did not produce its outputs completed none of its declared units');
});

test('a step refused by the output check prints no green line and is not in `ran`', () => {
  const lines = [];
  const fake = [fixture({ id: 'x.liar', outputs: () => [ABSENT] })];
  let out;
  try {
    out = runFixture({ graph: fake, only: 'x.liar', nowFn: () => 0, logFn: (l) => lines.push(l) });
  } catch { /* the refusal itself is pinned above */ }
  assert.strictEqual(out, undefined);
  assert.deepStrictEqual(lines, [],
    'a build whose log shows a green step line for a step that produced nothing is a log that '
    + 'lies in exactly the direction the reader will trust');
});

// FINDING 2 (review round 1, Important). Gate 1 had a second door: `--only` was validated and
// `--runs-on` was not, so a typo selected nothing and exited 0 — the same "select nothing,
// report success" blind pass, reached through the other argument.
test('gate 1: the runner refuses a machine the graph does not declare', () => {
  assert.throws(() => R.runGraph({ runsOn: 'nonsense-machine', dryRun: true, logFn: () => {} }),
    /not a declared machine/i);
  for (const where of G.RUNS_ON) {
    assert.doesNotThrow(() => R.runGraph({
      graph: [fixture({ runsOn: where })], runsOn: where, dryRun: true, logFn: () => {},
    }), `${where} is in G.RUNS_ON and must be accepted — a refusal that rejects the whole `
      + 'vocabulary is not a typo check, it is an outage');
  }
});

// And the combination neither name-check can see: a real step and a real machine that select
// nothing together. Task 1's orderedSteps test already guards this shape ("a filter that
// matches no step is a blind pass, not an ordering proof"); the same rule belongs where a
// build acts on it.
test('gate 1: a selection that matches no step is refused, not reported as success', () => {
  assert.throws(
    () => R.runGraph({ only: 'engine.compile', runsOn: 'guest', dryRun: true, logFn: () => {} }),
    /matched no step/i,
    'engine.compile runs on the host for this target, so --runs-on guest selects nothing — '
    + 'and an empty plan that exits 0 is indistinguishable from a build that worked');
  assert.throws(() => runFixture({ graph: [fixture({})], runsOn: 'guest', dryRun: true }),
    /matched no step/i);
});

// THE INJECTION, PROVEN ON THE REAL GRAPH AND NOT ONLY ON FIXTURES. A synthetic step's
// `run` never shells out, so passing execFileSyncFn through fixtures alone would prove
// nothing about whether the DECLARED steps honour it — and a runner whose "tests never
// spawn" promise holds only for graphs that never spawn anyway is decoration. Both
// directions, because only the pair distinguishes "the injection is used" from "nothing ran
// at all": with no injection the real execFileSync runs and the marker file appears.
//
// WHAT IT SPAWNS, AND WHY IT IS NOT A SHELL. The un-injected half has to REALLY spawn or the
// injected half proves nothing — and the first spelling of that half spawned `/bin/sh -c`,
// which is the fifth POSIX-sh-on-Windows red this repo has taken (CI run 35613236035,
// `not ok 243`): win32 resolves that absolute POSIX path as `<drive>:\bin\sh`, CreateProcess
// answers ENOENT, and execFileSync THROWS before any assertion is reached. But nothing about
// this seam is about shells — sh() is named for the call it replaces, not for a program it
// must run — so the honest fix is not test/posix-host.cjs's skip, it is to stop assuming the
// POSIX fact at all: `process.execPath` is an executable that exists on every platform this
// suite runs on, Windows included, and it writes the marker with no shell in the picture. So
// this case still RUNS on the Windows leg, which is worth strictly more than a stated skip;
// posix-host.cjs stays for the cases that genuinely drive a `#!/bin/sh` script. The marker
// travels as an ARGV element rather than interpolated into the `-e` source, so a Windows temp
// path's backslashes are never a quoting question.
test('a step shells out through the CONTEXT\'s exec, so an injected one really replaces it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-runner-exec-'));
  const marker = path.join(dir, 'ran');
  const spawnArgs = ['-e', 'require("fs").writeFileSync(process.argv[1], "x")', marker];
  const ctx = G.defaultContext({ repo: REPO });
  // Not injected: the real execFileSync runs the command.
  G.sh(ctx, process.execPath, spawnArgs);
  assert.ok(fs.existsSync(marker), 'the un-injected path must really spawn — otherwise the '
    + 'test below proves nothing, because nothing would have run either way');
  fs.rmSync(marker);
  const calls = [];
  G.sh(Object.assign({}, ctx, { execFileSync: (f, a) => { calls.push([f, a]); } }),
    process.execPath, spawnArgs);
  assert.strictEqual(fs.existsSync(marker), false, 'the injected exec was bypassed');
  assert.deepStrictEqual(calls, [[process.execPath, spawnArgs]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runGraph threads execFileSyncFn into the context the steps resolve against', () => {
  const seen = [];
  runFixture({
    graph: [fixture({ run: (ctx) => { seen.push(typeof ctx.execFileSync); } })],
    only: 'x.one',
    execFileSyncFn: () => {},
  });
  assert.deepStrictEqual(seen, ['function']);
});

// Same constraint, same proof method, as the graph's own tjs test above: the developer
// build resolves a tjs and runs the RUNNER under it, so a top-level `await`, an `import`,
// or an `import.meta` here would be an early parse error on exactly the machines that have
// no node. `--help` is the cheapest whole-program exercise that still reaches the lazy
// requires a parse-only probe would miss.
test('the runner loads and answers under tjs, through the node-shim loader', (t) => {
  if (!TJS || !fs.existsSync(TJS)) {
    t.skip('no engine: neither CLODE_TJS nor the platform-tagged scratch engine resolves');
    return;
  }
  const out = execFileSync(TJS,
    ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'),
      path.join(REPO, 'scripts', 'build-runner.cjs'), '--help'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /--only/, 'the runner\'s own usage must reach stdout under tjs');
});

function planUnderTjs(args) {
  return execFileSync(TJS,
    ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'),
      path.join(REPO, 'scripts', 'build-runner.cjs')].concat(args),
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split('\n').filter((l) => l.indexOf('build-graph: step=') === 0);
}

test('the runner plans under tjs exactly as it plans under node', (t) => {
  if (!TJS || !fs.existsSync(TJS)) {
    t.skip('no engine: neither CLODE_TJS nor the platform-tagged scratch engine resolves');
    return;
  }
  const lines = [];
  R.runGraph({ only: 'bundle.clode-main', dryRun: true, logFn: (l) => lines.push(l) });
  assert.deepStrictEqual(planUnderTjs(['--plan', '--only', 'bundle.clode-main']), lines,
    'the runner planned a different build under tjs than under node — including the derived '
    + 'count, which is the half a parse-only probe would miss');
  assert.match(lines[0], /count=\d+$/,
    'this proof is only worth running while the selected step HAS a derived count to get wrong');
});

// THE ENGINE PHASE, PLANNED UNDER TJS. This is what the tripwire that used to stand here
// was waiting for. Until 2026-09-21 `engine.source`'s inputs/count and `engine.compile`'s
// inputs were UNANSWERABLE under the shim: they are compositions of the engine recipe, the
// recipe was ESM using `import.meta`, and libexec/node-shim/loader.cjs is a CJS host — so a
// `./build` running under tjs stopped dead at the first engine step and a node-free
// developer build was impossible. The recipe is CommonJS now
// (scripts/engine-recipe.cjs), and this is the positive assertion the tripwire was standing
// in for: the whole graph, engine phase included, plans identically under both engines.
//
// WHY THE COUNT, NOT JUST THE PARSE. `engine.source`'s count is patchCount(), which is
// recipeFiles() filtered — i.e. it needs the recipe to actually EXPAND its globs under the
// shim, which needs `git ls-files` through the shim's sync spawn. A probe that only proved
// the module loads would pass on a recipe that silently answered zero, and a zero count is
// precisely the blindness scripts/engine-recipe.cjs's expand() refuses. So the count is
// asserted against node's answer, digit for digit.
test('the engine phase plans under tjs, count and all, exactly as it plans under node', (t) => {
  if (!TJS || !fs.existsSync(TJS)) {
    t.skip('no engine: neither CLODE_TJS nor the platform-tagged scratch engine resolves');
    return;
  }
  const lines = [];
  R.runGraph({ dryRun: true, logFn: (l) => lines.push(l) });
  const engineLines = lines.filter((l) => / phase=engine /.test(l));
  assert.ok(engineLines.length >= 2,
    'this proof is only worth running while the graph HAS an engine phase to plan');
  assert.deepStrictEqual(planUnderTjs(['--plan']), lines,
    'the runner planned a different build under tjs than under node. The engine steps derive '
    + 'their inputs and counts from scripts/engine-recipe.cjs; if this says a step "could not '
    + 'resolve", that file (or something it now reaches) is no longer hostable by the CJS '
    + 'node-shim loader, and the node-free `./build` is broken again.');
  const source = lines.find((l) => l.indexOf('step=engine.source ') !== -1);
  assert.match(source, /count=\d+$/,
    'engine.source must still carry a DERIVED count here — it is the half that proves the '
    + 'recipe expanded its globs under the shim rather than merely parsing');
  assert.ok(Number(source.match(/count=(\d+)$/)[1]) > 1, 'the derived patch count collapsed');
});

// The control for that wrapping, on a synthetic graph: a derivation that throws for ANY
// reason is reported against the step that owns it, with the cause quoted rather than
// swallowed.
test('a derivation that refuses is reported against the step that asked, cause and all', () => {
  const fake = [fixture({ inputs: () => { throw new Error('the source of truth said no'); } })];
  assert.throws(() => runFixture({ graph: fake, only: 'x.one' }), (e) => {
    assert.match(e.message, /x\.one could not resolve its declared inputs/);
    assert.match(e.message, /the source of truth said no/);
    return true;
  });
});

// A caller-supplied context must not be silently re-resolved for THIS HOST by the merge
// that folds runGraph's own options over it. defaultContext falls back per field on
// falsiness, so `Object.assign({}, context, { target: undefined })` would have answered for
// the wrong machine — the exact class runsOn exists to express, reintroduced one layer up.
test('an explicit context survives the option merge', () => {
  const seen = [];
  runFixture({
    graph: [fixture({ run: (ctx) => seen.push(ctx.target) })],
    only: 'x.one',
    context: { target: 'windows-amd64' },
  });
  assert.deepStrictEqual(seen, ['windows-amd64']);
});
