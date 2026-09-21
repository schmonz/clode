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
    + 'NODE_CONSTANTS once and engine-recipe.mjs\'s FILES three times');
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
  assert.ok(rels.includes('scripts/engine-recipe.mjs'),
    'build-clode-main.mjs runs scripts/engine-recipe.mjs to bake __CLODE_BAKED_ENGINE_RECIPE__, '
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
