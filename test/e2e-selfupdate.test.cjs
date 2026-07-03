const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, runClode, mkProvider, REPO } = require('./e2e.cjs');

// 1:1 port of test/test_selfupdate.bats — the extracted-bundle cache lifecycle:
// cache miss -> extract+boot, cache hit -> skip re-extract, provider upgrade ->
// auto-invalidate+re-extract, and a stale cached bun-shim -> refresh from source
// without a re-extract. All four assert on clode's verbose 'extracting JS' /
// 'refreshed cached bun-shim' chatter, so CLODE_VERBOSE=1 is on for every run
// (the bats setup exports it file-wide).
//
// The bats setup's CLODE_CACHE/CLODE_LIBEXEC are unneeded here: CLODE_STATE_ROOT
// (set by sandbox) governs the extracted-bundle cache dir — cacheBase =
// $stateRoot/cache/clode (clode-paths.cjs) — and the launcher finds REPO/libexec
// by its own path. CLODE_NO_WATCH (also from sandbox) suppresses the on-launch
// watcher, which otherwise writes into that same cacheBase.
function withProvider(t, label = 'v1') {
  const sbx = sandbox(t);
  const bin = path.join(sbx.dir, 'usr', 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  mkProvider(bin, label);
  sbx.env.CLODE_CLAUDE_BIN = bin;
  sbx.env.CLODE_VERBOSE = '1';
  const cacheDir = path.join(sbx.dir, 'cache', 'clode'); // == cacheBase(CLODE_STATE_ROOT)
  return { sbx, bin, cacheDir };
}

test('cache miss extracts and boots v1', (t) => {
  const { sbx } = withProvider(t);
  const r = runClode(sbx, []);
  assert.match(r.output, /extracting JS/);
  assert.match(r.output, /CLODE-FIXTURE v1/);
});

test('cache hit skips re-extract', (t) => {
  const { sbx } = withProvider(t);
  runClode(sbx, []); // warm cache
  const r = runClode(sbx, []);
  assert.doesNotMatch(r.output, /extracting JS/);
  assert.match(r.output, /CLODE-FIXTURE v1/);
});

test('provider upgrade auto-invalidates cache and re-extracts v2', (t) => {
  const { sbx, bin } = withProvider(t);
  runClode(sbx, []); // warm cache for v1
  mkProvider(bin, 'v2-updated');
  const r = runClode(sbx, []);
  assert.match(r.output, /extracting JS/);
  assert.match(r.output, /CLODE-FIXTURE v2-updated/);
});

test('stale cached shim is refreshed from source without a re-extract', (t) => {
  const { sbx, cacheDir } = withProvider(t);
  runClode(sbx, []); // warm cache
  const key = fs.readdirSync(cacheDir)[0]; // KEY=$(ls "$CLODE_CACHE")
  const cached = path.join(cacheDir, key, 'bun-shim.cjs');
  fs.writeFileSync(cached, 'STALE-SHIM\n'); // simulate an out-of-date cached shim
  const r = runClode(sbx, []);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /refreshed cached bun-shim/); // refreshed, not re-extracted
  assert.doesNotMatch(r.output, /extracting JS/);
  // cmp -s "$CLODE_LIBEXEC/bun-shim.cjs" "$cached" — now matches source again
  const src = path.join(REPO, 'libexec', 'bun-shim.cjs');
  assert.ok(fs.readFileSync(cached).equals(fs.readFileSync(src)));
  assert.match(r.output, /CLODE-FIXTURE v1/);
});
