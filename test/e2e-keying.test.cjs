const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, runClode, mkProvider, REPO } = require('./e2e.cjs');

// test_keying.bats: cache-key behavior (hit / miss / invalidate). The bats setup
// exported CLODE_VERBOSE=1 (these tests use the 'extracting JS' chatter as the
// cache-miss/hit signal, silent unless verbose) and, per test, a private CLODE_CACHE
// dir. The per-test CLODE_CACHE override is load-bearing: the bundle cache lives at
// clodeCacheDir(env) === $CLODE_CACHE, whereas OTHER launcher state under the state
// root — update-guard-settings.json (clode-run -> cacheBase) and the watch dir — lands
// in cacheBase === $CLODE_STATE_ROOT/cache/clode. Overriding CLODE_CACHE to its own
// dir keeps the bundle cache isolated so "exactly one entry" counts only bundle keys
// (faithful to `export CLODE_CACHE="$TMP/cN"` in the bats bodies). The chosen dir must
// NOT contain cacheBase (== CLODE_STATE_ROOT/cache/clode, where update-guard-settings
// lands): here CLODE_STATE_ROOT === sbx.dir, so a name like 'cache' would nest cacheBase
// inside it and pollute the count. 'bundle-cache' stays disjoint.
function keyingSandbox(t) {
  const sbx = sandbox(t);
  sbx.env.CLODE_VERBOSE = '1';
  sbx.env.CLODE_CACHE = path.join(sbx.dir, 'bundle-cache');   // isolated bundle-cache dir
  return sbx;
}

test('version-encoded path uses version as cache key', (t) => {
  const sbx = keyingSandbox(t);
  const bin = path.join(sbx.dir, 'share', 'versions', '9.9.9');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  mkProvider(bin, 'v');
  runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  assert.strictEqual(fs.existsSync(path.join(sbx.env.CLODE_CACHE, '9.9.9')), true);
});

test('non-encoded path uses basename-sig as cache key', (t) => {
  const sbx = keyingSandbox(t);
  const bin = path.join(sbx.dir, 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  mkProvider(bin, 'v');
  runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  // ls "$CLODE_CACHE" | grep -q '^claude-'
  const entries = fs.readdirSync(sbx.env.CLODE_CACHE);
  assert.match(entries.join('\n'), /^claude-/m);
});

test('stable key: identical binary re-run yields exactly one cache entry', (t) => {
  const sbx = keyingSandbox(t);
  const bin = path.join(sbx.dir, 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  mkProvider(bin, 'v');
  runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  // n=$(ls "$CLODE_CACHE" | wc -l); [ "$n" = "1" ]
  assert.strictEqual(fs.readdirSync(sbx.env.CLODE_CACHE).length, 1);
});

test('extractor change re-extracts the cached bundle (binary unchanged)', (t) => {
  // The bundle (cli.cjs) is a function of (binary, extractor logic), but the cache
  // key only captures the binary. Without this, an edit to extract-claude-js.cjs never
  // reaches existing caches until the provider binary moves (the /doctor patch bug).
  const sbx = keyingSandbox(t);
  const lx = path.join(sbx.dir, 'libexec');
  fs.cpSync(path.join(REPO, 'libexec'), lx, { recursive: true });
  sbx.env.CLODE_LIBEXEC = lx;
  const bin = path.join(sbx.dir, 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  mkProvider(bin, 'v');
  // first run extracts
  runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  // second run, extractor UNCHANGED: cache hit, no re-extract
  let r = runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  assert.doesNotMatch(r.output, /extracting JS/);
  // change the extractor (new size+mtime) -> must re-extract even though BIN is identical
  fs.appendFileSync(path.join(lx, 'extract-claude-js.cjs'), '\n# clode-test touch\n');
  r = runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: bin } });
  assert.match(r.output, /extracting JS/);
});
