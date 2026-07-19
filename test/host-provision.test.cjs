'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSha256, provision, REGISTRY } = require('../libexec/host-provision.cjs');

const KAT = '300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c'; // sha256("clode")
const SENTINEL = '0123456789abcdef'.repeat(4);

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-hp-'));
}

// A fake spawn that mimics a coreutils sha256 tool: it reads the operand file
// (last arg) and returns its real sha256 so the KAT probe passes, then any
// later hash returns the real digest too. Uses node crypto (test host only).
function realSha256Spawn(calls) {
  const crypto = require('node:crypto');
  return (bin, args) => {
    calls && calls.push([bin, args]);
    const file = args[args.length - 1];
    const hex = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return { status: 0, stdout: `${hex}  ${file}\n`, stderr: '' };
  };
}

// --- parseSha256: the wide-zoo output formats -----------------------------
for (const [label, stdout] of [
  ['coreutils', `${SENTINEL}  /f\n`],
  ['BSD tagged', `SHA256 (/f) = ${SENTINEL}\n`],
  ['openssl', `SHA256(/f)= ${SENTINEL}\n`],
  ['openssl SHA2-256', `SHA2-256(/f)= ${SENTINEL}\n`],
  ['bare', `${SENTINEL}\n`],
  ['bare CRLF', `${SENTINEL}\r\n`],
  ['certutil spaced', `SHA256 hash of /f:\n${SENTINEL.replace(/(..)/g, '$1 ').trim()}\nCertUtil: -hashfile command completed successfully.\n`],
  ['uppercase', `${SENTINEL.toUpperCase()}  /f\n`],
]) {
  test(`parseSha256 handles ${label}`, () => {
    assert.strictEqual(parseSha256(stdout), SENTINEL);
  });
}

// --- provision: cache miss -> probe -> KAT -> persist ---------------------
test('provision resolves the first candidate whose KAT passes and caches it', () => {
  const dataDir = tmpDataDir();
  const calls = [];
  const findTool = (name) => (name === 'sha256sum' ? '/usr/bin/sha256sum' : null);
  const got = provision('sha256', {
    env: { PATH: '/usr/bin' }, findTool, spawn: realSha256Spawn(calls), fs, dataDir,
  });
  assert.strictEqual(got.candidate.name, 'sha256sum');
  assert.strictEqual(got.path, '/usr/bin/sha256sum');
  // KAT actually ran (probe hashed a temp file before we trusted the tool).
  assert.ok(calls.length >= 1, 'KAT probe ran');
  // Persisted to the cache file.
  const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'hosttools.json'), 'utf8'));
  assert.deepStrictEqual(cache.sha256, { candidate: 'sha256sum', path: '/usr/bin/sha256sum' });
});

// --- provision: cache hit avoids re-probing -------------------------------
test('provision returns the cached tool without re-probing when still executable', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'hosttools.json'),
    JSON.stringify({ sha256: { candidate: 'shasum', path: '/bin/shasum' } }));
  let probed = false;
  const got = provision('sha256', {
    env: { PATH: '/bin' },
    findTool: () => '/bin/shasum',
    spawn: () => { probed = true; return { status: 0, stdout: `${KAT}\n` }; },
    fs, dataDir,
    isExec: () => true, // injected executability check (see Step 3)
  });
  assert.strictEqual(got.path, '/bin/shasum');
  assert.strictEqual(probed, false, 'cache hit must not spawn a probe');
});

// --- provision: stale cache (tool gone) re-probes -------------------------
test('provision re-probes when the cached tool is no longer executable', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'hosttools.json'),
    JSON.stringify({ sha256: { candidate: 'shasum', path: '/gone/shasum' } }));
  const got = provision('sha256', {
    env: { PATH: '/usr/bin' },
    findTool: (name) => (name === 'sha256sum' ? '/usr/bin/sha256sum' : null),
    spawn: realSha256Spawn(),
    fs, dataDir,
    isExec: (p) => p === '/usr/bin/sha256sum', // /gone/shasum is stale
  });
  assert.strictEqual(got.path, '/usr/bin/sha256sum');
});

// --- provision: CLODE_SHA256 override jumps the queue ---------------------
test('provision honors an absolute-path CLODE_SHA256 override (real findTool)', () => {
  const dataDir = tmpDataDir();
  // A real executable file at an absolute path outside PATH.
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ov-'));
  const ovPath = path.join(bindir, 'mysha');
  fs.writeFileSync(ovPath, '#!/bin/sh\n', { mode: 0o755 });
  const seen = [];
  const got = provision('sha256', {
    env: { CLODE_SHA256: ovPath, PATH: '/usr/bin:/bin' }, // override is NOT on PATH
    // no findTool injection -> real hosttools.findTool
    spawn: realSha256Spawn(seen),
    fs, dataDir,
  });
  assert.strictEqual(got.path, ovPath, 'absolute-path override must resolve via findTool override option');
  assert.strictEqual(seen[0][0], ovPath, 'override tool is the one actually run');
});

// --- provision: a present-but-wrong-output tool fails its KAT, next wins ---
test('provision skips a present tool whose KAT fails and uses the next', () => {
  const dataDir = tmpDataDir();
  const findTool = (name) => (['sha256sum', 'shasum'].includes(name) ? `/bin/${name}` : null);
  const real = realSha256Spawn();
  const spawn = (bin, args) =>
    bin.endsWith('sha256sum')
      ? { status: 0, stdout: `${SENTINEL}\n` } // wrong digest -> KAT fails
      : real(bin, args);                        // shasum computes correctly
  const got = provision('sha256', { env: { PATH: '/bin' }, findTool, spawn, fs, dataDir });
  assert.strictEqual(got.candidate.name, 'shasum');
});

// --- provision: fail loud when nothing resolves ---------------------------
test('provision throws an actionable error when no tool is found', () => {
  const dataDir = tmpDataDir();
  assert.throws(
    () => provision('sha256', {
      env: { PATH: '' }, findTool: () => null,
      spawn: () => { throw new Error('must not spawn'); }, fs, dataDir,
    }),
    /sha256|digest tool|install/i
  );
});

// --- provision: unknown id is a programming error -------------------------
test('provision throws on an unknown requirement id', () => {
  assert.throws(() => provision('nope', { dataDir: tmpDataDir() }), /unknown requirement/i);
});

// --- real host integration: the KAT passes with a real tool ---------------
test('provision resolves a real sha256 tool on this host (integration)', () => {
  const got = provision('sha256', { dataDir: tmpDataDir() });
  assert.ok(got.path && got.candidate, 'a real digest tool resolved');
  assert.ok(REGISTRY.sha256.candidates.some((c) => c.name === got.candidate.name));
});
