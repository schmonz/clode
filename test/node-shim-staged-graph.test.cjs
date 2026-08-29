'use strict';
// THE RATCHET for the class of bug that killed five CI jobs at once on 2.1.243+.
//
// Upstream Claude Code emits `import.meta.require("/$bunfs/root/chunk-<hash>.js")` inside
// its own module graph. Nothing at runtime can answer that: under tjs the node-shim raises
// `cannot resolve '/$bunfs/root/chunk-….js'`, under node it is ERR_REQUIRE_CYCLE_MODULE.
// Staging (libexec/clode-extract.cjs) merges the strongly connected groups so none survive.
//
// This asserts that on a REAL provider, at the staging step, where it is one cheap check —
// rather than leaving it to be discovered by a `-p` turn that dies with an empty stdout and
// an exit code of 0. Gated on a provider and on a tjs engine (staging needs one to ask for
// module metadata), which is exactly where CI can run it: node-shim-oracle and
// node-shim-oracle-darwin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const plan = require('../libexec/bun-graph-plan.cjs');
const scc = require('../libexec/graph-scc-merge.cjs');
const { stageCli } = require('./oracle-models.cjs');

function providerBin() {
  const p = process.env.CLODE_PROVIDER_BIN;
  return p && fs.existsSync(p) ? p : null;
}

test('staged graph: no require of a graph module survives staging', (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-graph-'));
  const { cacheDir } = stageCli(bin, { dir });
  const graph = path.join(cacheDir, 'graph.json');
  if (!fs.existsSync(graph)) {
    // A pre-2.1.243 provider carves to a single cli.cjs and has no graph at all. That is a
    // real shape, not a skip-worthy accident, so say which one we saw.
    t.skip(`${bin} is not a code-split provider (no graph.json staged)`);
    return;
  }
  const doc = JSON.parse(fs.readFileSync(graph, 'utf8'));

  const residual = scc.residualCyclicRequires(doc, plan);
  assert.deepStrictEqual(residual.slice(0, 5), [],
    `${residual.length} require(s) of a graph module survived staging — every target built `
    + 'from this graph dies the first time one is reached');

  // And when there WERE cyclic requires to remove, the stamp says so: an unmerged graph
  // that happens to have none must not be mistaken for a merged one.
  const had = Array.isArray(doc.cyclicRequires) ? doc.cyclicRequires.length : 0;
  if (had) {
    assert.ok(doc.sccMerge, `graph reported ${had} cyclic require(s) but carries no sccMerge stamp`);
    assert.strictEqual(doc.sccMerge.format, scc.MERGE_FORMAT);
  }

  // The runner every oracle stages and every naude embeds is derived from THIS doc, so it
  // inherits the property. Cheap enough to confirm rather than assume.
  //
  // The needle allows ANY run of backslashes before the quote: graphRunnerSource carries
  // the sources through two rounds of JSON.stringify, so the literal text in cli.cjs is
  // `require(\\\"/$bunfs/root/chunk-`. Pinning one escaping depth would make this assertion
  // quietly stop testing anything the day that encoding changes.
  const runner = fs.readFileSync(path.join(cacheDir, 'cli.cjs'), 'utf8');
  assert.doesNotMatch(runner, /require\(\\*"\/\$bunfs\/root\/chunk-/,
    'the staged graph runner still carries a require of an upstream chunk');
});
