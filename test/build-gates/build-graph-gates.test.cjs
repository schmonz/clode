'use strict';
// The build gate inside `scripts/build-graph.cjs`: bundleOutputNamesFrom()'s refusal.
//
// WHAT IT GUARDS. The graph declares what the bundle step EMITS by reading it back out of
// scripts/build-clode-main.mjs — the script that emits them — rather than restating the
// names. That derivation is the whole reason the declaration is not a fourth
// hand-maintained list of what the build does; and a derivation that can answer EMPTY is
// worth less than no derivation at all, because an empty answer reads as "this step
// produces nothing" and every downstream check (the blobulate's inputs, the runner's
// did-the-outputs-appear pass, the artifact diagram) then agrees, quietly, with nothing.
// So the derivation REFUSES on no match instead of returning [], for the reason
// scripts/engine-recipe.cjs's expand() refuses on a glob that matched nothing: a typo'd
// pattern would otherwise make every tree look identical.
//
// WHAT INPUT TRIPS IT (measured): any build-clode-main.mjs source with no
// `path.join(OUT, '<name>.bundle.cjs')` — which is exactly what an innocuous refactor
// there produces, e.g. hoisting the directory into a variable or switching to template
// literals. The control below is that source with the shape simply absent.
//
// WHY THE PURE HALF EXISTS. bundleOutputNames() reads a fixed repo path, so a control
// could only reach its refusal by corrupting the real scripts/build-clode-main.mjs.
// bundleOutputNamesFrom(src) is the same code with the I/O lifted out — the same split
// depscan-verdict.cjs, ar-determinism.cjs and bundle-inputs-gate.cjs already make, and for
// the same stated reason: a test must be able to hand the decision a known-bad input.
//
// The literal relative require below is load-bearing for the production-gate population
// sweep (test/guards-population.cjs), which derives "which guard controls this production
// gate" by reading that exact string out of this file's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bundleOutputNamesFrom, emitterInputPaths, runsOnForLegs, stepById, legsNamed,
  targets, ROOT_ID, EMITTER_REL, GRAPH_REL, steps, nodeRoutes, nodeRouteFindings,
  engineNodeOnWindows, observedNodeRouteFindings, defaultContext, nodeSteps,
  toolchainProvisionerIds } = require('../../scripts/build-graph.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { throwsAsFindings } = require('../throws-as-findings.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EMITTER = path.join(REPO, EMITTER_REL);

const bundleOutputsGuard = defineGuard({
  name: 'build-graph bundle-output derivation refuses an empty answer',
  read: () => ({ src: fs.readFileSync(EMITTER, 'utf8') }),
  // `examined` counts what the derivation actually FOUND, not the size of the input it was
  // handed: a byte count would read healthy for a source the regex matched nothing in,
  // which is the one state this guard exists to see.
  scan: (inputs) => {
    let found = 0;
    return throwsAsFindings(() => { found = bundleOutputNamesFrom(inputs.src).length; }, [], {
      examined: () => found,
      expect: /named no `path\.join\(OUT/,
    });
  },
  // scripts/build-clode-main.mjs after a refactor that keeps emitting bundles but stops
  // spelling the path the way the derivation reads it.
  control: () => ({
    src: [
      "const OUT = path.join(REPO, 'build', 'bundle');",
      'function esbuildBundle() {',
      '  const bundle = `${OUT}/clode-main.bundle.cjs`;',
      '  return bundle;',
      '}',
    ].join('\n'),
  }),
  floor: 2,
});

guardTests(bundleOutputsGuard);

// The refusal has to point at the file whose shape moved, or an operator is told the graph
// found nothing and left to guess where "nothing" was read from.
test('the refusal names the emitter it was reading and forbids hardcoding around it', () => {
  assert.throws(() => bundleOutputNamesFrom('// nothing here\n'), (e) => {
    assert.match(e.message, /build-clode-main\.mjs/);
    assert.match(e.message, /not hardcode the names here/);
    return true;
  });
});

// The FLOOR under this guard: the real emitter must still be readable and still name at
// least the two bundles `clode bootstrap` stages. "Found nothing" and "there is nothing to
// find" are opposite results, and this is the half that says the derivation is looking at a
// live source rather than a moved one.
test('FLOOR: the real emitter still names the bundles the bootstrap stages', () => {
  const names = bundleOutputNamesFrom(fs.readFileSync(EMITTER, 'utf8'));
  assert.ok(names.length >= 2,
    `scripts/build-clode-main.mjs names ${names.length} bundle output(s); the bootstrap `
    + 'stages clode-main.bundle.cjs and naude-entry.bundle.cjs, so fewer than two means the '
    + 'derivation is reading a shape that moved, not a build that shrank');
  assert.ok(names.every((n) => n.endsWith('.bundle.cjs')), `not a bundle name: ${names}`);
});

// ==========================================================================
// GUARD 2 — emitterInputPaths()'s two refusals (review round 1, finding 2).
// ==========================================================================
//
// WHAT IT GUARDS. The bundle step's non-libexec inputs are READ OUT of
// scripts/build-clode-main.mjs's own `path.join(REPO, ...)` calls. The hand-written list
// this replaced had already rotted on the day it was written — it missed
// scripts/engine-recipe.cjs, which the emitter runs to bake __CLODE_BAKED_ENGINE_RECIPE__ —
// and the libexec walk kept the answer non-empty, so no existing check could ever have
// noticed. A derivation with no refusal behind it is the same hand list with extra steps.
//
// WHAT INPUT TRIPS IT (measured, both halves): an emitter that spells its repo reads some
// other way (zero matches), and an emitter that names a repo path which is neither a
// readable file nor the step's own output directory.
//
// `isFile` and `outDirs` are injected, so the control reaches both refusals without
// corrupting the real scripts/build-clode-main.mjs.
const emitterInputsGuard = defineGuard({
  name: 'build-graph emitter-input derivation refuses a wrong answer',
  read: () => ({
    src: fs.readFileSync(EMITTER, 'utf8'),
    outDirs: new Set(['build/bundle']),
    isFile: (rel) => {
      try { return fs.statSync(path.join(REPO, rel)).isFile(); } catch { return false; }
    },
  }),
  scan: (inputs) => {
    let found = 0;
    return throwsAsFindings(() => { found = emitterInputPaths(inputs).length; }, [], {
      examined: () => found,
      expect: /names no `path\.join\(REPO|neither a readable file/,
    });
  },
  // Half one of the pair: a repo path the emitter names that is not there. (Half two —
  // zero matches — is asserted directly below; a guard's control models ONE violation.)
  control: () => ({
    src: "const v = fs.readFileSync(path.join(REPO, 'VERSION-that-moved'), 'utf8');",
    outDirs: new Set(['build/bundle']),
    isFile: () => false,
  }),
  floor: 1,
});

guardTests(emitterInputsGuard);

test('the emitter-input derivation refuses an emitter that names no repo path at all', () => {
  assert.throws(() => emitterInputPaths({
    src: "const v = fs.readFileSync(`${REPO}/VERSION`, 'utf8');", // a shape this reader cannot see
    outDirs: new Set(), isFile: () => true,
  }), (e) => {
    assert.match(e.message, /names no `path\.join\(REPO/);
    assert.match(e.message, /silently shrank to the libexec walk/);
    return true;
  });
});

test('the emitter-input derivation drops the OUTPUT dir without refusing over it', () => {
  const rels = emitterInputPaths({
    src: "const OUT = path.join(REPO, 'build', 'bundle');\n"
      + "const v = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8');",
    outDirs: new Set(['build/bundle']),
    isFile: (rel) => rel === 'VERSION',
  });
  assert.deepStrictEqual(rels, ['VERSION']);
});

// ==========================================================================
// GUARD 3 — runsOnForLegs()'s disagreement refusal (review round 1, finding 3).
// ==========================================================================
//
// WHAT IT GUARDS. canonical-name.cjs's targetName() drops the libc qualifier by design, so
// a canonical TARGET name can select more than one LEG: linux-riscv64-musl and
// linux-riscv64 share the name `linux-riscv64`, as do the two s390x legs. The first cut of
// build-graph.cjs keyed a Map on that collapsed name, which kept the LAST leg of each pair
// and answered `runsOn` for whichever that happened to be. Both pairs agree today, so the
// bug was latent — and latent is exactly how the 2026-09-20 --plan bug that would have
// rsynced an x86-64 ELF into a NetBSD guest stayed invisible.
//
// The refusal is therefore a TRIPWIRE: it cannot fire on today's manifest. That makes a
// control not optional but the only thing standing between "it never fires" and "it cannot
// fire" — this repo has found roughly 17 gates that could not fail.
//
// WHAT INPUT TRIPS IT (measured): two legs selected by one name, one native and one with a
// `guest-platform` of a VM family, asked where `engine.compile` runs -> host vs guest.
const legDisagreementGuard = defineGuard({
  name: 'build-graph refuses a name whose legs disagree about the machine',
  // Every collapsed target name the release tier actually produces, with the legs it
  // selects. Resolving each is the real gate: it passes only while every colliding pair
  // agrees.
  read: () => targets('release').map((name) => ({ name, selected: legsNamed(name, 'release') })),
  scan: (rows) => {
    const findings = [];
    for (const row of rows) {
      for (const step of [stepById('engine.compile'), stepById(ROOT_ID)]) {
        try { runsOnForLegs(step, row.selected, row.name); } catch (e) { findings.push(e.message); }
      }
    }
    return { findings, examined: rows.length };
  },
  control: () => [{
    name: 'controlled-collision',
    selected: [{ leg: 'controlled-collision' }, { leg: 'controlled-collision-vm', 'guest-platform': 'netbsd' }],
  }],
  floor: 2,
});

guardTests(legDisagreementGuard);

test('the disagreement refusal names both legs and says to name the leg instead', () => {
  assert.throws(() => runsOnForLegs(stepById('engine.compile'),
    [{ leg: 'fixture-native' }, { leg: 'fixture-guest', 'guest-platform': 'openbsd' }],
    'fixture'), (e) => {
    assert.match(e.message, /fixture-native/);
    assert.match(e.message, /fixture-guest/);
    assert.match(e.message, /host vs guest/);
    assert.match(e.message, /Name the LEG/);
    return true;
  });
});

// FLOOR: the collapsing pairs must still EXIST, or the guard above examines a population in
// which no two legs ever share a name and its gate half is vacuous.
test('FLOOR: at least one canonical target name still selects more than one leg', () => {
  const multi = targets('release')
    .map((n) => ({ n, legs: legsNamed(n, 'release').map((l) => l.leg) }))
    .filter((r) => r.legs.length > 1);
  assert.ok(multi.length > 0,
    'no canonical target name collapses two legs any more, so the disagreement refusal '
    + 'guards a case that cannot arise on this manifest — re-derive it or delete it');
});

// ==========================================================================
// GUARD 4 — every step that REACHES node is one nodeSteps() reports,
//           OBSERVED by driving the steps (re-review, finding 1 — MAJOR).
// ==========================================================================
//
// WHAT IT GUARDS. docs/build.md's "What still needs node" section — the page's central
// honest claim — is derived from build-graph.cjs's nodeSteps(), which matches a DIRECT
// `runNode` call in a step's own `run`. The first whole-branch review added a third helper
// (`runNodeAlias`, a one-line wrapper around `sh(ctx, 'node', args)`), pointed
// bundle.clode-main at it, and the page silently dropped from "2 of the 5 declared steps"
// to "1 of the 5" with nothing red except the page-STALENESS gate — and regenerating the
// page, which the page itself tells you to do, made the omission permanent and green.
//
// THE FIRST FIX WAS A PARSE, AND THE RE-REVIEW BLINDED IT WITH ONE TOKEN. Writing the same
// helper as `const hop = (ctx, a) => runNode(ctx, a)` instead of `function hop(...)` gave
// nodeRouteFindings ZERO findings: `hop` is not a `function` declaration so the transitive
// closure never followed it, and the spawn was still attributed to `runNode` so the
// unattributable-spawn half never fired either. 104/104 green, page wrong. The FLOOR could
// not help — it counts parsed functions (41) and one extra binding does not move it.
//
// SO THIS GUARD OBSERVES INSTEAD OF READING. Each step's `run` is DRIVEN with a recording
// `ctx.execFileSync`, and the programs it actually spawns are compared against nodeSteps().
// There is no shape to hide in: an arrow, an alias, a rename, a reformat and a method all
// spawn the same program, and the recorder sees it. The seam is the one build-runner.cjs
// already threads (`execFileSyncFn`), and test/build-graph.test.cjs's "a step shells out
// through the CONTEXT's exec" proves BOTH directions of it, so this guard does not have to
// assume the injection is honoured.
//
// WHAT INPUT TRIPS IT (measured): a step whose `run` reaches node through ANY intermediary
// nodeSteps() does not match — the control below is the exact arrow-const shape that
// blinded the parse.
//
// WHY THE PURE HALF EXISTS. observedNodeRouteFindings takes the step list and the context,
// so the control is a synthetic step reaching node through a synthetic helper rather than a
// corrupted scripts/build-graph.cjs — the same split bundleOutputNamesFrom and
// emitterInputPaths already make, for the same stated reason.
//
// The literal relative require at the top of this file is load-bearing for the
// production-gate population sweep (test/guards-population.cjs).
const GRAPH_SRC = () => fs.readFileSync(path.join(REPO, GRAPH_REL), 'utf8');

// The fixtures' helpers. `runNode` is named exactly as build-graph.cjs names its own, so a
// fixture step calling it is one nodeSteps() REPORTS — which is what makes the "reported
// but never runs node" and "ran a different entry point" halves reachable. `controlHop` is
// the re-reviewer's blinding shape: an arrow bound to a `const`, reached through a plain
// alias binding. Neither is a `function` declaration, and that is the entire point — the
// observation does not care what shape a helper is written in.
const runNode = (ctx, args) => ctx.execFileSync('node', args);
const controlRunNode = runNode;
const controlHop = (ctx, args) => controlRunNode(ctx, args);

const observedRouteGuard = defineGuard({
  name: 'build-graph: no step reaches node by a route nodeSteps() cannot see (observed)',
  read: () => ({ steps: steps(), ctx: defaultContext() }),
  scan: (inputs) => {
    const r = observedNodeRouteFindings(inputs);
    return { findings: r.findings, examined: r.examined };
  },
  // The re-reviewer's mutation, verbatim in shape: a step reaching node through an
  // arrow-const intermediary. nodeSteps() sees nothing here (`controlHop(` does not match
  // `\brunNode\s*\(`) and neither does the source parse — the observation does.
  control: () => ({
    steps: [{ id: 'fixture.arrow-hop', run: (ctx) => controlHop(ctx, ['scripts/fixture.mjs']) }],
    ctx: defaultContext(),
  }),
  // Ten today: five steps, each driven under both platforms. Two is the floor because one
  // step observed under one platform is the least that distinguishes "this recorder is
  // wired up" from "nothing ever reached it", and a recorder nothing reaches answers
  // "no step needs node" exactly like a node-free build.
  floor: 2,
});

guardTests(observedRouteGuard);

// THE OTHER DIRECTION, shown firing: a step nodeSteps() reports whose `run`, when driven,
// spawns no node at all. That is a page naming a dependency the build has shed, and it must
// not be silent either.
test('the observed route gate reports a step nodeSteps() names but that never runs node', () => {
  const r = observedNodeRouteFindings({
    steps: [{
      id: 'fixture.claimed',
      run: (ctx) => {
        // runNode( — nodeSteps() reads this step's SOURCE, so this mention is enough to make
        // it report the step. What the step actually spawns is below, and it is not node.
        return ctx.execFileSync('cmake', ['--build']);
      },
    }],
    ctx: defaultContext(),
  });
  assert.strictEqual(r.findings.length, 1, `expected one finding, got: ${r.findings}`);
  assert.match(r.findings[0], /but driving its `run` spawned/);
});

// THE ENTRY POINTS ARE OBSERVED TOO. The page does not only count the steps that need node,
// it NAMES the files a reader is being asked to convert. A step that runs node on a
// different script than its `run` source spells is a page sending that reader to the wrong
// file, and the argv says which it really was.
test('the observed route gate reports an entry point the page names but node never ran', () => {
  const r = observedNodeRouteFindings({
    steps: [{
      id: 'fixture.drifted',
      // nodeSteps() reads `scripts/announced.mjs` out of this source, which is what the page
      // would name; node is actually run on a different file.
      run: (ctx) => runNode(ctx, ['scripts/announced.mjs'.replace('announced', 'really-ran')]),
    }],
    ctx: defaultContext(),
  });
  assert.strictEqual(r.findings.length, 1, `expected one finding, got: ${r.findings}`);
  assert.match(r.findings[0], /as the entry point\(s\) this step needs node for/);
});

// THE EXCLUSION, PINNED TO THE DISCLOSURE, and now BOTH SIDES ARE OBSERVED. A step that
// reaches node only under win32 (runBuildTjs's fallback) is reported as `windowsOnly`
// rather than as a finding — but only because docs/build.md discloses that route
// separately, through engineNodeOnWindows(), which reads the function's SOURCE. Two
// independent derivations of one fact, one by watching and one by reading; this is the row
// that stops them drifting apart.
test('a windows-only node route is OBSERVED exactly when the page says it exists', () => {
  const r = observedNodeRouteFindings({ steps: steps(), ctx: defaultContext() });
  assert.strictEqual(r.windowsOnly.length > 0, engineNodeOnWindows(),
    `${r.windowsOnly.length} step(s) reach node only when driven with platform win32, while `
    + `engineNodeOnWindows() says ${engineNodeOnWindows()} — the page's Windows caveat and `
    + 'the route gate\'s exclusion are the same fact derived twice, and they disagree');
});

// THE FLOOR under the observation: driving the real steps must really reach the recorder,
// and at least one real step must really run node. "No findings" from a recorder nothing
// reaches is the same clean bill of health as a node-free build, which is the confusion
// every guard in this repo exists to prevent.
test('FLOOR: driving the real steps reaches the recorder and really runs node', () => {
  const r = observedNodeRouteFindings({ steps: steps(), ctx: defaultContext() });
  assert.ok(r.examined >= steps().length,
    `driving ${steps().length} step(s) under two platforms recorded a spawn in only `
    + `${r.examined} of them — a step whose \`run\` reaches no exec at all is invisible to `
    + 'this derivation, and an invisible step reads exactly like a step that needs nothing');
  const isNode = (p) => /(^|[/\\])node(\.exe)?$/i.test(p);
  const runsNode = r.observed.filter((o) => o.programs.some(isNode));
  assert.ok(runsNode.length > 0,
    'no step spawned node when driven. If that is real, the build is node-free: retire this '
    + 'guard, nodeSteps() and the page section together. If it is not, the steps stopped '
    + 'reaching the context\'s exec and this observation is watching nothing.');
});

// ==========================================================================
// GUARD 5 — the SOURCE-SHAPE tripwire, kept for what observation cannot see.
// ==========================================================================
//
// WHAT IT GUARDS, NOW THAT GUARD 4 OBSERVES. This is the text parse of build-graph.cjs's own
// source. It is no longer the gate on "every step that reaches node is one nodeSteps()
// reports" — guard 4 is, and it is immune to the binding style that blinded this one. What
// this reader still does that no observation can: see a node spawn that never goes through
// the CONTEXT's exec. A step calling node:child_process directly would spawn a real node and
// the recorder would never hear about it; the `execFileSync('node', ...)` shape in this
// file's source is caught here.
//
// ITS BLIND SPOT IS WRITTEN DOWN, in build-graph.cjs beside the parser and here: an
// intermediary bound as `const hop = (ctx, a) => runNode(ctx, a)` or `const runner =
// runNode` is invisible to it, because neither is a `function` declaration and the spawn is
// still attributed to runNode. That shape is guard 4's control. Do not re-point a gate on
// the node-dependency property at this reader.
//
// WHAT INPUT TRIPS IT (measured): a third `function`-declared helper wrapping the spawn,
// and — the half that matters more now — a spawn site this reader cannot attribute to any
// named function at all, which is what "this parser has gone blind" looks like from inside.
const nodeRouteGuard = defineGuard({
  name: 'build-graph: a node spawn this module\'s source parser cannot attribute',
  read: () => ({ src: GRAPH_SRC(), steps: steps() }),
  // `examined` is the steps this scan actually resolved a route for. Zero means there is no
  // graph to ask, which is BROKEN and not a node-free build.
  scan: (inputs) => {
    const r = nodeRouteFindings(inputs);
    return { findings: r.findings, examined: r.examined };
  },
  // The reviewer's mutation, verbatim in shape: a THIRD helper, and a step that reaches node
  // through it. nodeSteps() sees nothing here (`runNodeAlias(` does not match `\brunNode\s*\(`),
  // which is precisely the silence this guard exists to break.
  control: () => ({
    src: [
      'function sh(ctx, file, args) {',
      '  return ctx.execFileSync(file, args);',
      '}',
      'function runNode(ctx, args) {',
      "  return sh(ctx, 'node', args);",
      '}',
      'function runNodeAlias(ctx, args) {',
      "  return sh(ctx, 'node', args);",
      '}',
    ].join('\n'),
    steps: [{ id: 'fixture.aliased', run: (ctx) => runNodeAlias(ctx, ['scripts/fixture.mjs']) }],
  }),
  floor: 2,
});

guardTests(nodeRouteGuard);

// The OTHER direction, which the guard's gate half would also report but which deserves to
// be shown firing: a step nodeSteps() reports and no route in the source can reach. That is
// what a reader gone blind on the shape looks like, and it must not read as "no node".
test('the route gate reports a step nodeSteps() names but no route reaches', () => {
  const r = nodeRouteFindings({
    src: 'function unrelated(a) {\n  return a;\n}\n',
    steps: [{ id: 'fixture.claimed', run: (ctx) => runNode(ctx, ['scripts/fixture.mjs']) }],
  });
  assert.strictEqual(r.findings.length, 1, `expected one finding, got: ${r.findings}`);
  assert.match(r.findings[0], /no route in/);
});

// A node spawn that belongs to no named function — an arrow-function helper, say — is the
// shape this reader would otherwise go blind on while still answering "no routes".
test('the route gate reports a node spawn it cannot attribute to a named function', () => {
  const r = nodeRouteFindings({
    src: "const runNodeArrow = (ctx, args) => sh(ctx, 'node', args);\n",
    steps: [],
  });
  assert.strictEqual(r.findings.length, 1, `expected one finding, got: ${r.findings}`);
  assert.match(r.findings[0], /outside every named function/);
});

// AN `async function` IS A NAMED FUNCTION, and saying otherwise sent the reader to fix the
// wrong thing (re-review, finding 6). This shape used to red as an UNATTRIBUTABLE spawn —
// "give the spawn a named function" — about a spawn that was already inside one, because
// the declaration regex began `^function`. It now parses, so the finding it produces is the
// ROUTE finding, which names the helper and says what to do about it.
test('an `async function` helper is parsed as the named function it is', () => {
  const src = [
    'function sh(ctx, file, args) {',
    '  return ctx.execFileSync(file, args);',
    '}',
    'async function runNodeLater(ctx, args) {',
    "  return sh(ctx, 'node', args);",
    '}',
  ].join('\n');
  const routes = nodeRoutes(src);
  assert.ok(routes.functions.includes('runNodeLater'),
    `the parser did not see the async declaration: ${routes.functions}`);
  assert.deepStrictEqual(routes.unattributed, [],
    'the spawn is inside a named function, so reporting it as unattributable would tell the '
    + 'reader to do something they have already done');
  const r = nodeRouteFindings({
    src,
    steps: [{ id: 'fixture.async', run: (ctx) => runNodeLater(ctx, ['scripts/fixture.mjs']) }],
  });
  assert.strictEqual(r.findings.length, 1, `expected one finding, got: ${r.findings}`);
  assert.match(r.findings[0], /reaches node through runNodeLater/);
});

// PROSE IS NOT AN INVOCATION. This file's subject QUOTES the spawn it looks for — in
// build-graph.cjs's own header, and in the comment above this very test — so a reader that
// counted comments would report the documentation as an unattributable spawn and be red
// forever about nothing. `sh(ctx, 'node', args)` on this line is a comment, not a call.
test('a comment quoting the spawn is not a spawn site', () => {
  const r = nodeRouteFindings({
    src: "// sh(ctx, 'node', args) is what runNode does\nfunction unrelated(a) {\n  return a;\n}\n",
    steps: [],
  });
  assert.deepStrictEqual(r.findings, []);
});

// THE EXCLUSION, PINNED TO THE DISCLOSURE. A platform-guarded route (runBuildTjs's win32
// fallback) is not a finding — but only because docs/build.md discloses it separately,
// through engineNodeOnWindows(). Two derivations of one fact; this is the row that stops
// them drifting apart, which is the defect one level up from the one this guard closes.
test('a windows-only node route exists exactly when the page says it does', () => {
  const r = nodeRouteFindings({ src: GRAPH_SRC(), steps: steps() });
  assert.strictEqual(r.windowsOnly.length > 0, engineNodeOnWindows(),
    `${r.windowsOnly.length} step(s) reach node only through a win32-guarded helper, while `
    + `engineNodeOnWindows() says ${engineNodeOnWindows()} — the page's Windows caveat and `
    + 'the route gate\'s exclusion are the same fact derived twice, and they disagree');
});

// THE FLOOR under the route reader. "No step reaches node" is the answer this guard gives
// both when the build has genuinely stopped needing node and when the reader has stopped
// parsing this module — opposite results. This row makes a human tell them apart.
test('FLOOR: the route reader still parses this module and still finds a node spawn', () => {
  const routes = nodeRoutes(GRAPH_SRC());
  assert.ok(routes.functions.length > 10,
    `the route reader parsed ${routes.functions.length} function(s) out of ${GRAPH_REL} — it `
    + 'reads top-level `function name(...) {` declarations, so a formatting or style change '
    + 'there blinds it, and a blind reader answers "no step needs node" exactly like a '
    + 'node-free build does');
  assert.ok(routes.always.length + routes.windows.length > 0,
    `no function in ${GRAPH_REL} spawns node any more. If that is real, the build is node-`
    + 'free: retire this guard, nodeSteps() and the page section together. If it is not, the '
    + 'spawn moved out of the shape this reader sees.');
});

// ==========================================================================
// GUARD 6 — WHICH step provisions the build-only toolchain, DERIVED
//           (re-review, finding 4's residual).
// ==========================================================================
//
// WHAT IT GUARDS. `bundle.clode-main`'s entry point installs esbuild into an out-of-repo
// directory and requires it back from there, so that directory is an input the step fills
// for ITSELF — declared as `provisions` rather than `inputs` because build-runner.cjs
// asserts inputs (:244 checkInputs) BEFORE running the step (:258 step.run), so as an
// `input` it would refuse every first build.
//
// WHAT WAS WRONG WITH IT. The PATH was derived (platform-tag.cjs's toolchainDir) but WHICH
// STEP carries the field was hand-placed, pinned only by a test grepping the emitter for
// `toolchainDir(`. "Derived, never declared" is this repo's rule and this exact shape has
// rotted five times (NODE_CONSTANTS twice, engine-recipe.cjs's FILES three times). The
// association is derived now: a step provisions the toolchain exactly when one of the entry
// points its own `run` gives node resolves `toolchainDir(...)` in that entry point's source.
//
// WHAT INPUT TRIPS IT (measured): node entry points none of which resolve a toolchain —
// which is what an emitter refactor that hoists the directory, or a `provisions` field left
// pointing at a step that no longer runs that emitter, looks like from here.
const toolchainProvisionerGuard = defineGuard({
  name: 'build-graph derives WHICH step provisions the build-only toolchain',
  read: () => ({
    rows: nodeSteps(steps()),
    readSource: (rel) => {
      try { return fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { return ''; }
    },
  }),
  // `examined` is the node steps the rule was ASKED about, not the provisioners it found —
  // deliberately unlike the bundle-output guard beside it. The refusal here fires when the
  // answer is empty, so counting the answer would report every refusal as BROKEN and swallow
  // the message that says WHICH shape moved. Zero node steps is the real blindness (there
  // was nothing to ask), and that is what the floor catches.
  scan: (inputs) => throwsAsFindings(
    () => toolchainProvisionerIds(inputs.rows, inputs.readSource), [], {
      examined: () => inputs.rows.length,
      expect: /resolves `toolchainDir/,
    }),
  // Real-shaped rows whose entry points simply never resolve a toolchain.
  control: () => ({
    rows: [{ id: 'fixture.bundle', entries: ['scripts/fixture-emitter.mjs'] }],
    readSource: () => "const OUT = path.join(os.tmpdir(), 'toolchain');\n",
  }),
  floor: 1,
});

guardTests(toolchainProvisionerGuard);

// THE DERIVATION MUST LAND ON A STEP, AND ON THE RIGHT DIRECTORY. Both halves: the field
// exists exactly on the steps the rule names (not on a step somebody typed it onto), and
// its answer is platform-tag.cjs's own toolchainDir rather than a second spelling of
// $TMPDIR.
test('the derived provisioner is the step whose entry point resolves the toolchain', () => {
  const ids = toolchainProvisionerIds(nodeSteps(steps()),
    (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8'));
  const carry = steps().filter((s) => typeof s.provisions === 'function').map((s) => s.id);
  assert.deepStrictEqual(carry, ids,
    `the rule names ${ids} as the toolchain provisioner(s) and the graph carries the field `
    + `on ${carry} — a hand-placed \`provisions\` is exactly what this derivation replaced`);
  // The ANSWER is compared against the context's own `toolchain` field, NOT against a fresh
  // require of scripts/platform-tag.cjs: borrowing a production module as a fixture here
  // would make it count as CONTROLLED in test/guards-population.test.cjs, which is the
  // miscount that test exists to refuse. That field IS toolchainDir's answer, and
  // test/build-graph.test.cjs is where the two are pinned together.
  const ctx = defaultContext();
  for (const id of ids) {
    assert.deepStrictEqual(steps().find((s) => s.id === id).provisions(ctx), [ctx.toolchain]);
  }
});
