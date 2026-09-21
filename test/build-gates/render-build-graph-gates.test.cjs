'use strict';
// The build gate inside `scripts/render-build-graph.cjs`: nodeSection()'s two refusals.
//
// WHAT IT GUARDS. docs/build.md now carries a section saying which steps of `./build.sh`
// still shell out to `node`, and WHY — that their entry points are ESM, which the CJS
// node-shim loader cannot host. The which is derived (build-graph.cjs's nodeSteps() reads
// the steps' own `run` functions, so a conversion drops a row by itself). The WHY cannot be
// derived from the graph, because it is a property of the entry-point FILES; so instead of
// asserting it in prose, nodeSection() puts every entry point the graph names to an actual
// CommonJS parse and REFUSES when one of them parses.
//
// WHY THAT REFUSAL IS THE LOAD-BEARING ONE. The day someone converts scripts/stage0.mjs to
// CommonJS and leaves the step calling runNode, every other gate on this page stays green:
// the graph still declares five steps, the three views still render, the committed bytes
// still match the renderer, and the section still names the right step. The only thing that
// is wrong is the REASON — the page keeps explaining a CommonJS file by its being ESM. A
// page that is stale in its explanation and fresh in its facts is the exact failure this
// whole generated page exists to prevent, and nothing but this refusal can see it.
//
// WHAT INPUT TRIPS IT (measured): an entry point whose source parses in the CommonJS goal
// (`module.exports = 1;`) while a step still runs it through node. And the second refusal:
// an entry point a step names that is not in the checkout at all, which would otherwise
// leave the section quietly silent about why that step needs node.
//
// WHY THE PURE HALF EXISTS. nodeSection() reads entry points off disk relative to its ctx,
// so a control could only reach its refusal by corrupting the real scripts/stage0.mjs.
// commonJsParseError(src) is the same decision with the I/O lifted out — the split
// build-graph-gates.test.cjs already makes for bundleOutputNamesFrom, and for the same
// stated reason: a test must be able to hand the decision a known-bad input.
//
// The literal relative require below is load-bearing for the production-gate population
// sweep (test/guards-population.cjs), which derives "which guard controls this production
// gate" by reading that exact string out of this file's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../../scripts/render-build-graph.cjs');
const G = require('../../scripts/build-graph.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const REPO = path.resolve(__dirname, '..', '..');

const nodeReasonGuard = defineGuard({
  name: 'render-build-graph refuses an entry point that is no longer ESM',
  read: () => ({
    entries: [...new Set(G.nodeSteps().flatMap((r) => r.entries))].map((rel) => ({
      rel,
      source: fs.readFileSync(path.join(REPO, rel), 'utf8'),
    })),
  }),
  // `examined` counts the entry points the graph actually named. Zero is not "clean": it is
  // either a build that has genuinely stopped needing node — in which case the FLOOR below
  // says so out loud — or a derivation that has stopped seeing the steps.
  scan: (inputs) => ({
    examined: inputs.entries.length,
    findings: inputs.entries
      .filter((e) => R.commonJsParseError(e.source) === null)
      .map((e) => `${e.rel} parses as CommonJS, yet the graph still runs it through node — `
        + `${R.PAGE_REL} explains that dependency by the entry point being ESM, and that `
        + 'explanation is no longer true'),
  }),
  // An entry point after the conversion this page asks for, with the step left calling
  // runNode: unmistakably CommonJS, still shelled out to node.
  control: () => ({ entries: [{ rel: 'scripts/converted.cjs', source: 'module.exports = 1;\n' }] }),
});

guardTests(nodeReasonGuard);

// The refusal itself, driven through nodeSection rather than through the pure half — the
// guard proves the DECISION can fail, this proves the renderer acts on it instead of
// emitting a section with a false explanation in it.
test('nodeSection refuses an entry point that is no longer ESM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-node-section-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'converted.cjs'), 'module.exports = 1;\n');
  const ctx = R.renderContext({ repo: dir });
  const steps = [{ id: 'x', run: (c) => runNode(c, ['scripts/converted.cjs']) }];
  assert.throws(() => R.nodeSection(steps, ctx, 'clode-native'), (e) => {
    assert.match(e.message, /parse\(s\) as CommonJS, yet/);
    assert.match(e.message, /scripts\/converted\.cjs/);
    // It has to say what to do, or the reader is told the page is wrong and left to guess.
    assert.match(e.message, /stop calling\s+runNode/);
    return true;
  });

  // Refusal two: an entry point the graph names and the checkout does not have. Silence
  // here would be a section that says a step needs node and never says why.
  const gone = [{ id: 'y', run: (c) => runNode(c, ['scripts/vanished.mjs']) }];
  assert.throws(() => R.nodeSection(gone, ctx, 'clode-native'), /is not in this checkout/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// commonJsParseError is the measuring device both halves lean on, so it is measured itself,
// in BOTH directions — "a message for everything" and "null for everything" are each green
// for one of them and catastrophic for the other.
test('commonJsParseError tells the CommonJS goal from the module goal', () => {
  assert.strictEqual(R.commonJsParseError('module.exports = 1;\n'), null);
  assert.match(R.commonJsParseError("import x from 'y';\n"), /import statement outside a module/);
  assert.match(R.commonJsParseError('console.log(import.meta.url);\n'), /import\.meta/);
  // A file that merely MENTIONS import.meta in a comment is CommonJS, and a grep for
  // `import` would say otherwise. That is not hypothetical: the first cut of this
  // derivation WAS a grep, and it classified scripts/build-graph.cjs as ESM on the strength
  // of a comment explaining import.meta. Hence a parse.
  assert.strictEqual(
    R.commonJsParseError('// import.meta is not used here\nmodule.exports = 1;\n'), null);
});

// THE FLOOR. The guard above examines whatever entry points the graph names; if that set
// empties, its gate half becomes vacuous and reads exactly like a pass. The honest states
// are two, and this row makes a human pick: either node really is gone from the build — in
// which case this file and the page's section both retire — or the derivation went blind.
test('FLOOR: the steps still name entry points, and every one of them is ESM', () => {
  const entries = [...new Set(G.nodeSteps().flatMap((r) => r.entries))];
  assert.ok(entries.length > 0,
    'no declared step shells out to node any more. If that is real, `./build.sh` is now '
    + 'node-free: retire this guard and the "What still needs node" section with it. If it '
    + 'is not real, build-graph.cjs\'s nodeSteps() has stopped seeing the runNode calls and '
    + 'the page is now silently claiming a node-free build.');
  for (const rel of entries) {
    const abs = path.join(REPO, rel);
    assert.ok(fs.existsSync(abs), `${rel} is named by a step but is not in this checkout`);
    assert.notStrictEqual(R.commonJsParseError(fs.readFileSync(abs, 'utf8')), null,
      `${rel} parses as CommonJS — the page's explanation for it is stale`);
  }
});

// ---- what else the page must not be true by omission about ------------------------------
//
// FINDING 6 of the final whole-branch review. The section above is the best thing on the
// page — derived, measured, and refusing to render a stale explanation — and it left out
// that `./build.sh` also needs `npm` and, on a cold machine, the network:
// scripts/build-clode-main.mjs runs npm into its own toolchain directory whenever esbuild
// does not already load from there. No false sentence, and a clean-clone developer behind a
// firewall still gets the surprise the page promised to prevent. That is the page's OWN
// stated failure mode ("THE PAGE MUST NOT BE TRUE BY OMISSION") arriving as a missing one.
//
// MEASURED, like the CommonJS parse beside it: an entry point counts when its own source
// reaches npm's CLI (requires scripts/lib/npm-cli.cjs, or calls npmCliPath) — a call shape,
// not the word "npm", which appears in that file's comments a dozen times over. Both
// directions, because "everything uses npm" and "nothing does" are each green for one of
// them and wrong for the other.
//
// The fixture `rel`s are BASENAMES, not `scripts/...` paths, and that is not a style
// choice: test/guards-population.test.cjs sweeps this directory for a file that greps the
// staged `cli.cjs` runner for a quote-bearing literal, its READS_CLI_RUNNER signal is
// `\bcli\.cjs\b` — which `npm-cli.cjs` matches — and its regex-literal approximation then
// reads the run between two `/` characters on one line as a scan pattern. A `scripts/` rel
// beside a `'./lib/npm-cli.cjs'` require gave it exactly that shape and made a real gate
// red over a fixture. Measured, both ways: with the paths, that sweep reports this file;
// without them, it reports nothing.
test('npmProvisioningEntries tells an entry point that reaches npm from one that does not', () => {
  assert.deepStrictEqual(R.npmProvisioningEntries([
    { rel: 'installer.mjs', source: "const p = npmCliPath({ prefix: 'x' });\n" },
    { rel: 'requirer.mjs', source: "require('./lib/npm-cli.cjs');\n" },
    { rel: 'talker.mjs', source: 'this file talks about npm install a great deal\n' },
    { rel: 'quiet.mjs', source: 'module.exports = 1;\n' },
  ]), ['installer.mjs', 'requirer.mjs']);
});

// THE FLOOR. If no entry point reaches npm any more, the paragraph must retire rather than
// linger — and if one does, the page has to say so. Either way a human decides, instead of
// the sentence quietly outliving or under-reporting the build.
test('FLOOR: an entry point still provisions with npm, and the page says so', () => {
  const entries = [...new Set(G.nodeSteps().flatMap((r) => r.entries))]
    .map((rel) => ({ rel, source: fs.readFileSync(path.join(REPO, rel), 'utf8') }));
  const npm = R.npmProvisioningEntries(entries);
  assert.ok(npm.length > 0,
    'no entry point the graph names reaches npm any more. If that is real, `./build.sh` no '
    + 'longer needs a package manager or the network: retire the paragraph. If it is not, '
    + 'this measurement has stopped seeing the call.');
  const page = R.renderAll();
  assert.match(page, /It needs `npm` too, and on a cold machine the network/,
    `${npm.join(', ')} reaches npm and the page does not say so — the omission this test `
    + 'exists for');
  for (const rel of npm) {
    assert.ok(page.includes(rel), `${rel} provisions with npm and the page never names it`);
  }
});
