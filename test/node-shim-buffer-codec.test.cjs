'use strict';
// node-shim's one base64/base64url/hex codec (libexec/node-shim/internal/codec.cjs), DIFFERENTIALLY against host
// node: the fixture asks every Buffer member that encodes or decodes (from, toString with a range, write, fill,
// alloc with a fill, byteLength, isEncoding, toLocaleString), buffer-lite, StringDecoder and the crypto digests,
// over node's edge cases (both alphabets, junk, whitespace, missing or early padding, a lone trailing character,
// UTF-16 code units read as their low byte, hex truncated at the first bad pair). Before the codec, the shim's
// feross Buffer differed from node on 819 of these answers (byteLength decoded instead of estimating, base64url
// ignored toString's range and any case but lower, '1g' read as hex 01, write and fill took code units node
// skips), buffer-lite on 4 (it read an emoji's high surrogate as a skipped character, node as '=') and
// crypto's update(hex) on 2 (an odd length is node's ERR_INVALID_ARG_VALUE).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const FIXTURE = path.join(REPO, 'test/fixtures/buffer-codec-oracle.cjs');

function diffs(ref, got) {
  const out = [];
  for (const k of Object.keys(ref)) {
    const want = k === 'lite' ? ref.buffer : ref[k];
    want.forEach((row, i) => {
      if (JSON.stringify(row) !== JSON.stringify(got[k][i])) out.push(`${k}: node ${JSON.stringify(row)}, got ${JSON.stringify(got[k][i])}`);
    });
  }
  return out;
}

const nodeAnswers = () => JSON.parse(execFileSync(process.execPath, [FIXTURE], { encoding: 'utf8' }));

// Under host node the codec runs its fallback (node 24 has no native Uint8Array base64): buffer-lite must still
// answer as node's own Buffer does.
test('the codec\'s fallback (host node, no native Uint8Array base64) answers as node\'s Buffer', () => {
  const got = nodeAnswers();
  assert.deepStrictEqual(diffs(got, got).slice(0, 20), []);
});

test('the shim\'s Buffer, buffer-lite, StringDecoder and crypto answer every codec case as host node does', (t) => {
  if (skipUnlessTjs(t)) return;
  const ref = nodeAnswers();
  const r = runLoader(FIXTURE, [], { timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(diffs(ref, JSON.parse(r.stdout)).slice(0, 20), []);
});

// The native path is the point: under tjs the codec must not be running its fallback.
test('under tjs the codec runs on the engine\'s native Uint8Array base64/hex', (t) => {
  if (skipUnlessTjs(t)) return;
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-codec-'));
  const f = path.join(dir, 'native.cjs');
  fs.writeFileSync(f, `console.log(require(${JSON.stringify(path.join(REPO, 'libexec/node-shim/internal/codec.cjs'))}).NATIVE);`);
  try {
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), 'true');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
