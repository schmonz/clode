'use strict';
// Real-binary extraction at scale: the extractor must produce byte-identical
// output under tjs (via node-shim) and host node on a REAL Claude provider
// binary, AND every anchor patch must match (no "hook NOT applied" warnings) —
// the synthetic Rung-2 fixture could not prove either. SKIPs unless BOTH a tjs
// binary and a real provider binary (CLODE_PROVIDER_BIN) are present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

function providerBin() {
  const p = process.env.CLODE_PROVIDER_BIN;
  return p && fs.existsSync(p) ? p : null;
}

test('real bundle: extractor byte-identical tjs vs node + anchors match', (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN (fetch a real darwin-arm64 binary first)'); return; }
  const extractor = path.join(REPO, 'libexec/extract-claude-js.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-extract-'));
  const outNode = path.join(dir, 'cli-node.cjs');
  const outTjs = path.join(dir, 'cli-tjs.cjs');

  // Host node = oracle.
  const n = spawnSync(process.execPath, [extractor, bin, outNode], { encoding: 'utf8' });
  assert.strictEqual(n.status, 0, n.stderr);
  // tjs via node-shim loader. A ~240MB real binary at real scale is the first
  // exercise of the latin1 carve path this large; give it plenty of headroom.
  const r = runLoader(extractor, [bin, outTjs], { timeout: 300000 });
  assert.strictEqual(r.status, 0, r.stderr);

  // Byte-identical output.
  assert.ok(fs.existsSync(outTjs) && fs.existsSync(outNode));
  assert.strictEqual(
    fs.readFileSync(outTjs).length, fs.readFileSync(outNode).length, 'output byte length differs');
  assert.ok(fs.readFileSync(outTjs).equals(fs.readFileSync(outNode)), 'extractor output differs tjs vs node');

  // Real anchors match at scale: NEITHER stderr carries an anchor-miss warning.
  // The real Bun binary's entry carries its build-time VFS path prefix (e.g.
  // "/$bunfs/root/src/entrypoints/cli.js" on this darwin-arm64 build) rather
  // than the bare "entrypoints/cli.js" used by the synthetic Rung-2 fixture —
  // see clode-update.cjs's note on per-platform VFS prefixes. Match the
  // meaningful suffix, not the exact synthetic-fixture string.
  for (const stderr of [n.stderr, r.stderr]) {
    assert.doesNotMatch(stderr, /hook NOT applied/, `unexpected anchor miss:\n${stderr}`);
    assert.match(stderr, /entry=\S*entrypoints\/cli\.js/);
  }
});
