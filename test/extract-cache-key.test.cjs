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
const { cacheSignature, extractorSigOf } = require('../libexec/clode-extract.cjs');

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

// THE SIGNATURE MUST BE ABOUT CONTENT, NOT ABOUT WHEN THE FILE LANDED.
//
// A fused clode (a quaude .com, a musl clode-native) ships its libexec as archive members
// and materializes them to a fresh mkdtemp on every run — fs.writeFileSync, so mtime =
// now. While the signature was `size-mtime` (clode-resolve's sigOf), that made the extract
// cache UNHITTABLE from any fused binary: same bytes, new timestamp, "extractor changed;
// re-extracting" every single time. Observed 2026-08-31 (user): a cosmo .com re-extracted
// 2.1.251 — minutes of SCC merging — that a musl quaude had extracted minutes earlier.
// Measured on the cache entry at the time: identical sizes, three different mtimes.
//
//   checkout  91421-1788057157+77985-1787957344+8062-1788020844
//   cached    91421-1788181680+77985-1788181680+8062-1788181680:linux
//
// Content hashing is not a weaker check than size+mtime, it is a stronger one: size+mtime
// also MISSES a same-size edit inside one second. Cost, measured: 0.41ms for all three
// files (177KB). sigOf itself is deliberately left alone — cacheKey uses it on ~50MB
// provider binaries, where hashing would be a real cost for no gain.
test('extractorSigOf is stable across materializations: same bytes, different mtimes, same sig', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const LIBEXEC = path.join(__dirname, '..', 'libexec');
  const SOURCES = ['extract-claude-js.cjs', 'scc-merge.cjs', 'graph-scc-merge.cjs'];

  // Two "materializations" of the same libexec, with deliberately different mtimes —
  // exactly what materializeFusedPayload produces on two runs of a fused clode.
  const mk = (mtimeSec) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-extractor-sig-'));
    for (const f of SOURCES) {
      const dest = path.join(d, f);
      fs.writeFileSync(dest, fs.readFileSync(path.join(LIBEXEC, f)));
      fs.utimesSync(dest, mtimeSec, mtimeSec);
    }
    return d;
  };
  const a = mk(1000000000);
  const b = mk(1788181680);
  try {
    assert.notStrictEqual(fs.statSync(path.join(a, SOURCES[0])).mtimeMs,
      fs.statSync(path.join(b, SOURCES[0])).mtimeMs, 'fixture must actually differ in mtime');
    assert.strictEqual(extractorSigOf(a), extractorSigOf(b),
      'two materializations of identical extractor sources must share a signature — otherwise '
      + 'no fused clode can ever hit the extract cache');
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('extractorSigOf still changes when the extractor actually changes', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const LIBEXEC = path.join(__dirname, '..', 'libexec');
  const SOURCES = ['extract-claude-js.cjs', 'scc-merge.cjs', 'graph-scc-merge.cjs'];
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-extractor-sig-edit-'));
  try {
    for (const f of SOURCES) fs.writeFileSync(path.join(d, f), fs.readFileSync(path.join(LIBEXEC, f)));
    const before = extractorSigOf(d);
    // A same-LENGTH edit, pinned at the same mtime: the case size+mtime could miss outright.
    const target = path.join(d, 'scc-merge.cjs');
    const bytes = fs.readFileSync(target);
    const when = fs.statSync(target).mtime;
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x0a ? 0x20 : 0x0a;
    fs.writeFileSync(target, bytes);
    fs.utimesSync(target, when, when);
    assert.strictEqual(fs.readFileSync(target).length, bytes.length, 'fixture edit must keep the size');
    assert.notStrictEqual(extractorSigOf(d), before,
      'editing the merger must invalidate the cache — that is the whole point of the signature');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
