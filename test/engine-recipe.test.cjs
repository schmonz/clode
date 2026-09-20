'use strict';
// Ties the engine RECIPE (scripts/engine-recipe.mjs) to the one place that
// previously owned the answer — the tjs cache key in
// .github/actions/build-leg/action.yml — and pins the properties the recipe is
// worthless without: determinism, cwd-independence, and sensitivity to the very
// files a stale engine would differ in.
//
// WHY THE SET IS FROZEN HERE. The file set was not invented for the recipe; it
// was lifted verbatim from the cache key, which is battle-tested (its comment
// records a version-blind key silently smoking the WRONG binary). Freezing it in
// a test is what makes "the action and the recipe agree" checkable now that the
// action no longer spells the list out. A narrowing edit — dropping a glob,
// typoing a directory — is exactly the change that would make every tree hash
// identically and re-blind the drift check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const ACTION = path.join(REPO, '.github/actions/build-leg/action.yml');
const SCRIPT = path.join(REPO, 'scripts/engine-recipe.mjs');

// The set the tjs cache key covered before it was moved into engine-recipe.mjs.
const EXPECTED_SET = [
  'spike/quickjs/PINS.md',
  'spike/quickjs/patches/*.patch',
  // ADDED 2026-08-22, deliberately WIDER than the historical cache-key list:
  // the cosmo leg's patches live here and were never covered, so editing one
  // did not move the engine identity. See scripts/engine-recipe.mjs.
  'patches/*.patch',
  'scripts/build-tjs.cjs',
  // ADDED 2026-09-19: build-tjs.cjs's own require graph split into modules
  // that ARE the orchestration (source-reset, the API-floor sanity check, the
  // two halves of the hermeticity gate, the ccache launcher, and the path
  // tags); only the pre-split entry point was ever in this set. See
  // scripts/engine-recipe.mjs.
  'scripts/tjs-source-reset.cjs',
  'scripts/engine-api-floor.cjs',
  'scripts/build-depscan.cjs',
  'scripts/depscan-verdict.cjs',
  // ADDED 2026-09-19: the same rule, applied honestly — there were SIX direct requires,
  // not four. The test below derives them from build-tjs.cjs rather than counting again.
  'scripts/ccache-launcher.cjs',
  'scripts/platform-tag.cjs',
  // ADDED 2026-09-19: the deterministic-archive decision -- whether cmake gets `ar qcD` /
  // `ranlib -D` archive rules or rides ZERO_AR_DATE. It decides what the engine is ASSEMBLED
  // from, the way ccache-launcher.cjs decides what it is compiled with. The derived check
  // below named it the moment build-tjs.cjs required it.
  'scripts/ar-determinism.cjs',
  // ADDED 2026-08-29: the netbsd-sparc in-guest bake recipe IS that leg's
  // compile, and editing it used to move nothing — so the cache could restore an
  // engine built by a different recipe. See scripts/engine-recipe.mjs.
  'spike/quickjs/qemu/ci-guest-bake.sh',
  'scripts/*.toolchain.cmake',
  'spike/quickjs/atomic-shim.c',
  'ci/osxcross-darwin/Dockerfile',
];

const load = () => import(require('node:url').pathToFileURL(SCRIPT).href);
const run = (args, opts = {}) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO, ...opts }).trim();

test('FILES covers the tjs cache key set, plus the cosmo patches', async () => {
  const { FILES } = await load();
  assert.deepStrictEqual([...FILES], EXPECTED_SET);
});

