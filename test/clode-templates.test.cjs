'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseManifest, listTargets, resolveTarget, TemplatesError } = require('../libexec/clode-templates.cjs');

const FIX = JSON.stringify({
  schema: 1,
  tjsPin: 'v26.6.0-1a230d3',
  targets: {
    'linux-x64':    { tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-deadbeef',    sha256: 'a'.repeat(64), verified: 'smoke' },
    'netbsd-sparc': { tag: 'netbsd-10.1-sparc',    engine: 'tjs-netbsd-sparc-cafef00d', sha256: 'b'.repeat(64), verified: 'attest-only' },
  },
});

test('parseManifest returns schema/pin/targets', () => {
  const m = parseManifest(FIX);
  assert.strictEqual(m.tjsPin, 'v26.6.0-1a230d3');
  assert.strictEqual(Object.keys(m.targets).length, 2);
});

test('parseManifest throws TemplatesError on bad JSON / missing targets', () => {
  assert.throws(() => parseManifest('{not json'), (e) => e instanceof TemplatesError);
  assert.throws(() => parseManifest('{"schema":1}'), (e) => e instanceof TemplatesError && /targets/.test(e.message));
});

test('listTargets is sorted name/tag, without the build-time verify annotation', () => {
  const l = listTargets(parseManifest(FIX));
  assert.deepStrictEqual(l.map((t) => t.name), ['linux-x64', 'netbsd-sparc']);
  assert.deepStrictEqual(l[0], { name: 'linux-x64', tag: 'linux-glibc2.28-x64' });
  assert.strictEqual('verified' in l[0], false);
});

test('resolveTarget returns the entry or null', () => {
  const m = parseManifest(FIX);
  assert.strictEqual(resolveTarget(m, 'linux-x64').engine, 'tjs-linux-x64-deadbeef');
  assert.strictEqual(resolveTarget(m, 'nope'), null);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { obtainEngine } = require('../libexec/clode-templates.cjs');

test('obtainEngine: pin mismatch is refused', async () => {
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: 'x' }, { cacheDir: os.tmpdir(), thisPin: 'A', manifestPin: 'B', fetch: async () => Buffer.alloc(0) }),
    (e) => e instanceof TemplatesError && /pin/i.test(e.message));
});

test('obtainEngine: fetch, verify sha, cache, chmod; second call cached', async () => {
  const bytes = Buffer.from('ENGINE-BYTES');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  let calls = 0;
  const fetch = async (url) => { calls++; assert.match(url, /base\/tjs-x-abc/); return bytes; };
  const p = await obtainEngine({ engine: 'tjs-x-abc', sha256: sha }, { cacheDir, baseUrl: 'base/', fetch, thisPin: 'P', manifestPin: 'P' });
  assert.strictEqual(fs.readFileSync(p).toString(), 'ENGINE-BYTES');
  // Windows has no POSIX exec bit — chmod(0o755) is a no-op there and mode never
  // carries 0o111. Executability on Windows is by extension, not mode. The fetch/
  // verify/cache behavior below is what matters cross-platform.
  if (process.platform !== 'win32') assert.ok(fs.statSync(p).mode & 0o111, 'executable');
  await obtainEngine({ engine: 'tjs-x-abc', sha256: sha }, { cacheDir, baseUrl: 'base/', fetch, thisPin: 'P', manifestPin: 'P' });
  assert.strictEqual(calls, 1, 'cached second time');
});

test('obtainEngine: sha mismatch is refused', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng2-'));
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: 'f'.repeat(64) }, { cacheDir, baseUrl: 'b/', fetch: async () => Buffer.from('x'), thisPin: 'P', manifestPin: 'P' }),
    (e) => e instanceof TemplatesError && /sha256/.test(e.message));
});

test('obtainEngine: gzip fetches <engine>.gz, inflates, verifies the DECOMPRESSED sha, caches decompressed', async () => {
  const zlib = require('node:zlib');
  const engineBytes = Buffer.from('DECOMPRESSED-ENGINE-BYTES');
  const sha = crypto.createHash('sha256').update(engineBytes).digest('hex'); // sha of the ENGINE, not the .gz
  const gz = zlib.gzipSync(engineBytes);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enggz-'));
  let fetchedUrl = null;
  const fetch = async (url) => { fetchedUrl = url; return gz; };
  const gunzip = async (buf) => zlib.gunzipSync(buf); // injected: no host gzip tool needed in the unit test
  const p = await obtainEngine(
    { engine: 'tjs-x-abc', sha256: sha },
    { cacheDir, baseUrl: 'base/', fetch, gunzip, thisPin: 'P', manifestPin: 'P', compression: 'gzip' });
  assert.match(fetchedUrl, /base\/tjs-x-abc\.gz$/, 'fetches the .gz asset');
  assert.strictEqual(path.basename(p), 'tjs-x-abc', 'cache holds the decompressed engine, not .gz');
  assert.strictEqual(fs.readFileSync(p).toString(), 'DECOMPRESSED-ENGINE-BYTES');
});

