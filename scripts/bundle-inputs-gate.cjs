'use strict';
// The source phase's JS-bundle step has TWO inputs. This file is the refusal that names
// both of them BEFORE anything tries to use either.
//
// WHAT THE STEP NEEDS
//   1. THE BUNDLER — esbuild, at the pin below. `ensureEsbuild` (scripts/build-tjs.cjs)
//      resolves it from CLODE_ESBUILD or the checkout's node_modules, and otherwise shells
//      to `npm install`. npm is a Node program, so a node-free host has none.
//   2. TXIKI'S OWN JS DEPENDENCY TREE — web-streams-polyfill, uuid, getopts and the rest.
//      esbuild BUNDLES these into the engine (src/js/polyfills/index.js literally
//      `import 'web-streams-polyfill/polyfill'`), so they are build INPUTS, as much as any
//      .c file. Nothing in this build installs them deliberately: the one
//      `npm install --no-save esbuild@0.28.1` in ensureEsbuild materializes them as a SIDE
//      EFFECT of running inside a checkout whose own package.json declares them.
//
// WHY A GATE AND NOT A FIX. Provisioning both halves offline, above build-tjs.cjs's async
// boundary, is a spec-sized job. What this file ends is the half-measure being SILENT: on
// a warm checkout (every dev box, every cache-HIT leg) both inputs are satisfied by
// accident and nothing about them is visible, and on a cold one the build used to fail
// deep inside the bundle step — with `spawnSync npm ENOENT` before CLODE_ESBUILD existed,
// then with a refusal that named only half one, and, handed a bundler, with esbuild's own
// `Could not resolve "web-streams-polyfill/polyfill"`. All three read as a broken checkout
// rather than as a missing provisioning step, and all three arrive AFTER the whole patch
// stack and ~50 source fixups have already run.
//
// THE LIST IS DERIVED, NOT DECLARED, and that is load-bearing. Two hand-maintained lists in
// this tree have gone stale and been caught by accident (engine-recipe.cjs's FILES, twice),
// so the packages named here are read out of the tree being built:
//   * DIRECT: every bare import specifier appearing in src/js/** — which is precisely the
//     set esbuild will try to resolve. NOT txiki's package.json `dependencies`, which also
//     carries eslint, typedoc, gh-pages and @stylistic — real dependencies of the project,
//     but not of the bundle step. Naming those in a refusal would send an operator to
//     provision four packages no bundle reads, and a refusal an operator cannot act on is
//     how a gate teaches people to bypass it.
//   * TRANSITIVE: each named package's own declared `dependencies`, closed over. Measured
//     on the real checkout, the direct scan finds 7 packages and the bundles' own esbuild
//     metafile records 10 — @jridgewell/resolve-uri, @jridgewell/sourcemap-codec and
//     @jsr/std__streams arrive only through their parents. A direct-only check would pass a
//     tree that still cannot bundle. The closure walks what each package DECLARES, which is
//     exactly what an `npm install` of it materializes, so on any npm-produced tree it
//     over-demands nothing.
//
// KEPT OUT OF build-tjs.cjs on purpose: this is a decision, and decisions in this build
// live in CJS siblings (depscan-verdict.cjs, ar-determinism.cjs, ccache-launcher.cjs) so a
// test can feed them a known-bad tree without a 785MB checkout and a cmake run.
const fs = require('node:fs');
const path = require('node:path');

// The pin, spelled here and in ensureEsbuild's own body (which must stay self-contained:
// test/esbuild-edge.test.cjs extracts that function's TEXT and evaluates it standalone, so
// it cannot require this file). test/esbuild-edge.test.cjs holds the two spellings to each
// other, so they cannot drift apart silently.
const ESBUILD_PIN = 'esbuild@0.28.1';
// Where the bundle step's JS lives. Every esbuild entry point (JS_BUNDLES plus every
// src/js/stdlib/*.js) is under here, so scanning it is a superset of what the bundles
// import and a subset of nothing — there is no second source root to miss.
const BUNDLE_SOURCE_ROOT = 'src/js';

// A bare specifier, as an import/export/require can spell one. Deliberately textual: the
// alternative is resolving the module graph, which needs a resolver (esbuild) that may be
// the very thing missing. A superset here is harmless — an extra package named in a refusal
// is one an npm-installed checkout already has — while a miss is a refusal that lies.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*|\bimport\(\s*|\brequire\(\s*)(['"])([^'"\n]+)\1/g;
// A package specifier and nothing else: `pkg`, `@scope/pkg`, either with a subpath. This
// rejects the false positives a purely positional scan collects — a quoted argument that
// happens to follow the word `from`, a URL, a `tjs:`/`node:` builtin (both carry a colon),
// and anything relative or absolute.
const PACKAGE_SPECIFIER = /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w./-]*)?$/;

function jsFilesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next);
      else if (e.name.endsWith('.js')) out.push(next);
    }
  };
  walk(BUNDLE_SOURCE_ROOT);
  return out.sort();
}