// DERIVED, NOT HAND-COUNTED. The four-then-six modules under 'scripts/' in EXPECTED_SET are
// there because build-tjs.cjs REQUIRES them, and twice now that hand-maintained list has
// been found short of the real require graph: 02bdee9 added four and called them "the
// modules build-tjs.cjs requires directly" when there were six, missing
// scripts/platform-tag.cjs and -- added one commit earlier on the very same branch --
// scripts/ccache-launcher.cjs, which decides what compiler invocation the engine is built
// with. Rather than fix the list a second time and wait for the third, this reads the graph
// out of the file and holds FILES to it. A new `require('./foo.cjs')` in build-tjs.cjs now
// goes red HERE, at the moment it is added, instead of in a review months later.
//
// DEPTH ONE, deliberately, and this is the rule the list is judged against: the DIRECT
// requires. Going transitive would pull in libexec/clode-hosttools.cjs and everything under
// it -- defensible (widening is always safe for a cache key) but a much larger blast radius
// per edit, and not the rule anyone has written down. If that changes, change it here and
// this test follows.
function directLocalRequires(src, fromDir) {
  const out = new Set();
  for (const m of src.matchAll(/require\('(\.[^']*)'\)/g)) {
    out.add(path.posix.normalize(path.posix.join(fromDir, m[1])));
  }
  return [...out].sort();
}

test("FILES covers every local module build-tjs.cjs requires (derived from the file, not a list)", async () => {
  const { FILES } = await load();
  const src = fs.readFileSync(path.join(REPO, 'scripts/build-tjs.cjs'), 'utf8');
  const required = directLocalRequires(src, 'scripts');
  assert.ok(required.length >= 6, `expected build-tjs.cjs to require several local modules, got ${required}`);
  const missing = required.filter((rel) => !FILES.includes(rel));
  assert.deepStrictEqual(missing, [],
    'scripts/build-tjs.cjs requires these modules, and editing one changes what the engine is '
    + 'built from (or what it is verified against) while moving NO recipe hash -- so the tjs '
    + 'cache would restore an engine built by a different recipe than the tree now holds:\n'
    + missing.join('\n'));
});

test('PROOF: the derived-requires check really reads the graph', () => {
  assert.deepStrictEqual(
    directLocalRequires("const a = require('./one.cjs');\nconst b = require('../libexec/two.cjs');\n"
      + "const c = require('node:fs');\nconst d = require('semver');\n", 'scripts'),
    ['libexec/two.cjs', 'scripts/one.cjs'],
    'relative requires must be resolved repo-root-relative, and bare/builtin ones ignored');
});

// PURE: `yml` is the already-read build-leg/action.yml text.
function scanCacheKeyWiring({ yml }) {
  const findings = [];
  let examined = 0;

  examined++;
  const key = yml.split('\n').find((l) => /^\s*key: tjs-/.test(l));
  if (!key) {
    findings.push('no tjs cache key line in build-leg/action.yml');
  } else {
    examined++;
    if (!/steps\.recipe\.outputs\.hash/.test(key)) {
      findings.push('the tjs cache key must consume scripts/engine-recipe.mjs, not its own file list');
    }
    examined++;
    if (/hashFiles\(/.test(key)) {
      findings.push('the engine-source list is back inline in the cache key — it must have exactly one home');
    }
  }

  examined++;
  if (!/run: echo "hash=\$\(node scripts\/engine-recipe\.mjs\)"/.test(yml)) {
    findings.push('the step that produces steps.recipe.outputs.hash is missing');
  }

  return { findings, examined };
}

const cacheKeyGuard = defineGuard({
  name: 'engine-recipe-cache-key-wiring',
  read: () => ({ yml: fs.readFileSync(ACTION, 'utf8') }),
  scan: scanCacheKeyWiring,
  // I2 (coordinator, 2026-09-04): table-driven — a fixed set of markers checked in ONE
  // named action file. Floored at the exact measured count (4).
  floor: 4,
  // Models the exact regression this pins: the cache key re-inlining the file
  // list via hashFiles(...) instead of consuming the recipe's own hash output.
  control: () => ({
    yml: '      key: tjs-${{ hashFiles(\'spike/quickjs/**\') }}\n',
  }),
});
guardTests(cacheKeyGuard);

test('the recipe is a stable sha256 and does not depend on cwd', () => {
  const a = run([]);
  const b = run([]);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(a, b, 'two runs over an unchanged tree disagreed');
  assert.strictEqual(run([], { cwd: require('node:os').tmpdir() }), a, 'the recipe moved with cwd');
  assert.strictEqual(run(['--short']), a.slice(0, 12));
});

test('the expanded set is every tracked engine source, and only those', async () => {
  const { recipeDetail, worktreeSource } = await load();
  const paths = recipeDetail(worktreeSource(REPO)).files.map((f) => f.path);
  assert.deepStrictEqual([...paths].sort(), paths, 'file list is not byte-sorted');
  assert.ok(paths.includes('spike/quickjs/PINS.md'));
  assert.ok(paths.includes('spike/quickjs/atomic-shim.c'));
  assert.ok(paths.includes('ci/osxcross-darwin/Dockerfile'));
  assert.ok(paths.filter((p) => p.endsWith('.patch')).length >= 20, 'the patch glob matched almost nothing');
  assert.ok(paths.every((p) => !path.posix.basename(p).startsWith('._')),
    'AppleDouble sidecars leaked into the recipe — it would differ between this mount and a Linux runner');
  // Every entry's sha is the sha256 of the file's real bytes.
  for (const f of recipeDetail(worktreeSource(REPO)).files.slice(0, 3)) {
    const want = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f.path))).digest('hex');
    assert.strictEqual(f.sha, want, `${f.path}`);
  }
});

