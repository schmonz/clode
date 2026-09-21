'use strict';
// The source phase's JS-bundle step has TWO inputs, and until this gate existed only one
// of them was ever named out loud.
//
//   1. the BUNDLER — a pinned esbuild@0.28.1. CLODE_ESBUILD is the seam that supplies it
//      without npm; without either, `ensureEsbuild` used to die with `spawnSync npm ENOENT`.
//   2. txiki's OWN JS dependency tree — web-streams-polyfill, uuid, getopts and friends —
//      which esbuild BUNDLES INTO THE ENGINE (src/js/polyfills/index.js literally
//      `import 'web-streams-polyfill/polyfill'`). Nothing in the build installs these on
//      purpose: the very same `npm install --no-save esbuild@0.28.1` materializes them as a
//      SIDE EFFECT of running inside the checkout. Hand an operator a bundler and delete
//      node_modules and the run dies with esbuild's own `Could not resolve` — a message
//      about a path, not about a missing provisioning step.
//
// Both halves are invisible on a WARM checkout, which is the state every dev box and every
// cache-hit leg is in. That is the "warm state hides bugs" shape this tree keeps getting
// bitten by, so the subject here is the refusal itself: does it fire on a genuinely cold
// checkout, and does it name both halves precisely enough to act on.
//
// THE PACKAGE LIST IS DERIVED, and these tests are what hold it to that. A hand-maintained
// list of seven names would be correct today and wrong the first time txiki adds an import
// — the same staleness that was found twice in engine-recipe.cjs's FILES. So the module
// under test reads the bare import specifiers out of src/js/** and closes over each
// package's own declared dependencies, and the fixtures below are built to make a
// hard-coded list fail: they import packages with invented names that no real checkout has.
//
// Fixtures only — every tree these tests judge is one they wrote themselves into a mkdtemp.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ESBUILD_PIN, BUNDLE_SOURCE_ROOT, importedPackages, requiredPackages, bundleInputsRefusal,
} = require('../scripts/bundle-inputs-gate.cjs');

// Writes { 'relative/path': 'contents' } into a throwaway tree and hands back its root.
function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-inputs-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