function packageRoot(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Map of package name -> the src/js/** file whose import first named it. The VALUE is why
// this returns a Map and not a Set: a refusal that says "web-streams-polyfill is missing"
// is worse than one that says where the need comes from, and the import site is the only
// honest answer to "who asked for this".
function importedPackages(dir) {
  const found = new Map();
  for (const rel of jsFilesUnder(dir)) {
    let src;
    try { src = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(SPECIFIER)) {
      const spec = m[2];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) continue;
      if (!PACKAGE_SPECIFIER.test(spec)) continue;
      const pkg = packageRoot(spec);
      if (!found.has(pkg)) found.set(pkg, rel);
    }
  }
  return found;
}

// The full input set, closed over declared dependencies, and which of it is absent.
// `why` is carried for every entry so the refusal can explain each name it prints:
// an import site for a direct need, a parent package for a transitive one.
function requiredPackages(dir) {
  const why = new Map();
  const queue = [];
  for (const [pkg, site] of importedPackages(dir)) {
    why.set(pkg, `imported by ${site}`);
    queue.push(pkg);
  }
  const missing = [];
  while (queue.length) {
    const pkg = queue.shift();
    const manifest = path.join(dir, 'node_modules', pkg, 'package.json');
    let declared;
    try { declared = JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies || {}; } catch {
      // Unreadable and absent are the same fact here: the bundle step cannot read it
      // either. Recorded as missing rather than thrown, so ONE refusal can list them all.
      missing.push({ pkg, why: why.get(pkg) });
      continue;
    }
    for (const dep of Object.keys(declared)) {
      if (why.has(dep)) continue;
      why.set(dep, `declared dependency of ${pkg}`);
      queue.push(dep);
    }
  }
  return { needed: why, missing };
}

// Which bundler the source phase would use, WITHOUT installing anything — the read-only
// half of ensureEsbuild's resolution, in the same order it resolves.
function esbuildStatus(dir, env) {
  const override = env.CLODE_ESBUILD;
  if (override) {
    return fs.existsSync(override)
      ? { bin: override, from: 'CLODE_ESBUILD' }
      : { bin: null, lookedIn: override, from: 'CLODE_ESBUILD' };
  }
  const bin = path.join(dir, 'node_modules', '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  return fs.existsSync(bin)
    ? { bin, from: 'the checkout' }
    : { bin: null, lookedIn: bin, from: 'the checkout' };
}

// null when the source phase can build its bundles; otherwise the whole refusal, as text.
//
// THE ONE CASE THAT IS NOT A REFUSAL, and it is the reason this takes `hasNpm`: no bundler
// AND npm on PATH. ensureEsbuild then runs `npm install --no-save <pin>` inside the
// checkout, which brings the pin AND (side effect, see the header) the dep tree. Refusing
// there would break every host that has Node — which is every host that works today.
// Note what that does NOT cover: a bundler supplied via CLODE_ESBUILD makes ensureEsbuild
// return early, so npm's presence repairs nothing, and a missing dep tree is a refusal even
// on a host with Node.
function bundleInputsRefusal({ dir, env = process.env, hasNpm }) {
  if (!fs.existsSync(path.join(dir, BUNDLE_SOURCE_ROOT))) {
    return `the source phase cannot find ${BUNDLE_SOURCE_ROOT} in ${dir}, so it cannot tell `
      + 'what the JS bundle step needs.\n'
      + '  CAUSE: this is not a txiki.js checkout, or it is a partial one.\n'
      + '  FIX: delete it and let the source phase re-clone, or point CLODE_TJS_VENDOR at '
      + 'the parent of a real checkout.';
  }
  const esbuild = esbuildStatus(dir, env);
  const { missing } = requiredPackages(dir);
  if (!esbuild.bin && hasNpm) return null;      // ensureEsbuild's npm install supplies both
  if (esbuild.bin && missing.length === 0) return null;

  const halves = [];
  if (!esbuild.bin) {
    halves.push(`the BUNDLER: no ${ESBUILD_PIN}, looked in ${esbuild.lookedIn} (${esbuild.from}).\n`
      + `      FIX: set CLODE_ESBUILD to an ${ESBUILD_PIN} executable, or run this phase on a `
      + 'host with Node so npm can install one. An esbuild found on PATH is deliberately NOT '
      + 'accepted: the pin is load-bearing, because a different minifier changes the bundles '
      + 'and therefore the bytecode arrays the engine ships.');
  }
  if (missing.length) {
    const named = missing.map((m) => `        ${m.pkg} (${m.why})`).join('\n');
    halves.push("txiki's OWN JS dependency tree, which esbuild bundles INTO the engine: "
      + `${missing.length} missing.\n${named}\n`
      + `      FIX: \`npm install\` inside ${dir} (needs Node), or restore a vendor checkout `
      + 'whose node_modules already carries them. Nothing else installs these — the '
      + `\`npm install --no-save ${ESBUILD_PIN}\` the bundler half runs only materializes `
      + 'them as a side effect of running inside this checkout, so supplying CLODE_ESBUILD '
      + 'alone does not.');
  }
  const body = halves.map((h, i) => `  [${i + 1}/${halves.length}] ${h}`).join('\n');
  return 'the source phase cannot build the txiki JS bundles from this checkout.\n'
    + `${body}\n`
    + `  This list is DERIVED from the tree, not hard-coded: the direct names are every bare `
    + `import under ${BUNDLE_SOURCE_ROOT}, closed over the declared dependencies of each `
    + 'package that IS installed (a package that is missing cannot be asked what it needs, '
    + 'so install these and re-run to learn whether they pull in more). It is checked '
    + 'before the source fixups and the bundle step, rather than from inside them, so a '
    + 'cold checkout is refused by name instead of failing tens of seconds later as an '
    + 'ENOENT or a bundler exiting nonzero.';
}

module.exports = {
  ESBUILD_PIN, BUNDLE_SOURCE_ROOT, importedPackages, requiredPackages, esbuildStatus,
  bundleInputsRefusal,
};
