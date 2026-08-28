'use strict';
// THE EXTRACTION CACHE KEY — "does this cached carve correspond to the binary in hand?"
//
// `~/.cache/clode/<version>/` is keyed on the VERSION alone, and reuse was guarded by the
// extractor's signature. Neither says anything about the provider. But Bun constant-folds
// `process.platform` at carve time, so version X carved from a linux provider and version X
// carved from a darwin provider are DIFFERENT GRAPHS — one has upstream's macOS credential
// store, the other has it dead-coded away. Extracting a linux provider for X therefore
// poisoned every later darwin build of X, silently, because the key could not tell them
// apart.
//
// That is how the 2026-08-27 quaude shipped with no Keychain support at all and failed
// every turn with a 401 while --version, --help and the mock PONG smoke stayed green.
// It is the same bug class as the templates cache that served a sha256 mismatch before the
// last release: a key missing a dimension that changes the content. That one got
// recipe-scoped; this one needed to be platform-scoped.
const test = require('node:test');
const assert = require('node:assert');
const { cacheSignature } = require('../libexec/clode-extract.cjs');

test('the cache signature separates carves by provider platform', () => {
  assert.strictEqual(typeof cacheSignature, 'function',
    'clode-extract.cjs must export cacheSignature({ extractorSig, providerPlatform })');
  const sig = '12345-67890';
  const darwin = cacheSignature({ extractorSig: sig, providerPlatform: 'darwin' });
  const linux = cacheSignature({ extractorSig: sig, providerPlatform: 'linux' });
  assert.notStrictEqual(darwin, linux,
    'same extractor, different provider platform MUST NOT share a cache entry');
  assert.ok(darwin.includes('darwin'), 'the platform should be legible in the key');
});

test('an unrecognized container never collides with a real platform', () => {
  const sig = '12345-67890';
  // providerPlatformOf returns null when it cannot name the container. That must be its own
  // bucket: treating it as the host is exactly how a linux carve passes for darwin.
  const unknown = cacheSignature({ extractorSig: sig, providerPlatform: null });
  for (const p of ['darwin', 'linux', 'win32', 'freebsd', 'netbsd', 'openbsd', 'sunos']) {
    assert.notStrictEqual(unknown, cacheSignature({ extractorSig: sig, providerPlatform: p }));
  }
});

test('a changed extractor still invalidates, as it always did', () => {
  const a = cacheSignature({ extractorSig: '1-1', providerPlatform: 'darwin' });
  const b = cacheSignature({ extractorSig: '2-2', providerPlatform: 'darwin' });
  assert.notStrictEqual(a, b);
});