// WHAT AN INSTALLED BUNDLER IS CALLED is the GATE'S decision, not this file's. npm's
// bin-links writes `esbuild` on POSIX and `esbuild.cmd` on Windows, and
// scripts/bundle-inputs-gate.cjs looks for whichever the host uses (the same branch
// ensureEsbuild takes). A fixture that spelled the POSIX name unconditionally therefore built
// a tree the gate CORRECTLY calls incomplete: on windows-latest the "no refusal" test above
// got a refusal that was right about everything (CI run 35494754445, 2223 tests, this one of
// two reds). The product was not wrong; the fixture was.
//
// So the fixture ASKS, rather than guessing or branching on process.platform: it runs the
// gate against a checkout with an EMPTY node_modules and reads back the path the refusal says
// it looked in. The name cannot drift from the product because it IS the product's answer,
// and it stays one seam -- the gate's own -- rather than a second copy of the branch. (The
// alternative was exporting the name from scripts/bundle-inputs-gate.cjs, which is engine
// recipe: a one-line export there rebuilds every leg in the fleet.)
let bundlerName = null;
function checkoutBundlerName() {
  if (bundlerName) return bundlerName;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-inputs-bin-'));
  try {
    fs.mkdirSync(path.join(dir, 'src/js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/js/probe.js'), 'export const probe = 1;\n');
    const why = bundleInputsRefusal({ dir, env: {}, hasNpm: false });
    const m = /looked in (.+?) \(the checkout\)/.exec(why || '');
    assert.ok(m, 'the gate must name the path it looked for a bundler in — this fixture reads '
      + `the filename back out of it:\n${why}`);
    bundlerName = path.basename(m[1].trim());
    assert.match(bundlerName, /^esbuild/,
      `the checkout bundler the gate looks for must still be an esbuild: ${bundlerName}`);
    return bundlerName;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The smallest tree the gate considers complete: one import, that package installed, and a
// bundler on hand. Callers subtract from it to model the states that must refuse.
function completeTree(t, extra = {}) {
  return fixture(t, {
    'src/js/polyfills/index.js': "import 'widget-polyfill/polyfill';\nexport const p = 1;\n",
    'src/js/stdlib/uuid.js': "import { v4 } from 'gizmo-uuid';\nexport const u = v4;\n",
    'node_modules/widget-polyfill/package.json': '{"name":"widget-polyfill","version":"1.0.0"}\n',
    'node_modules/gizmo-uuid/package.json': '{"name":"gizmo-uuid","version":"1.0.0"}\n',
    [`node_modules/.bin/${checkoutBundlerName()}`]: '#!/bin/sh\nexit 0\n',
    ...extra,
  });
}

test('the package list is DERIVED from what src/js actually imports, not from package.json', (t) => {
  const dir = completeTree(t, {
    // A dependency list full of things no bundle imports — eslint, typedoc, gh-pages —
    // is exactly what txiki's real package.json looks like. Naming those as build inputs
    // would be a refusal an operator cannot act on, so the derivation must not read here.
    'package.json': JSON.stringify({
      dependencies: { eslint: '10.4.0', 'gh-pages': '6.3.0', 'widget-polyfill': '1.0.0' },
      devDependencies: { typedoc: '0.28.19' },
    }),
  });
  const found = [...importedPackages(dir).keys()].sort();
  assert.deepStrictEqual(found, ['gizmo-uuid', 'widget-polyfill'],
    'only the packages src/js/** imports are build inputs');
});

test('relative, tjs: and node: specifiers are not packages', (t) => {
  const dir = fixture(t, {
    'src/js/core/index.js': [
      "import './neighbour.js';",
      "import '../stdlib/thing.js';",
      "import core from 'tjs:internal/core';",
      "import { spawnSync } from 'node:child_process';",
      "import getopts from 'gizmo-getopts';",
      '',
    ].join('\n'),
  });
  assert.deepStrictEqual([...importedPackages(dir).keys()], ['gizmo-getopts']);
});

test('a scoped package resolves to @scope/name, and the import SITE is recorded', (t) => {
  const dir = fixture(t, {
    'src/js/stdlib/tar.js': "export { UntarStream } from '@acme/std__tar/untar-stream';\n",
  });
  const found = importedPackages(dir);
  assert.deepStrictEqual([...found.keys()], ['@acme/std__tar']);
  assert.strictEqual(found.get('@acme/std__tar'), 'src/js/stdlib/tar.js',
    'the refusal has to tell the reader WHERE the need comes from');
});

test('the needed set closes over each installed package\'s own declared dependencies', (t) => {
  const dir = completeTree(t, {
    'node_modules/widget-polyfill/package.json':
      '{"name":"widget-polyfill","dependencies":{"widget-inner":"1.0.0"}}\n',
  });
  const { missing } = requiredPackages(dir);
  assert.deepStrictEqual(missing.map((m) => m.pkg), ['widget-inner'],
    'a transitive dependency of a bundled package is a build input too — esbuild follows it');
  assert.match(missing[0].why, /widget-polyfill/,
    'the refusal must say which package pulled the missing one in');
});

test('a complete tree with a bundler produces NO refusal (the warm path is untouched)', (t) => {
  const dir = completeTree(t);
  assert.strictEqual(bundleInputsRefusal({ dir, env: {}, hasNpm: false }), null);
});

// And the name the fixture just derived is LOAD-BEARING: the gate accepts one exact filename
// in node_modules/.bin, so a tree carrying some other spelling is still a cold one. Without
// this, "ask the gate what it looks for" could be satisfied by a gate that looked for nothing,
// and the test above would pass on a checkout the source phase cannot actually bundle from.
test('a bundler under any other filename is not the bundler the gate looks for', (t) => {
  const dir = completeTree(t);
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.renameSync(path.join(bin, checkoutBundlerName()), path.join(bin, 'esbuild-ish'));
  const why = bundleInputsRefusal({ dir, env: {}, hasNpm: false });
  assert.ok(why, 'a differently-named executable must not satisfy the bundler half');
  assert.match(why, /no esbuild@0\.28\.1/, `and the refusal names the half that is missing:\n${why}`);
  assert.match(why, new RegExp(checkoutBundlerName().replace('.', '\\.')),
    `naming the filename it wanted, which is what an operator has to produce:\n${why}`);
});

test('a COLD checkout with no npm refuses, naming BOTH halves and every missing package', (t) => {
  const dir = completeTree(t);
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  const why = bundleInputsRefusal({ dir, env: {}, hasNpm: false });
  assert.ok(why, 'a cold checkout with no npm cannot build the bundles and must say so');
  // half one: the bundler, by pin and by seam.
  assert.match(why, /esbuild@0\.28\.1/, `the refusal must name the pin:\n${why}`);
  assert.match(why, /CLODE_ESBUILD/, `the refusal must name the override:\n${why}`);
  // half two: the dep tree, by package AND by the import that needs it.
  assert.match(why, /widget-polyfill/, `the refusal must name the missing packages:\n${why}`);
  assert.match(why, /gizmo-uuid/, `the refusal must name ALL of them, not the first:\n${why}`);
  assert.match(why, /src\/js\/polyfills\/index\.js/,
    `the refusal must point at the import that needs it:\n${why}`);
});

test('npm on PATH with no bundler is NOT a refusal: that install materializes both halves', (t) => {
  const dir = completeTree(t);
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  assert.strictEqual(bundleInputsRefusal({ dir, env: {}, hasNpm: true }), null,
    'ensureEsbuild will `npm install` inside the checkout, which brings the dep tree with '
    + 'it — refusing here would break every host that HAS Node');
});

test('THE HALF NO RECON FOUND: a bundler in hand but no dep tree still refuses', (t) => {
  const dir = completeTree(t);
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  const bundler = path.join(dir, 'esbuild');
  fs.writeFileSync(bundler, '#!/bin/sh\nexit 0\n');
  // npm PRESENT on purpose: ensureEsbuild short-circuits on the override and never
  // installs, so npm's presence repairs nothing here. This is the state a future
  // provisioning step lands in if it supplies only the bundler.
  const why = bundleInputsRefusal({ dir, env: { CLODE_ESBUILD: bundler }, hasNpm: true });
  assert.ok(why, 'an esbuild with nothing to bundle is not a satisfied source phase');
  assert.match(why, /widget-polyfill/, `name the tree that is missing:\n${why}`);
  assert.doesNotMatch(why, /no esbuild/,
    `the bundler was supplied — claiming otherwise sends the reader after the wrong half:\n${why}`);
});

test('a CLODE_ESBUILD that points at nothing is a named refusal, not a silent miss', (t) => {
  const dir = completeTree(t);
  const why = bundleInputsRefusal({ dir, env: { CLODE_ESBUILD: path.join(dir, 'nope') }, hasNpm: false });
  assert.ok(why, 'an override pointing at a nonexistent path must not fall through to "fine"');
  assert.match(why, /nope/, `the refusal must quote the path it was handed:\n${why}`);
});

test('a checkout with no src/js at all refuses instead of reporting zero inputs needed', (t) => {
  const dir = fixture(t, { 'CMakeLists.txt': '# not a txiki tree\n' });
  const why = bundleInputsRefusal({ dir, env: {}, hasNpm: true });
  assert.ok(why, 'an empty derivation is evidence the scan is broken, not evidence of health');
  assert.match(why, new RegExp(BUNDLE_SOURCE_ROOT.replace('/', '\\/')));
});

test('the pin the gate reports is one string, shared with the refusal text', () => {
  assert.strictEqual(ESBUILD_PIN, 'esbuild@0.28.1');
});
