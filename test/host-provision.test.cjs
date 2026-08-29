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
    /set CLODE_SHA256/
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

// --- tar: real-host integration (create + extract round-trip KAT) ---------
test('provision resolves a real tar on this host (integration)', () => {
  const got = provision('tar', { dataDir: tmpDataDir() });
  assert.ok(got.path, 'a real tar resolved');
  assert.ok(['tar', 'gtar', 'bsdtar'].includes(got.candidate.name));
});

test('provision(tar) fails loud when no tar is found', () => {
  assert.throws(
    () => provision('tar', {
      env: { PATH: '' }, findTool: () => null,
      spawn: () => { throw new Error('must not spawn'); }, fs, dataDir: tmpDataDir(),
    }),
    /CLODE_TAR/
  );
});

// --- gzip: real-host integration (KAT inflates the embedded blob) ----------
test('provision resolves a real gzip decompressor on this host (integration)', () => {
  const got = provision('gzip', { dataDir: tmpDataDir() });
  assert.ok(got.path, 'a real gzip tool resolved');
  assert.ok(['gzip', 'gunzip', 'zcat', 'pigz'].includes(got.candidate.name));
});

test('provision(gzip) fails loud when no decompressor is found', () => {
  assert.throws(
    () => provision('gzip', {
      env: { PATH: '' }, findTool: () => null,
      spawn: () => { throw new Error('must not spawn'); }, fs, dataDir: tmpDataDir(),
    }),
    /CLODE_GZIP/
  );
});

// --- unzip: real-host integration (KAT extracts the embedded zip) ---------
test('provision resolves a real unzip on this host (integration)', () => {
  const got = provision('unzip', { dataDir: tmpDataDir() });
  assert.ok(got.path, 'a real unzip resolved');
  assert.strictEqual(got.candidate.name, 'unzip');
});

test('provision(unzip) fails loud when no extractor is found', () => {
  assert.throws(
    () => provision('unzip', {
      env: { PATH: '' }, findTool: () => null,
      spawn: () => { throw new Error('must not spawn'); }, fs, dataDir: tmpDataDir(),
    }),
    /CLODE_UNZIP/
  );
});

// --- zstd: the requirement that decides whether the SHIPPED builder can carve ---
//
// Claude Code 2.1.251+ embeds its assets as zstd frames, and every published clode is a
// fused tjs binary with no zstd of its own — so libexec/bun-graph.cjs spawns one. It used
// to look for a single hard-coded name with a bare env override and NO known-answer test,
// which is the shape this registry exists to replace: a `CLODE_ZSTD` pointed at anything
// that exits 0 and echoes its input made the carve take the COMPRESSED FRAME as asset text
// and ship a target that builds green and dies on its first turn.
const hosttools = require('../libexec/clode-hosttools.cjs');
const REAL_ZSTD = hosttools.findTool('zstd', { env: process.env });
// The alias rows need a real zstd to point a differently-named link at; the pass-through
// row needs a POSIX shell to write a fake decoder in.
const zstdHostOpts = REAL_ZSTD ? {} : { skip: 'no real `zstd` on PATH to probe with' };
const shOpts = process.platform === 'win32' ? { skip: 'needs /bin/sh for the fake decoder' } : {};

test('provision resolves a real zstd decompressor on this host (integration)', zstdHostOpts, () => {
  const got = provision('zstd', { dataDir: tmpDataDir() });
  assert.ok(got.path, 'a real zstd tool resolved');
  assert.ok(['zstd', 'unzstd', 'zstdcat'].includes(got.candidate.name), `unexpected candidate ${got.candidate.name}`);
});

// DECODE ARGV DIFFERS PER CANDIDATE — `zstd -d -c f`, `unzstd -c f`, `zstdcat f` — so one
// shared argv would resolve a host that has only an alias and then run it wrong. zstd
// switches mode on argv[0], so a link named `unzstd` IS unzstd; these rows run the real
// tool through the real argv, not a mock of it.
for (const alias of ['unzstd', 'zstdcat']) {
  test(`provision(zstd) resolves and correctly drives a host that has only ${alias}`,
    REAL_ZSTD ? shOpts : zstdHostOpts, () => {
      const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-zstdalias-'));
      fs.symlinkSync(REAL_ZSTD, path.join(bindir, alias));
      const got = provision('zstd', { env: { PATH: bindir }, dataDir: tmpDataDir() });
      assert.strictEqual(got.candidate.name, alias);
      assert.strictEqual(got.path, path.join(bindir, alias));
    });
}