// A memory-backed source: the adversarial cases without touching the real tree.
function fakeSource(files) {
  return {
    label: 'fake',
    list(dir) {
      return Object.keys(files).filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1));
    },
    has(p) { return Object.prototype.hasOwnProperty.call(files, p); },
    read(p) { return Buffer.from(files[p]); },
  };
}
const BASE = {
  'spike/quickjs/PINS.md': 'txiki.js v26.6.0 1a230d3',
  'spike/quickjs/patches/a.patch': 'AAA',
  'spike/quickjs/patches/b.patch': 'BBB',
  'patches/libtjs-cosmo.patch': 'COSMO',
  'scripts/build-tjs.cjs': 'build',
  'scripts/tjs-source-reset.cjs': 'reset',
  'scripts/engine-api-floor.cjs': 'floor',
  'scripts/build-depscan.cjs': 'depscan',
  'scripts/depscan-verdict.cjs': 'verdict',
  'scripts/ccache-launcher.cjs': 'ccache',
  'scripts/platform-tag.cjs': 'tag',
  'scripts/ar-determinism.cjs': 'ardet',
  'spike/quickjs/qemu/ci-guest-bake.sh': 'bake',
  'scripts/x.toolchain.cmake': 'tc',
  'spike/quickjs/atomic-shim.c': 'shim',
  'ci/osxcross-darwin/Dockerfile': 'FROM x',
};

test('one changed byte in one patch moves the recipe', async () => {
  const { recipe } = await load();
  const before = recipe(fakeSource(BASE));
  const after = recipe(fakeSource({ ...BASE, 'spike/quickjs/patches/b.patch': 'BBC' }));
  assert.notStrictEqual(after, before);
  assert.strictEqual(recipe(fakeSource({ ...BASE })), before, 'recompute over identical content disagreed');
});

test('adding or removing a patch moves the recipe even with the other bytes untouched', async () => {
  const { recipe } = await load();
  const before = recipe(fakeSource(BASE));
  const added = { ...BASE, 'spike/quickjs/patches/c.patch': '' };
  assert.notStrictEqual(recipe(fakeSource(added)), before, 'an EMPTY added patch did not move the hash');
  const removed = { ...BASE };
  delete removed['spike/quickjs/patches/b.patch'];
  assert.notStrictEqual(recipe(fakeSource(removed)), before);
});

// The cosmo leg's patches were engine sources that the recipe did not cover.
// f8546da regenerated spike/quickjs/patches/txiki-node-constants.patch, renaming
// the identifiers patches/libtjs-cosmo.patch used as diff context; the cosmo
// patch stopped applying and the leg was red for 13 commits. The recipe hash did
// not move, so no cache invalidated and nothing said the engine sources had
// changed. This is the check that would have said so.
test('a changed byte in a repo-root cosmo patch moves the recipe', async () => {
  const { recipe } = await load();
  const before = recipe(fakeSource(BASE));
  const after = recipe(fakeSource({ ...BASE, 'patches/libtjs-cosmo.patch': 'COSMOS' }));
  assert.notStrictEqual(after, before, 'editing patches/libtjs-cosmo.patch did not move the engine identity');
});

