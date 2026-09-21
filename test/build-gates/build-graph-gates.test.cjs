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
  targets, ROOT_ID, EMITTER_REL } = require('../../scripts/build-graph.cjs');
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
