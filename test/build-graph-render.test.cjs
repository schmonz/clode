'use strict';
// The gates on docs/build.md — this repo's first TRACKED developer-facing page, and the
// first one that is GENERATED rather than written.
//
// WHY A GATE AT ALL. A hand-drawn diagram is a comment that rots: it is right on the day it
// is drawn and silently wrong every day after. This repo has watched that happen to three
// hand-maintained lists (NODE_CONSTANTS, engine-recipe.cjs's FILES, the BACKLOG prose about
// the build) and, earlier today, to a single WORD: a step was renamed in one place and the
// generated text that quoted it was never regenerated. So the page is derived from
// scripts/build-graph.cjs, and gate 4 below is what makes "derived" true: the committed
// bytes must be exactly what the renderer emits today, or the suite is red and names the
// file as stale.
//
// The other rows here are the controls. A gate nobody has watched fail is not a gate, and
// each refusal the renderer carries is driven with a known-bad input so that "it never
// fires" cannot quietly become "it cannot fire".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { defineGuard, guardTests } = require('./guard.cjs');
const R = require('../scripts/render-build-graph.cjs');
const G = require('../scripts/build-graph.cjs');

const repo = path.join(__dirname, '..');

// GATE 4, as a guard rather than a bare assertion. It reads a repo artifact and derives a
// finding from its bytes, which is exactly the shape test/guard.cjs exists to contain: a
// staleness check with no positive control is a test that happens to be green, and this one
// is the load-bearing claim of the whole task. read()/scan()/control() give it the seam —
// scan() never touches disk, so the control can hand it a page that IS stale and watch the
// guard say so, with no way to reach that state by corrupting the real tree.
const pageFresh = defineGuard({
  name: 'docs-build-page-fresh',
  read: () => ({
    onDisk: fs.readFileSync(path.join(repo, R.PAGE_REL), 'utf8'),
    rendered: R.renderAll(),
  }),
  scan: (inputs) => ({
    examined: 1,
    findings: inputs.onDisk === inputs.rendered ? []
      : [`${R.PAGE_REL} is stale — run \`node scripts/render-build-graph.cjs --write\` `
        + 'and commit'],
  }),
  control: () => ({ onDisk: 'a page somebody edited by hand\n', rendered: 'what the renderer emits\n' }),
});
guardTests(pageFresh);

test('all three views render, and each is a different projection', () => {
  const steps = G.steps();
  const p = R.renderPipeline(steps);
  const a = R.renderArtifacts(steps);
  const f = R.renderFleet(steps);
  for (const [name, doc] of [['pipeline', p], ['artifacts', a], ['fleet', f]]) {
    assert.match(doc, /^(graph|flowchart)\s/m, `${name} is not a mermaid graph`);
  }
  assert.notStrictEqual(p, a);
  assert.notStrictEqual(a, f);
  assert.notStrictEqual(p, f);
});

// Every declared step has to APPEAR. A renderer that drew four of five steps would still
// produce three valid mermaid graphs and still round-trip through gate 4 — green, and about
// a build that is missing a phase.
test('every declared step appears in the pipeline, the artifacts view and the fleet', () => {
  const steps = G.steps();
  assert.ok(steps.length >= 5, 'the graph declares fewer steps than it did when this was written');
  for (const view of [R.renderPipeline(steps), R.renderArtifacts(steps), R.renderFleet(steps)]) {
    for (const s of steps) assert.ok(view.includes(s.id), `${s.id} is missing from a view`);
  }
});

// THE PAGE MUST BE THE SAME ON EVERY MACHINE, or gate 4 is red for everyone who did not
// generate it. The graph's own answers are absolute paths on THIS box — the engine lands
// under $TMPDIR and the txiki.js checkout under ~/.cache — so the renderer resolves them
// against symbolic roots instead. This is the row that proves it did.
test('the page carries no machine-specific path', () => {
  const page = R.renderAll();
  for (const re of [/\/Users\//, /\/home\//, /\/var\/folders\//, /\/tmp\//, /[A-Z]:\\/]) {
    assert.doesNotMatch(page, re, `the rendered page leaks a machine-specific path (${re})`);
  }
  assert.ok(!page.includes(repo), 'the rendered page leaks this checkout\'s absolute path');
});

// Positive control for the refusal above: displayPath must REFUSE a path it cannot name
// symbolically rather than pass it through. Passing it through is how a page that renders
// fine here becomes a permanent red diff in CI.
test('displayPath refuses a path it cannot name symbolically', () => {
  const ctx = R.renderContext();
  assert.throws(() => R.displayPath(ctx, '/somewhere/else/entirely'),
    /neither the repo, the engine checkout nor the engine/);
  assert.strictEqual(R.displayPath(ctx, path.join(repo, 'scripts', 'build-graph.cjs')),
    'scripts/build-graph.cjs');
});

// THE 42-vs-40 COLLAPSE, as a control, driven with the exact wrong input. canonical-name.cjs
// drops the libc qualifier for the published asset NAME, so the release tier's legs publish
// fewer distinct names than there are legs. Rendering `targets()` would draw a fleet that
// looks entirely plausible and is short two machines. Note that checking one name at a time
// cannot catch it — `linux-riscv64` is both a real leg token AND the collapsed name of its
// musl twin — so the renderer checks COVERAGE, and this row watches that fire.
test('the fleet view refuses a fleet drawn from canonical names, and counts LEGS', () => {
  const steps = G.steps();
  const legs = G.legs('release');
  const names = G.targets('release');
  assert.ok(legs.length > names.length,
    'legs and canonical names no longer differ — this control has nothing to prove');

  // The exact wrong input: the canonical asset names, handed in as though they were legs.
  assert.throws(() => R.renderFleet(steps, names, 'release'),
    /not release leg token/,
    `the fleet view accepted ${names.length} canonical names as though they were the ${legs.length} legs`);

  // And a fleet that is merely SHORT, whatever the cause — the property the collapse would
  // have broken, checked without relying on how the short list was produced.
  assert.throws(() => R.renderFleet(steps, legs.slice(0, -2), 'release'),
    new RegExp(`was handed ${legs.length - 2} of the ${legs.length} release legs`),
    'the fleet view drew a fleet two legs short');

  assert.throws(() => R.renderFleet(steps, [], 'release'), /no legs/);

  // And the drawn totals add up to the LEG count, per step — the property the collapse
  // would have quietly broken.
  const fleet = R.fleetTally(steps, legs, 'release');
  for (const row of fleet) {
    const total = row.machines.reduce((n, m) => n + m.legs, 0);
    assert.strictEqual(total, legs.length,
      `${row.id}: the fleet view accounts for ${total} legs, not ${legs.length}`);
  }
});

// The page is a page, not three diagrams in a trench coat: it names the entry point and
// embeds exactly the three views.
test('the page names the entry point and embeds three mermaid blocks', () => {
  const page = R.renderAll();
  assert.match(page, /\.\/build/, 'the page must name the developer entry point');
  const fences = page.match(/^```mermaid$/gm) || [];
  assert.strictEqual(fences.length, 3, `expected 3 mermaid blocks, found ${fences.length}`);
  // Every fence opened is a fence closed. An unbalanced one swallows the rest of the page
  // into a code block, which renders as "fine" in a diff and as garbage on the page.
  assert.strictEqual((page.match(/^```/gm) || []).length % 2, 0,
    'unbalanced code fences — an odd number of ``` lines');
});
