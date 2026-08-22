'use strict';
// The templates-drift REPORT is the product, so this tests the report: that it
// names the changed files, names the commits, and states the remedy. "Something
// drifted" is the useless answer that the old (vacuous) tjsPin check already
// gave; the reason this check exists is that it can say WHICH engine fixes are
// missing from what users download, and WHO to ask.
//
// Offline by construction: the pure functions take data. The network path
// (fetchManifest) and the git path (publishedRecipe) are exercised by running
// the CLI in CI, where a real release and real history exist.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = path.resolve(__dirname, '../scripts/templates-drift.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);

const PUB = { files: [
  { path: 'scripts/build-tjs.mjs', sha: 'a'.repeat(64) },
  { path: 'spike/quickjs/PINS.md', sha: 'b'.repeat(64) },
  { path: 'spike/quickjs/patches/gone.patch', sha: 'c'.repeat(64) },
] };
const CUR = { files: [
  { path: 'scripts/build-tjs.mjs', sha: 'a'.repeat(64) },
  { path: 'spike/quickjs/PINS.md', sha: 'b'.repeat(64) },
  { path: 'spike/quickjs/patches/new.patch', sha: 'd'.repeat(64) },
] };

test('diffRecipes names added / removed / modified files, sorted', async () => {
  const { diffRecipes } = await load();
  assert.deepStrictEqual(diffRecipes(PUB, CUR), [
    { path: 'spike/quickjs/patches/gone.patch', status: 'removed' },
    { path: 'spike/quickjs/patches/new.patch', status: 'added' },
  ]);
  const modified = diffRecipes(PUB, { files: [...PUB.files.slice(0, 2), { path: 'spike/quickjs/patches/gone.patch', sha: 'e'.repeat(64) }] });
  assert.deepStrictEqual(modified, [{ path: 'spike/quickjs/patches/gone.patch', status: 'modified' }]);
  assert.deepStrictEqual(diffRecipes(PUB, PUB), []);
});

const ARGS = {
  repo: 'schmonz/clode',
  tag: 'v0.20260801.2',
  asset: 'templates-26.6.0-1a230d3.json',
  publishedAt: '2026-08-02T05:25:51Z',
  pin: '26.6.0-1a230d3',
  publishedHash: '1'.repeat(64),
  currentHash: '2'.repeat(64),
  head: 'deadbee',
  derivedFrom: 'computed from v0.20260801.2',
};

test('the drift report names the files, the commits, and the remedy', async () => {
  const { renderReport, diffRecipes } = await load();
  const out = renderReport({
    ...ARGS,
    changed: diffRecipes(PUB, CUR),
    commits: ['906af8b fix(node-shim): surface real uid/gid from FSS.stat'],
  });
  assert.match(out, /ENGINE TEMPLATE DRIFT/);
  assert.match(out, /spike\/quickjs\/patches\/new\.patch/);
  assert.match(out, /906af8b fix\(node-shim\)/);
  assert.match(out, /v0\.20260801\.2/);
  assert.match(out, /REMEDY: cut a release/);
  // The remedy must forbid the obvious wrong fix out loud: this check is red
  // because the published engines really are stale, not because it is too strict.
  assert.match(out, /NOT to relax, skip,\s*\n?or re-baseline/);
});

test('an in-sync tree reports in sync and lists no commits', async () => {
  const { renderReport } = await load();
  const out = renderReport({ ...ARGS, currentHash: ARGS.publishedHash, changed: [], commits: [] });
  assert.match(out, /engine templates are in sync/);
  assert.doesNotMatch(out, /REMEDY/);
  assert.doesNotMatch(out, /DRIFT/);
});

test('drift with an empty commit list says so rather than implying nobody did it', async () => {
  const { renderReport, diffRecipes } = await load();
  const out = renderReport({ ...ARGS, changed: diffRecipes(PUB, CUR), commits: [] });
  assert.match(out, /should be impossible — investigate/);
});

test('a manifest carrying its own recipe field is preferred over the tag derivation', async () => {
  const { check } = await load();
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdrift-'));
  const file = path.join(dir, 'templates-x.json');
  // A bogus tag: if the recipe field were ignored, deriving from it would throw.
  fs.writeFileSync(file, JSON.stringify({ schema: 2, tjsPin: 'x', recipe: 'f'.repeat(64), targets: {} }));
  const res = await check({ repo: 'schmonz/clode', tag: 'no-such-tag-ever', manifestFile: file });
  assert.strictEqual(res.publishedHash, 'f'.repeat(64));
  assert.strictEqual(res.drifted, true);
  assert.match(res.report, /manifest\.recipe/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--manifest without --tag refuses rather than guessing a baseline', async () => {
  const { check } = await load();
  await assert.rejects(() => check({ repo: 'schmonz/clode', manifestFile: '/nonexistent' }), /needs --tag/);
});
