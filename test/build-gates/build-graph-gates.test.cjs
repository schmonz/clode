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
// scripts/engine-recipe.mjs's expand() refuses on a glob that matched nothing: a typo'd
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
const { bundleOutputNamesFrom } = require('../../scripts/build-graph.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { throwsAsFindings } = require('../throws-as-findings.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EMITTER = path.join(REPO, 'scripts', 'build-clode-main.mjs');

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
