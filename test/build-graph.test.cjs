'use strict';
// The build graph's SHAPE rules (scripts/build-graph.cjs).
//
// WHY THE RULES LIVE IN THE MODULE, NOT IN THESE TEST BODIES. BACKLOG.md's "name the
// steps, show how done we are" item names the disease this graph exists to cure -- "a
// fourth hand-maintained list of what the build does, going stale the same silent way" --
// and a shape rule written inline in a test body
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
const { execFileSync, spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { shTest, committedExecBit } = require('./posix-host.cjs');
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

test('gate 5: no orphans — every step is in the root\'s dependency closure', () => {
  const orphans = G.orphanFindings(G.steps());
  assert.deepStrictEqual(orphans, [],
    `declared but never built: ${orphans} — either wire them into the root's closure or `
    + 'delete them; a step no build reaches is work `./build.sh` never does and a lie the '
    + 'diagram will draw');
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
// "it names a real step" is a property, not a comment. And the root is what `./build.sh`
// builds: nothing may DEPEND on it, or the thing a developer asked for is not the end of
// the build.
test('ROOT_ID names a real step, and nothing depends on it', () => {
  const root = G.stepById(G.ROOT_ID);
  assert.ok(root, `ROOT_ID '${G.ROOT_ID}' names no declared step`);
  const dependents = G.steps().filter((s) => s.needs.includes(G.ROOT_ID)).map((s) => s.id);
  assert.deepStrictEqual(dependents, [],
    `${G.ROOT_ID} is the artifact ./build.sh produces, so nothing may need it: ${dependents}`);
  assert.ok(G.orderedSteps().map((s) => s.id).includes(G.ROOT_ID),
    'the default ordering does not reach the root — ./build.sh would build everything except '
    + 'the thing it exists to build');
});

// The root-closure walk that USED TO LIVE HERE, as a plain control-less test, is now what
// orphanFindings() itself computes (final whole-branch review, finding 3): the real RED was
// coming from this test while the guard that carried the name was vacuous. Keeping a second
// copy of the walk would restate the rule the module now owns — the disease this whole file
// is a reaction to — so gate 5 above and orphanGuard below are the two halves, and this is
// the refusal that keeps the walk from answering about a root it was never given.
test('orphanFindings refuses a root that is not in the graph it was handed', () => {
  assert.throws(() => G.orphanFindings(G.steps(), 'clode.typoed'), (e) => {
    assert.match(e.message, /clode\.typoed/);
    assert.match(e.message, /Every step would be reported as an orphan/);
    return true;
  });
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

// WHERE THE ENGINE LANDS, asked of the same knob scripts/build-tjs.cjs installs it with.
// Every one of the 42 legs sets CLODE_TJS_OUT (the native build, the alpine container, the
// cross images, the VM guests, cross-blobulate's separate host tree), and build-tjs.cjs
// installs at `CLODE_TJS_OUT || platformTjsDir(repo)` — so a graph that fell straight
// through to platform-tag's default declared an OUTPUT no CI build writes, and the runner's
// output check would have refused a perfectly good engine. It never bit until the engine
// call sites started naming step ids.
test('engine.compile declares the engine where CLODE_TJS_OUT puts it', () => {
  const out = path.join(os.tmpdir(), 'clode-graph-tjs-out-fixture');
  const exe = process.platform === 'win32' ? 'tjs.exe' : 'tjs';
  const ctx = G.defaultContext({ env: { CLODE_TJS_OUT: out } });
  assert.strictEqual(ctx.engine, path.join(out, exe));
  assert.deepStrictEqual(G.stepById('engine.compile').outputs(ctx), [path.join(out, exe)],
    'the step must DECLARE the path build-tjs.cjs actually installs to');

  // CLODE_TJS still wins: it names an engine the caller already HAS, which is a stronger
  // claim than where a build would put one.
  assert.strictEqual(
    G.defaultContext({ env: { CLODE_TJS: '/some/engine', CLODE_TJS_OUT: out } }).engine,
    '/some/engine');

  // And with neither, the platform-keyed default — unchanged.
  const platformTag = require('../scripts/platform-tag.cjs');
  assert.strictEqual(G.defaultContext({ env: {} }).engine, platformTag.tjsBin(REPO));
});

// AND THE TRIPWIRE THAT WOULD HAVE MADE THE ABOVE EASY TO NOTICE. The knob is read out of
// scripts/build-tjs.cjs's OWN source rather than spelled a second time here, so the two
// cannot drift apart in silence: the defect this test exists for was the graph reading a
// different answer from the program it declares. A reader that stops matching is a finding,
// not a silence — that is the shape this whole file is a reaction to.
test('the graph reads the SAME output knob scripts/build-tjs.cjs installs with', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'build-tjs.cjs'), 'utf8');
  const m = /^const outDir = process\.env\.([A-Z][A-Z0-9_]*)\s*\|\|/m.exec(src);
  assert.ok(m, 'scripts/build-tjs.cjs no longer resolves `outDir` from a single env var in '
    + 'the shape this reader parses. Either it stopped honouring one — in which case the '
    + 'graph must stop too — or this reader has gone blind and the graph could now declare '
    + 'the engine at a path no build writes, which is exactly the defect it caught.');
  const knob = m[1];
  const out = path.join(os.tmpdir(), 'clode-graph-outdir-tripwire');
  assert.strictEqual(path.dirname(G.defaultContext({ env: { [knob]: out } }).engine), out,
    `scripts/build-tjs.cjs installs the engine under $${knob}, and the graph does not read it`);
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

// THE CONSTRAINT THAT MAKES A NODE-FREE `./build.sh` POSSIBLE, proven by running it rather
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

// GATE 5, WITH A CONTROL THAT IS AN ORPHAN AND NOTHING ELSE (final whole-branch review,
// finding 3). The control this replaces was a mutual-needs PAIR — a cycle, which
// acyclicGuard catches too, and which the old downward walk could only report because it
// could not report anything else. `fixture.orphan` below has `needs: []` and nothing needs
// it: no dangling edge, no cycle, reachable from a source and still work the root never
// does. Neither of the other two gates can see it, and the reviewer verified that a real
// orphan added to the REAL graph is exactly this shape.
//
// The root rides in the inputs because scan() may only see what read()/control() returned —
// a control on a synthetic graph has a synthetic root.
const orphanGuard = defineGuard({
  name: 'build-graph orphans',
  read: () => ({ steps: G.steps(), root: G.ROOT_ID }),
  scan: ({ steps, root }) => ({ findings: G.orphanFindings(steps, root), examined: steps.length }),
  control: () => ({
    root: 'fixture.root',
    steps: [
      { id: 'fixture.root', needs: ['fixture.needed'] },
      { id: 'fixture.needed', needs: [] },
      { id: 'fixture.orphan', needs: [] },
    ],
  }),
});

// THE CONTROL IS AN ORPHAN AND NOTHING ELSE — checked, not claimed. The control this
// replaced was reported by acyclicGuard as well, which is how gate 5 could carry a name for
// a property it was not testing. If either of the other two rules can see this fixture,
// gate 5's red would once again be somebody else's.
test('gate 5\'s control is invisible to the dangling and cycle rules', () => {
  const { steps } = orphanGuard.control();
  assert.deepStrictEqual(G.danglingFindings(steps), [], 'the orphan control has a dangling edge');
  assert.deepStrictEqual(G.cycleFindings(steps), [], 'the orphan control has a cycle');
  assert.deepStrictEqual(G.orphanFindings(steps, 'fixture.root'), ['fixture.orphan']);
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

// ---- --needs assume: the named step ALONE, still refused on an absent input ----------
//
// THE BLOCKER IT REMOVES. `--only engine.compile` under the default drags engine.bytecode
// and engine.source into an alpine container, a cross-toolchain image or a VM guest that
// cannot run a source phase at all — and those machines already HAVE the earlier phases'
// outputs, synced in from the runner. The alternative was a second declaration of the same
// compile with empty `needs`, which is the duplication the graph exists to cure.
//
// WHAT MAKES IT SAFE is not this selector but the UNCHANGED input check below: a mode that
// ran a step with missing inputs and exited 0 would be strictly worse than the blocker.

test('--needs assume runs exactly the named step; its needs do NOT run', () => {
  // A step whose needs have NOT run, whose OWN inputs are present — the CI shape exactly.
  const ran = [];
  const fake = [
    fixture({ id: 'x.first', run: () => ran.push('x.first') }),
    fixture({ id: 'x.second', needs: ['x.first'], run: () => ran.push('x.second') }),
  ];
  const out = runFixture({ graph: fake, only: 'x.second', needs: 'assume' });
  assert.deepStrictEqual(out.ran, ['x.second']);
  assert.deepStrictEqual(ran, ['x.second'],
    'the need really must not run — `ran` is the side effect, not the plan');

  // And the DEFAULT still drags it in, because only the pair distinguishes "assume worked"
  // from "this graph never had an edge".
  ran.length = 0;
  assert.deepStrictEqual(runFixture({ graph: fake, only: 'x.second' }).ran,
    ['x.first', 'x.second']);
  assert.deepStrictEqual(ran, ['x.first', 'x.second']);
});

test('--needs assume still REFUSES an absent declared input, in the same message shape', () => {
  let ran = false;
  const fake = [
    fixture({ id: 'x.first' }),
    fixture({ id: 'x.second', needs: ['x.first'], inputs: () => [ABSENT], run: () => { ran = true; } }),
  ];
  assert.throws(() => runFixture({ graph: fake, only: 'x.second', needs: 'assume' }),
    (e) => /^build-runner: x\.second declared input is missing: /.test(e.message)
      && e.message.includes(ABSENT),
    'assume must not become a way to run a step against a tree that never arrived');
  assert.strictEqual(ran, false);
});

test('--needs assume without --only is refused, not read as "assume everything"', () => {
  assert.throws(() => runFixture({ needs: 'assume', dryRun: true }),
    /--needs assume needs --only/,
    'with no step named there is nothing whose needs could have been satisfied elsewhere');
});

test('an unrecognised --needs value is refused rather than defaulting to build', () => {
  assert.throws(() => runFixture({ only: 'engine.compile', needs: 'asume', dryRun: true }),
    /is not a way for a step's needs to be satisfied/,
    'a typo that silently ran the transitive subgraph would put a source phase back on a '
    + 'machine that cannot run one — the fourth door into the same blind pass');
});

test('--needs assume and --runs-on can still select nothing, and that is still refused', () => {
  assert.throws(() => runFixture({ only: 'engine.compile', needs: 'assume', runsOn: 'guest', dryRun: true }),
    /matched no step.*needs=assume/s,
    'the empty-plan refusal has to name the mode too, or the reason is unguessable');
});

test('--needs is parsed off the command line, and rides through to the selection', () => {
  assert.deepStrictEqual(R.parseArgs(['--only', 'engine.compile', '--needs', 'assume']),
    { only: 'engine.compile', needs: 'assume' });
  assert.deepStrictEqual(
    R.runGraph({ only: 'engine.compile', needs: 'assume', dryRun: true, logFn: () => {} }).ran,
    ['engine.compile'],
    'the REAL graph, not a fixture: this is the selection CI asks for');
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
// anything but 1/1 reads as progress and carries none; that backlog item asks for an honest
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

// BACKLOG.md's "name the steps, show how done we are" asks for "every step's elapsed time
// written where a piped/CI build keeps
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

// ---- `provisions`: the input a step fills for itself (final review, finding 4) ----------
//
// scripts/build-clode-main.mjs requires esbuild out of toolchainDir(REPO) and installs it
// there itself. That directory is out-of-repo, so emitterInputPaths (which reads
// `path.join(REPO, ...)`) cannot see it and the graph said NOTHING about it — an undeclared
// input in the branch whose artifacts view exists to surface undeclared inputs. It is
// declared now, as `provisions` rather than `inputs`, and these three rows are why that
// distinction is not a euphemism.

test('a provisioned path is NOT asserted as an input — the step fills it', () => {
  let ran = false;
  const fake = [fixture({
    id: 'x.provisioner',
    provisions: () => [ABSENT],
    run: () => { ran = true; },
  })];
  assert.doesNotThrow(() => R.runGraph({
    graph: fake, only: 'x.provisioner', nowFn: () => 0, traceLog: scratchTrace(), logFn: () => {},
  }), 'a provisioned directory is absent on a clean machine by construction; asserting it '
    + 'as an input would refuse every first build');
  assert.strictEqual(ran, true, 'the step did not run');
  // And the same path as an INPUT still stops the step — otherwise the row above would pass
  // for the wrong reason (a boundary check that stopped checking anything).
  assert.throws(() => R.runGraph({
    graph: [fixture({ id: 'x.consumer', inputs: () => [ABSENT] })],
    only: 'x.consumer', nowFn: () => 0, traceLog: scratchTrace(), logFn: () => {},
  }), /declared input is missing/);
});

test('shape: provisions must be a FUNCTION, like every other derived field', () => {
  const findings = G.shapeFindings([fixture({ id: 'x.literal', provisions: ['/tmp/toolchain'] })]);
  assert.strictEqual(findings.length, 1, `expected one finding, got: ${findings}`);
  assert.match(findings[0], /provisions must be a FUNCTION/);
});

// THE DECLARATION MUST BE THE SAME DIRECTORY THE EMITTER ACTUALLY USES, or it is a second
// spelling of $TMPDIR — the restatement disease one field over. Both halves: the graph's
// answer comes from platform-tag.cjs's toolchainDir, and the emitter is still the script
// that calls it.
//
// WHAT THIS ROW CANNOT CATCH, SAID OUT LOUD (re-review, finding 3). It calls both sides in
// ONE process, so both read the SAME `process.versions.node` — and the node major is part
// of the directory name. A graph PLANNED under tjs and a step RUN under node are two
// processes with two answers, and no assertion made inside one process can see them
// disagree. That is a gate that cannot fail for a whole class of wrongness, which this repo
// treats as a P0; the row below is the form that CAN fail, and the mechanism is recorded in
// BACKLOG.md, "The toolchain directory is named for the interpreter that PLANS".
//
// WHICH STEP carries the field is no longer asserted here at all: it is derived, and its
// guard (with a control) is test/build-gates/build-graph-gates.test.cjs's guard 6.
test('the provisioned toolchain is the directory the emitter resolves, not a copy of it', () => {
  const step = G.stepById('bundle.clode-main');
  assert.ok(typeof step.provisions === 'function', 'the bundle step declares no provisions');
  assert.deepStrictEqual(step.provisions(G.defaultContext()),
    [require('../scripts/platform-tag.cjs').toolchainDir(REPO)]);
  const emitter = fs.readFileSync(path.join(REPO, G.EMITTER_REL), 'utf8');
  assert.match(emitter, /toolchainDir\(/,
    `${G.EMITTER_REL} no longer resolves its toolchain through platform-tag.cjs's `
    + 'toolchainDir, so the graph is now declaring a directory that script does not use');
});

// THE FORM THAT CAN FAIL. toolchainDir() keys on `process.versions.node`, and the two
// interpreters in this build answer differently: libexec/node-shim/modules/process.cjs
// hardcodes `24.0.0-node-shim-m1`, while `bundle.clode-main` runs under the REAL node. So a
// graph planned under tjs ALWAYS declares `toolchain/<os>-<arch>-node24`, and the step fills
// `…-node<real major>`. They agree on a node-24 box and nowhere else — which is precisely
// the node-free machine the generated page is about.
//
// Both sides are READ, not restated: the shim's answer out of the shim's own source, the
// real one out of this process, and both fed through platformTag()'s injectable
// `nodeVersion`. Nothing here changes what the shim reports; the point is that the
// disagreement becomes a red instead of a silence.
test('the toolchain directory names the node major that RUNS the step, not the planner', () => {
  const { platformTag } = require('../scripts/platform-tag.cjs');
  const shimRel = 'libexec/node-shim/modules/process.cjs';
  const shimSrc = fs.readFileSync(path.join(REPO, shimRel), 'utf8');
  const m = shimSrc.match(/versions:\s*\{\s*node:\s*'([^']+)'/);
  assert.ok(m, `${shimRel} no longer spells \`versions: { node: '…' }\` where this reads it — `
    + 'this row exists to compare the shim\'s reported node version against the real one, and '
    + 'a reader that cannot find it would go green for the wrong reason');
  assert.strictEqual(platformTag({ nodeVersion: m[1] }), platformTag(),
    `the graph planned under tjs declares \`${platformTag({ nodeVersion: m[1] })}\` as the `
    + `build-only toolchain directory (the shim hardcodes node ${m[1]} at ${shimRel}), while `
    + `scripts/build-clode-main.mjs runs under node ${process.versions.node} and fills `
    + `\`${platformTag()}\`. The graph's \`provisions\` is therefore naming a directory this `
    + 'build does not use. This is NOT a fault of your machine: it is the divergence recorded '
    + 'in BACKLOG.md as "The toolchain directory is named for the interpreter that PLANS", '
    + 'and it is invisible on a node-24 host. Do not paper over it by changing what the shim '
    + 'reports.');
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
// `./build.sh` running under tjs stopped dead at the first engine step and a node-free
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
    + 'node-shim loader, and the node-free `./build.sh` is broken again.');
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

// ---- the front door (build-graph.cjs's ENTRY_REL) ----------------------------------------
//
// The entry point is a handful of lines of shell under a long header, and every interesting
// thing about it is a thing it must NOT do. It must not assume an engine (the whole point of the task is a
// machine with no node), it must not reach for a package manager, it must not re-implement
// the runner's argument validation in shell, and it must not swallow the build's exit
// status. Those are the rows below.
//
// THE NAME COMES FROM THE GRAPH, not from a literal here. If this file spelled it, then the
// renderer, the page and this gate would each carry their own copy of a filename, and the
// first afternoon of that arrangement already produced the `build`-is-a-directory bug that
// made docs/build.md announce its own front door was missing.
const ENTRY = path.join(REPO, G.ENTRY_REL);

// Bashisms, in the shape test/build-tjs-boot.test.cjs already pins them: the entry point
// is `#!/bin/sh` ON PURPOSE, because it runs in alpine containers and minimal VM guests
// where bash may be absent, and `/bin/sh` there is dash or ash. Every one of these parses
// fine under bash and dies under dash, which is why a reader cannot be the gate.
const BASHISMS = [
  [/^\s*\[\[/m, '[[ ]] test'], [/^\s*local\s/m, '`local`'], [/^\s*declare\s/m, '`declare`'],
  [/^\s*function\s+[A-Za-z_]/m, '`function` keyword'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[/, 'array subscript'],
];

// A GUARD, not five assertions, for test/guard.cjs's stated reason: this reads an artifact
// it did not create and derives findings from its bytes, and a staleness check with no
// positive control is a test that happens to be green. control() hands the same scan a
// script that violates every rule at once, so "it never fires" cannot quietly become "it
// cannot fire".
const entryPointGuard = defineGuard({
  name: 'entry-point-shape',
  floor: 7,
  read: () => ({
    sh: fs.readFileSync(ENTRY, 'utf8'),
    // THE EXEC BIT AS SHIPPED, not as checked out. `fs.statSync().mode & 0o111` is 0 for
    // every file on win32 (NTFS has no POSIX mode), so reading the worktree here would
    // report a VIOLATION on Windows over a file that is 100755 in the index — which is
    // exactly what test/posix-host.cjs's committedExecBit() exists to stop happening a
    // sixth time.
    executable: committedExecBit(G.ENTRY_REL),
  }),
  scan: (i) => {
    const findings = [];
    let examined = 0;
    const rule = (ok, finding) => { examined += 1; if (!ok) findings.push(finding); };
    rule(/^#!\/bin\/sh$/.test(i.sh.split('\n')[0]),
      'the entry point must be a `#!/bin/sh` script — it is the first thing run on a '
      + 'machine that may have neither node nor bash');
    rule(i.executable,
      `${G.ENTRY_REL} ships non-executable (git index mode 100644), so a clean clone `
      + 'cannot run it. `git update-index --chmod=+x` it.');
    const bashisms = BASHISMS.filter(([re]) => re.test(i.sh)).map(([, what]) => what);
    rule(bashisms.length === 0,
      `bash-only syntax (${bashisms.join(', ')}) in a file that must run under dash/ash`);
    rule(/bootstrap-engine\.sh/.test(i.sh),
      'the entry point must RESOLVE an engine, not assume one is installed');
    rule(/build-runner\.cjs/.test(i.sh),
      'the entry point must run the graph through the runner, not shell out to a build of '
      + 'its own');
    rule(!/\b(npm|yarn|pnpm)\b/.test(i.sh),
      'a package manager is a node program, and the point of this entry point is a machine '
      + 'that has neither');
    rule(/^\s*exec\s/m.test(i.sh),
      'the entry point must `exec` the build, so the build\'s exit status IS the entry '
      + 'point\'s. A subshell that forgets to propagate is how a failed build exits 0.');
    rule(/build: engine=/.test(i.sh),
      'the entry point must print one greppable verdict naming the engine it handed the '
      + 'build to; a silent node fallback is otherwise indistinguishable from the '
      + 'node-free path working');
    return { examined, findings };
  },
  control: () => ({
    sh: '#!/bin/bash\nlocal answer=42\nnpm ci\nnode scripts/build-clode-main.mjs\n',
    executable: false,
  }),
});
guardTests(entryPointGuard);

// THE NAME COLLISION THAT DICTATED THE SPELLING, as a property rather than a comment.
// build/ is a directory in every working checkout, and on a case-insensitive filesystem a
// file cannot share its name. A future rename back to `build` would pass every grep above
// and be unopenable here.
test('the entry point is a file, and does not collide with the build directory', () => {
  assert.ok(fs.statSync(ENTRY).isFile(),
    `${G.ENTRY_REL} is not a regular file — the entry point cannot be a directory, which is `
    + 'what `build` already is in this checkout');
  const collides = fs.readdirSync(REPO).some(
    (name) => name !== G.ENTRY_REL
      && name.toLowerCase() === G.ENTRY_REL.toLowerCase().replace(/\.sh$/, ''));
  assert.ok(!collides || G.ENTRY_REL.endsWith('.sh'),
    'the entry point name collides with an existing repo-root entry');
});

function entryPoint(args, env) {
  return spawnSync(ENTRY, args, {
    cwd: REPO,
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// THE END TO END ROW. Everything above reads the file; this one RUNS it, which is the only
// way to learn that the engine it resolved can host the runner. CLODE_TJS is set to the
// engine the rest of this file already found, so the row costs no network: resolving from
// the pinned pack is scripts/bootstrap-engine.sh's own test's job, not this one's.
shTest('the entry point plans the whole graph, under the engine it resolved', (t) => {
  if (!TJS || !fs.existsSync(TJS)) {
    t.skip('no engine: neither CLODE_TJS nor the platform-tagged scratch engine resolves');
    return;
  }
  const r = entryPoint(['--plan'], { CLODE_TJS: TJS });
  assert.strictEqual(r.status, 0, `the entry point exited ${r.status}\n${r.stderr}`);
  const planned = r.stdout.trim().split('\n').filter((l) => l.indexOf('build-graph: step=') === 0);
  const lines = [];
  R.runGraph({ dryRun: true, logFn: (l) => lines.push(l) });
  assert.deepStrictEqual(planned, lines,
    'the entry point planned a different build than the runner plans under node');
  // ONE greppable line saying WHICH engine ran it. Without it, a run that quietly fell back
  // to node is indistinguishable from the flip working — the precise blindness
  // scripts/build-tjs-boot.sh's verdict line exists to end, and the reason this one copies
  // its shape.
  assert.match(r.stdout, /^build: engine=tjs /m,
    'the entry point must say which engine it handed the build to; a silent node fallback '
    + 'is how a green run says nothing about the node-free path');
});

// THE STATUS IS THE BUILD'S. `exec` is what makes that true, and a refusal is the cheapest
// way to observe it: the runner refuses an undeclared step id, and if the entry point
// validated arguments itself — or ran the runner in a subshell and forgot to propagate —
// this row would come back 0 with a green log about nothing.
shTest('a refusal by the runner is the entry point\'s exit status, not a shell opinion', (t) => {
  if (!TJS || !fs.existsSync(TJS)) {
    t.skip('no engine: neither CLODE_TJS nor the platform-tagged scratch engine resolves');
    return;
  }
  const r = entryPoint(['--plan', '--only', 'no.such.step'], { CLODE_TJS: TJS });
  assert.notStrictEqual(r.status, 0, 'an undeclared step id was not refused');
  assert.match(`${r.stdout}${r.stderr}`, /no\.such\.step/,
    'the runner\'s refusal must reach the developer verbatim, not be reworded by the shell');
});