test('obtainEngine: a decompressor that yields wrong bytes still fails the sha gate', async () => {
  const engineBytes = Buffer.from('GOOD');
  const sha = crypto.createHash('sha256').update(engineBytes).digest('hex');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enggz2-'));
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: sha },
      { cacheDir, baseUrl: 'b/', fetch: async () => Buffer.from('ignored'), gunzip: async () => Buffer.from('WRONG'), thisPin: 'P', manifestPin: 'P', compression: 'gzip' }),
    (e) => e instanceof TemplatesError && /sha256/.test(e.message));
});

test('obtainEngine: unsupported compression is refused', async () => {
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: 'x' },
      { cacheDir: os.tmpdir(), fetch: async () => Buffer.alloc(0), thisPin: 'P', manifestPin: 'P', compression: 'brotli' }),
    (e) => e instanceof TemplatesError && /compression/i.test(e.message));
});

// ---- the engine-recipe check, at the moment it matters -------------------
//
// templates-drift has been reddening main on every push since the last release,
// because "engine sources moved ahead of the published pack" is the NORMAL state
// of a repo doing engine work — a state, not a fault. Cutting a release did not
// fix it; it reset the baseline until the next engine commit. Meanwhile the risk
// it warned about was defended NOWHERE: the pin check below is coarse (txiki
// version + short sha), so two clodes with the same pin and different patch
// stacks both accept the same pack, and a cross-built engine is then made of
// different sources than a native build.
//
// This asks the same question where it can be answered exactly and where a wrong
// answer costs someone something: at fetch, by the clode that is about to use it.
// The manifest half was stamped in 4f86738; the clode half is baked by
// scripts/build-clode-main.mjs (__CLODE_BAKED_ENGINE_RECIPE__).
const RECIPE_A = 'a'.repeat(64);
const RECIPE_B = 'b'.repeat(64);
const recipeOpts = (extra) => ({
  manifestPin: 'p', thisPin: 'p', cacheDir: path.join(os.tmpdir(), 'tmpl-recipe-' + process.pid),
  fetch: async () => Buffer.alloc(0), ...extra,
});
const recipeEntry = { engine: 'e', sha256: 'deadbeef' };
const refusedForRecipe = async (opts) => {
  try { await obtainEngine(recipeEntry, opts); return false; }
  catch (e) { return /engine recipe/.test(e.message); }
};

test('obtainEngine REFUSES a pack built from a different engine recipe', async () => {
  assert.strictEqual(await refusedForRecipe(recipeOpts({ manifestRecipe: RECIPE_A, thisRecipe: RECIPE_B })), true);
});

test('obtainEngine accepts a pack whose recipe matches', async () => {
  assert.strictEqual(await refusedForRecipe(recipeOpts({ manifestRecipe: RECIPE_A, thisRecipe: RECIPE_A })), false);
});

// Missing on EITHER side means "cannot check". It must not block (an older pack
// carries no recipe, and a dev checkout may not compute one) and equally must not
// be mistaken for a match — which is why the mismatch row above has to keep
// passing for this pair to mean anything.
test('a missing recipe on either side is "cannot check", not a silent pass', async () => {
  assert.strictEqual(await refusedForRecipe(recipeOpts({ thisRecipe: RECIPE_A })), false);
  assert.strictEqual(await refusedForRecipe(recipeOpts({ manifestRecipe: RECIPE_A })), false);
  assert.strictEqual(await refusedForRecipe(recipeOpts({})), false);
});

test('the built clode bakes its engine recipe, as it bakes its tjs pin', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../scripts/build-clode-main.mjs'), 'utf8');
  assert.match(src, /__CLODE_BAKED_ENGINE_RECIPE__/,
    'a fused clode with no repo cannot compute its own recipe — it must be baked at build time');
  const fuse = fs.readFileSync(path.resolve(__dirname, '../libexec/clode-fuse.cjs'), 'utf8');
  assert.match(fuse, /manifestRecipe: manifest\.recipe/, 'the manifest recipe must reach obtainEngine');
  assert.match(fuse, /thisRecipe: thisEngineRecipe\(/, 'this clode\'s recipe must reach obtainEngine');
});