// THE KAT IS THE POINT. A "decoder" that exits 0 and hands back exactly what it was given
// is the dangerous case, because every cheap check it could face — status 0, non-empty
// output, no stderr — passes. Only running it on a known frame and comparing the exact
// bytes catches it.
test('provision(zstd) REFUSES an override that merely echoes its input', shOpts, () => {
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-zstdfake-'));
  const fake = path.join(bindir, 'passthru');
  fs.writeFileSync(fake, '#!/bin/sh\n# ignore every flag; echo the last argument\'s bytes back\neval "f=\\${$#}"\nexec cat "$f"\n');
  fs.chmodSync(fake, 0o755);
  // PATH deliberately still holds the REAL zstd (when this host has one). An override that
  // fails must fail the requirement, not quietly hand back whatever else was lying around:
  // a silent fallback would use a decoder nobody asked for AND make this row unfailable.
  const realDir = REAL_ZSTD ? path.dirname(REAL_ZSTD) : '';
  assert.throws(
    () => provision('zstd', {
      env: { PATH: realDir ? `${bindir}${path.delimiter}${realDir}` : bindir, CLODE_ZSTD: fake },
      dataDir: tmpDataDir(),
    }),
    /CLODE_ZSTD/,
    'a pass-through must fail the known-answer test, not resolve');
});

test('provision(zstd) fails loud when no decompressor is found', () => {
  assert.throws(
    () => provision('zstd', {
      env: { PATH: '' }, findTool: () => null,
      spawn: () => { throw new Error('must not spawn'); }, fs, dataDir: tmpDataDir(),
    }),
    /CLODE_ZSTD/
  );
});

// --- an explicit override outranks a cached winner -------------------------
// The cache short-circuit used to run BEFORE the override was consulted, so once any
// winner was cached, setting CLODE_<TOOL> did nothing at all. That is wrong on its face
// (an override that is silently ignored is worse than none) and it is load-bearing here:
// bun-graph's whole CLODE_ZSTD contract is "point me at the decoder", and a carve that
// keeps using a stale cached path cannot be steered off it.
test('an override outranks an already-cached winner', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'hosttools.json'),
    JSON.stringify({ sha256: { candidate: 'shasum', path: '/bin/shasum' } }));
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ov2-'));
  const ovPath = path.join(bindir, 'mysha');
  fs.writeFileSync(ovPath, '#!/bin/sh\n', { mode: 0o755 });
  const got = provision('sha256', {
    env: { CLODE_SHA256: ovPath, PATH: '/usr/bin:/bin' },
    spawn: realSha256Spawn(), fs, dataDir, isExec: () => true,
  });
  assert.strictEqual(got.path, ovPath, 'the override must win over the cached path');
});

// --- the refusal has to say what it tried and why each thing failed --------
// This fails on a machine nobody is sitting at. "no zstd tool found" with no further
// detail sends the next person hunting PATH when the real answer was "your CLODE_ZSTD
// ran and printed `unsupported frame parameter`".
test('the refusal reports each candidate it tried and the reason it rejected it', shOpts, () => {
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-zstdwhy-'));
  const fake = path.join(bindir, 'grumpy');
  fs.writeFileSync(fake, '#!/bin/sh\necho "zstd: unsupported frame parameter" 1>&2\nexit 3\n');
  fs.chmodSync(fake, 0o755);
  let msg = '';
  try { provision('zstd', { env: { PATH: bindir, CLODE_ZSTD: fake }, dataDir: tmpDataDir() }); }
  catch (e) { msg = e.message; }
  assert.match(msg, /unsupported frame parameter/, 'the failing tool\'s own stderr must reach the refusal');
  assert.match(msg, /grumpy/, 'the refusal must name what it ran');
});