// build-tjs.cjs's engine orchestration split into six required modules
// (source-reset, the API-floor check, the two hermeticity-gate halves, the
// ccache launcher, and the path tags). Before this test, none of them were
// engine-source entries: editing scripts/tjs-source-reset.cjs — which decides
// what "pristine" means before a single patch applies — moved no recipe hash, so
// the tjs cache could restore an engine built from a differently-reset checkout
// with no signal at all. ccache-launcher.cjs is the same hazard one level down:
// it decides what compiler invocation the engine is built with.
test('a changed byte in any of the seven split-out orchestration modules moves the recipe', async () => {
  const { recipe } = await load();
  const before = recipe(fakeSource(BASE));
  for (const p of ['scripts/tjs-source-reset.cjs', 'scripts/engine-api-floor.cjs',
    'scripts/build-depscan.cjs', 'scripts/depscan-verdict.cjs',
    'scripts/ccache-launcher.cjs', 'scripts/platform-tag.cjs',
    'scripts/ar-determinism.cjs']) {
    const after = recipe(fakeSource({ ...BASE, [p]: `${BASE[p]}-edited` }));
    assert.notStrictEqual(after, before, `editing ${p} did not move the engine identity`);
  }
});

// Demonstrates the narrowing this file exists to catch: dropping one of the
// four from the pattern set silently drops it from the recipe, exactly as
// removing it from FILES would, and exactly what the EXPECTED_SET pin above
// (a plain equality check) fails loudly on the moment FILES itself narrows.
test('dropping a split-out module from the pattern set is a silent narrowing, which is why FILES is pinned', async () => {
  const { recipeDetail } = await load();
  const full = ['scripts/tjs-source-reset.cjs', 'scripts/engine-api-floor.cjs',
    'scripts/build-depscan.cjs', 'scripts/depscan-verdict.cjs'];
  const narrowed = full.slice(1);
  const withAll = recipeDetail(fakeSource(BASE), full).files.map((f) => f.path);
  const withoutOne = recipeDetail(fakeSource(BASE), narrowed).files.map((f) => f.path);
  assert.ok(withAll.includes('scripts/tjs-source-reset.cjs'));
  assert.ok(!withoutOne.includes('scripts/tjs-source-reset.cjs'),
    'the narrowed pattern set still covered the dropped file — the demonstration is broken, not the guard');
});

test('a glob that matches nothing is fatal, never an empty set', async () => {
  const { recipe, expand } = await load();
  const empty = { ...BASE };
  delete empty['spike/quickjs/patches/a.patch'];
  delete empty['spike/quickjs/patches/b.patch'];
  assert.throws(() => recipe(fakeSource(empty)), /matched no files/);
  assert.throws(() => expand(fakeSource(BASE), ['no/such/file']), /matched no files/);
});

test('the git source reads a rev without touching the working tree', async () => {
  const { recipeDetail, expand, gitSource, worktreeSource } = await load();
  const gsrc = gitSource('HEAD', REPO);
  // Deliberately narrow: `git show` is one process per file and this suite runs
  // on slow mounts. Listing the patch dir + reading one file proves the source
  // adapter; the full-tree recipe is exercised by the CLI test above.
  assert.deepStrictEqual(
    expand(gsrc, ['spike/quickjs/patches/*.patch']),
    expand(worktreeSource(REPO), ['spike/quickjs/patches/*.patch']),
    'git and the working tree disagree about which patches exist');
  const one = recipeDetail(gsrc, ['spike/quickjs/PINS.md']);
  assert.match(one.hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(one.files.length, 1);
  assert.strictEqual(one.files[0].sha,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'spike/quickjs/PINS.md'))).digest('hex'),
    'committed PINS.md and the on-disk one disagree (dirty tree?), or gitSource read the wrong blob');
});
