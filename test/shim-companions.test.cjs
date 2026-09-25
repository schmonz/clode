'use strict';
// shim-companions — Phase 3 (CellSegmenter), Task 5. bun-shim.cjs requires
// unicode-text.cjs from its OWN directory (`require(__dirname + '/unicode-text.cjs')`,
// Task 6) so it can defer to the one clustering/width implementation instead of
// carrying its own copy. bun-shim.cjs is never staged by module resolution — it travels
// as raw bytes into four different packagings (the extract cache, a quaude VFS root
// member, a naude SEA asset, and the builder-role member list a self-blobulated clode
// re-stages from) — so every site that stages bun-shim.cjs must ALSO stage
// unicode-text.cjs beside it, or the product dies at load the first time that require()
// runs, in exactly the one packaging that forgot it. Precedent:
// libexec/target-update-check.cjs already travels this way and is staged at all four
// sites; this guard is the same claim for its new sibling.
//
// R9 (controller ruling, 2026-09-24): this must be a defineGuard, not a plain
// node:test that reads sources and pattern-matches — that shape is exactly what
// test/guards-population.test.cjs's classifier calls "scanner-shaped", and an
// unregistered scanner-shaped test moves the UNMIGRATED ratchet instead of the
// production-gate population it actually belongs to.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests, checkGate, BROKEN } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');

// The four staging sites (task-5 brief): the extract cache (clode-extract.cjs), the
// quaude VFS root member list (quaude-blobulate.js — both the builder-role libexec
// loop AND the quaude-role member push), the naude SEA asset maps (build-naude.mjs),
// and the SEA-materialize call naude-entry.cjs makes at boot.
//
// PLUS the test harnesses that stage the REAL bun-shim.cjs beside a bundle or a probe
// (task 6, 2026-09-24). They are packagings too, and this list missed them: the day
// bun-shim.cjs began to require its companion, 33 suite tests died with "Cannot find
// module .../unicode-text.cjs" (isolated-shim.cjs's fail-loud children, oracle-models.cjs's
// staged provider for every agentic/model oracle, the e2e fixture, the graph runner).
// Harnesses that write a FAKE bun-shim.cjs (naude-build, dep-closure) stage nothing real
// and are not sites.
const SITES = [
  'libexec/clode-extract.cjs',
  'libexec/quaude-blobulate.js',
  'scripts/build-naude.mjs',
  'libexec/naude-entry.cjs',
  'test/isolated-shim.cjs',
  'test/oracle-models.cjs',
  'test/e2e-fixture.test.cjs',
  'test/graph-runner.test.cjs',
];

// read() — the only I/O: this repo's own site sources. Nothing this guard could
// write to; it never touches ~/.local/share/clode or any build output.
function readSites() {
  return { sites: SITES.map((rel) => ({ rel, src: fs.readFileSync(path.join(REPO, rel), 'utf8') })) };
}

// PURE. Two findings shapes, per R9:
//   - a site that no longer names 'bun-shim.cjs' at all — the gate itself would be
//     reading the wrong file (the site was renamed/rewritten out from under this list),
//     which is worth saying loudly rather than silently reporting "fine, nothing to see".
//   - a site that names 'bun-shim.cjs' but never 'unicode-text.cjs' — exactly the defect
//     this guard exists to catch: bun-shim staged somewhere unicode-text is not.
// `examined` is the site count, matching `floor` below one-for-one — a shrinking SITES
// list (someone deleted an entry without meaning to) trips the floor directly.
function scanCompanions({ sites }) {
  const findings = [];
  for (const { rel, src } of sites) {
    const namesShim = /['"]bun-shim\.cjs['"]/.test(src);
    if (!namesShim) {
      findings.push(`${rel}: no longer names 'bun-shim.cjs' — this gate is reading the wrong file`);
      continue;
    }
    if (!/['"]unicode-text\.cjs['"]/.test(src)) {
      findings.push(`${rel}: stages bun-shim.cjs but never unicode-text.cjs`);
    }
  }
  return { findings, examined: sites.length };
}

// The control (R9): a single synthetic source naming ONLY 'bun-shim.cjs' — the
// mainline defect this guard exists to catch (a site that grew a bun-shim staging
// step and never grew the matching unicode-text one).
function controlInputs() {
  return { sites: [{ rel: 'synthetic/only-bun-shim.cjs', src: "const shim = 'bun-shim.cjs';\n" }] };
}

const guard = defineGuard({
  name: 'shim-companions',
  floor: 8,
  read: readSites,
  scan: scanCompanions,
  control: controlInputs,
});
guardTests(guard);

// The control models ONE of the two detectors; this proves the other — a synthetic
// site that has stopped naming bun-shim.cjs at all — also produces a finding, and
// names which site by rel path.
test('a site that no longer names bun-shim.cjs at all is its own finding', () => {
  const r = scanCompanions({ sites: [{ rel: 'synthetic/renamed.cjs', src: "const x = 1;\n" }] });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /synthetic\/renamed\.cjs: no longer names 'bun-shim\.cjs'/);
});

// A site naming both is clean — the guard does not flag the real sites once
// they have been fixed (proven again for real below, but this pins the shape with a
// synthetic input independent of the real tree).
test('a site naming both bun-shim.cjs and unicode-text.cjs is clean', () => {
  const r = scanCompanions({
    sites: [{ rel: 'synthetic/clean.cjs', src: "const a = 'bun-shim.cjs'; const b = 'unicode-text.cjs';\n" }],
  });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 1);
});

test('floor fires: shim-companions goes BROKEN if fewer than 8 sites are examined', () => {
  const r = checkGate({
    name: 'floor-probe', floor: guard.floor,
    read: () => ({ sites: [] }),
    scan: scanCompanions,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

module.exports = { SITES, readSites, scanCompanions, controlInputs, guard };