// --- the KAT has to prove DECODING, not header-walking -----------------------
//
// A known-answer test is only as strong as the answer it demands. The first zstd KAT frame here
// was `zstd -q -c` of the 5-byte string "clode", and zstd stores an input that small as a RAW
// block — the plaintext sits in the frame verbatim. So a "decoder" that merely parses the frame
// header and copies out raw-block payloads passed it, while decompressing nothing at all. On a
// real compressed row that same fake exits 0 and returns the WRONG BYTES, which is precisely the
// class of failure this registry exists to make impossible. `zstdContentSize` in bun-graph would
// catch it on every row of 2.1.251 — but only because all 101 happen to carry a Frame_Content_Size,
// and "caught by accident on today's input" is not a defence we accept anywhere else here.
//
// The KAT frame is therefore built from repetitive input, so zstd emits a COMPRESSED block
// (Block_Type 2) with a Frame_Content_Size and a content checksum. Producing its plaintext now
// requires actually running the entropy decoder.
function firstBlockHeader(bytes) {
  const b = Buffer.from(bytes);
  const d = b[4];
  const fcsFlag = (d >> 6) & 3, single = (d >> 5) & 1, did = d & 3;
  const fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : (fcsFlag === 1 ? 2 : (fcsFlag === 2 ? 4 : 8));
  const at = 5 + (single ? 0 : 1) + (did === 3 ? 4 : did) + fcsSize;
  const h = b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
  return { at, last: h & 1, type: (h >> 1) & 3, size: h >>> 3 };
}

test('the zstd KAT frame demands decompression — its block is not RAW', () => {
  const { zst, expected } = REGISTRY.zstd.KAT;
  const blk = firstBlockHeader(zst);
  assert.notStrictEqual(blk.type, 0,
    'a RAW block carries the plaintext verbatim, so copying it out passes without decoding anything');
  assert.ok(expected.length > zst.length,
    `the KAT plaintext (${expected.length}B) must be LARGER than the frame (${zst.length}B), `
    + 'so no passthrough or payload-copier can produce it');
});

// The fake above, as an injected spawn: pure JS, so it runs identically under node and the engine,
// and no subprocess is involved. It is a *correct* raw-block frame walker — it just cannot inflate.
function rawBlockWalkerSpawn(bin, args) {
  const file = args[args.length - 1];
  const b = fs.readFileSync(file);
  const d = b[4];
  const fcsFlag = (d >> 6) & 3, single = (d >> 5) & 1, did = d & 3;
  const fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : (fcsFlag === 1 ? 2 : (fcsFlag === 2 ? 4 : 8));
  let at = 5 + (single ? 0 : 1) + (did === 3 ? 4 : did) + fcsSize;
  const out = [];
  for (;;) {
    if (at + 3 > b.length) break;
    const h = b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    at += 3;
    if (type === 0) { out.push(b.subarray(at, at + size)); at += size; }
    else if (type === 1) { at += 1; }
    else { at += size; }
    if (last) break;
  }
  return { status: 0, stdout: Buffer.concat(out).toString('utf8'), stderr: '' };
}

test('provision(zstd) REFUSES a frame walker that copies raw blocks without decoding', () => {
  assert.throws(
    () => provision('zstd', {
      env: { PATH: '/nowhere' }, findTool: () => '/fake/zstd',
      spawn: rawBlockWalkerSpawn, fs, dataDir: tmpDataDir(),
    }),
    /CLODE_ZSTD/,
    'exits 0 and returns bytes, but decompresses nothing — the KAT must not accept it');
});

// A decoder that appends a newline is not this decoder. bun-graph embeds the decoded bytes as the
// asset's text, and on a row with no Frame_Content_Size nothing downstream would notice the extra
// byte — so the KAT compares EXACTLY, unlike the gzip family's trailing-whitespace strip (whose
// consumer unpacks an archive rather than embedding a string).
test('provision(zstd) REFUSES a decoder that appends a newline to correct output', () => {
  const { expected } = REGISTRY.zstd.KAT;
  assert.throws(
    () => provision('zstd', {
      env: { PATH: '/nowhere' }, findTool: () => '/fake/zstd',
      spawn: () => ({ status: 0, stdout: expected + '\n', stderr: '' }),
      fs, dataDir: tmpDataDir(),
    }),
    /CLODE_ZSTD/,
    'the decoded bytes are embedded verbatim; a stray newline corrupts the asset');
});
