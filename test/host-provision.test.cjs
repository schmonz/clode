'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provision, REGISTRY } = require('../libexec/host-provision.cjs');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-hp-'));
}

// The provision() mechanics below (cache, re-probe, override, KAT, refusal) are exercised through the gzip
// requirement: a fake spawn that behaves like a working `gzip -dc`, inflating the operand file (last arg) with
// node's zlib (test host only), so the KAT probe passes. (They used sha256 until file hashes went native.)
function realGunzipSpawn(calls) {
  const zlib = require('node:zlib');
  return (bin, args) => {
    calls && calls.push([bin, args]);
    const file = args[args.length - 1];
    return { status: 0, stdout: zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'), stderr: '' };
  };
}

// --- provision: cache miss -> probe -> KAT -> persist ---------------------
test('provision resolves the first candidate whose KAT passes and caches it', () => {
  const dataDir = tmpDataDir();
  const calls = [];
  const findTool = (name) => (name === 'gzip' ? '/usr/bin/gzip' : null);
  const got = provision('gzip', {
    env: { PATH: '/usr/bin' }, findTool, spawn: realGunzipSpawn(calls), fs, dataDir,
  });
  assert.strictEqual(got.candidate.name, 'gzip');
  assert.strictEqual(got.path, '/usr/bin/gzip');
  // KAT actually ran (probe inflated a temp file before we trusted the tool).
  assert.ok(calls.length >= 1, 'KAT probe ran');
  // Persisted to the cache file.
  const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'hosttools.json'), 'utf8'));
  assert.deepStrictEqual(cache.gzip, { candidate: 'gzip', path: '/usr/bin/gzip' });
});

// --- provision: cache hit avoids re-probing -------------------------------
test('provision returns the cached tool without re-probing when still executable', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'hosttools.json'),
    JSON.stringify({ gzip: { candidate: 'gunzip', path: '/bin/gunzip' } }));
  let probed = false;
  const got = provision('gzip', {
    env: { PATH: '/bin' },
    findTool: () => '/bin/gunzip',
    spawn: () => { probed = true; return { status: 0, stdout: 'clode' }; },
    fs, dataDir,
    isExec: () => true, // injected executability check (see Step 3)
  });
  assert.strictEqual(got.path, '/bin/gunzip');
  assert.strictEqual(probed, false, 'cache hit must not spawn a probe');
});

// --- provision: stale cache (tool gone) re-probes -------------------------
test('provision re-probes when the cached tool is no longer executable', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'hosttools.json'),
    JSON.stringify({ gzip: { candidate: 'gunzip', path: '/gone/gunzip' } }));
  const got = provision('gzip', {
    env: { PATH: '/usr/bin' },
    findTool: (name) => (name === 'gzip' ? '/usr/bin/gzip' : null),
    spawn: realGunzipSpawn(),
    fs, dataDir,
    isExec: (p) => p === '/usr/bin/gzip', // /gone/gunzip is stale
  });
  assert.strictEqual(got.path, '/usr/bin/gzip');
});

// --- provision: CLODE_GZIP override jumps the queue -----------------------
test('provision honors an absolute-path CLODE_GZIP override (real findTool)', () => {
  const dataDir = tmpDataDir();
  // A real executable file at an absolute path outside PATH.
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ov-'));
  const ovPath = path.join(bindir, 'mygzip');
  fs.writeFileSync(ovPath, '#!/bin/sh\n', { mode: 0o755 });
  const seen = [];
  const got = provision('gzip', {
    env: { CLODE_GZIP: ovPath, PATH: '/usr/bin:/bin' }, // override is NOT on PATH
    // no findTool injection -> real hosttools.findTool
    spawn: realGunzipSpawn(seen),
    fs, dataDir,
  });
  assert.strictEqual(got.path, ovPath, 'absolute-path override must resolve via findTool override option');
  assert.strictEqual(seen[0][0], ovPath, 'override tool is the one actually run');
});

// --- provision: a present-but-wrong-output tool fails its KAT, next wins ---
test('provision skips a present tool whose KAT fails and uses the next', () => {
  const dataDir = tmpDataDir();
  const findTool = (name) => (['gzip', 'gunzip'].includes(name) ? `/bin/${name}` : null);
  const real = realGunzipSpawn();
  const spawn = (bin, args) =>
    bin.endsWith('/gzip')
      ? { status: 0, stdout: 'not clode\n' } // wrong bytes -> KAT fails
      : real(bin, args);                      // gunzip inflates correctly
  const got = provision('gzip', { env: { PATH: '/bin' }, findTool, spawn, fs, dataDir });
  assert.strictEqual(got.candidate.name, 'gunzip');
});

// --- provision: fail loud when nothing resolves ---------------------------
test('provision throws an actionable error when no tool is found', () => {
  const dataDir = tmpDataDir();
  assert.throws(
    () => provision('gzip', {
      env: { PATH: '' }, findTool: () => null,
      spawn: () => { throw new Error('must not spawn'); }, fs, dataDir,
    }),
    /set CLODE_GZIP/
  );
});

// --- provision: unknown id is a programming error -------------------------
test('provision throws on an unknown requirement id', () => {
  assert.throws(() => provision('nope', { dataDir: tmpDataDir() }), /unknown requirement/i);
});

// --- sha256 is not a host tool: file hashes are native (clode-net.cjs sha256Of) ---
test('there is no sha256 host-tool requirement', () => {
  assert.strictEqual(REGISTRY.sha256, undefined);
  assert.throws(() => provision('sha256', { dataDir: tmpDataDir() }), /unknown requirement/i);
});

// --- tar: the one argument shape (tarPlan), judged by a model of Git for Windows' GNU tar -------------------
// CI 9c655b7 windows-latest: every materializeDeps row died in the tar KAT, "C\:\\Users\\...\\clode-run-n2gbTv
// <newline>aude-sea-9gxkv1\\clode-kat-tar-3824.dst: Cannot open", because GNU tar unquotes backslash escapes in its
// -C argument (and reads a colon in the archive argument as a remote host). This model of it judges an argument
// list the way that tar parses one, on every host, so the Windows shape is judged everywhere.
function gnuTarModel(args) {
  const arc = args[args.findIndex((x) => /^-[cx]z?f$/.test(x)) + 1];
  if (!args.includes('--force-local') && /^[^/\\]*:/.test(arc)) return { status: 2, stderr: `tar: Cannot connect to ${arc.split(':')[0]}: resolve failed` };
  const esc = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', b: '\b', a: '\x07', '\\': '\\' };
  const dir = args[args.indexOf('-C') + 1].replace(/\\(.)/g, (m, ch) => (ch in esc ? esc[ch] : m));
  if (/[\x00-\x1f]/.test(dir)) return { status: 2, stderr: `tar: ${JSON.stringify(dir)}: Cannot open: No such file or directory` };
  return { status: 0, stderr: '' };
}
const WIN_ARCHIVE = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clode-run-n2gbTv\\naude-sea-9gxkv1\\clode-kat-tar-3824.tar';
const WIN_DIR = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clode-run-n2gbTv\\naude-sea-9gxkv1\\clode-kat-tar-3824.dst';

test('CONTROL: the GNU tar model refuses the shapes that broke CI (a drive-letter archive, a backslash-escaped -C)', () => {
  const absolute = gnuTarModel(['-xf', WIN_ARCHIVE, '-C', 'C:/x']);
  assert.strictEqual(absolute.status, 2);
  assert.match(absolute.stderr, /Cannot connect to C/);
  const escaped = gnuTarModel(['-xf', 'a.tar', '-C', WIN_DIR]);
  assert.strictEqual(escaped.status, 2);
  assert.match(escaped.stderr, /clode-run-n2gbTv\\naude-sea-9gxkv1.*Cannot open/);
});

test('tarPlan hands a Windows archive and dir to GNU tar in a shape it reads: basename in its dir, -C with slashes', () => {
  const { tarPlan } = require('../libexec/host-provision.cjs');
  const plan = tarPlan('-xf', WIN_ARCHIVE, WIN_DIR, path.win32);
  assert.deepStrictEqual(plan, {
    cwd: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clode-run-n2gbTv\\naude-sea-9gxkv1',
    args: ['-xf', './clode-kat-tar-3824.tar', '-C', 'C:/Users/RUNNER~1/AppData/Local/Temp/clode-run-n2gbTv/naude-sea-9gxkv1/clode-kat-tar-3824.dst'],
  });
  const r = gnuTarModel(plan.args);
  assert.strictEqual(r.status, 0, r.stderr);
  // and on POSIX the plan is the paths themselves
  assert.deepStrictEqual(tarPlan('-xzf', '/t/n/a.tar.gz', '/t/n/out', path.posix), { cwd: '/t/n', args: ['-xzf', './a.tar.gz', '-C', '/t/n/out'] });
});

test('tarPlan: a colon in the archive\'s own name cannot read as a remote host either (./ puts a slash before it)', () => {
  const { tarPlan } = require('../libexec/host-provision.cjs');
  assert.strictEqual(gnuTarModel(['-xf', 'node-v24:x.tar', '-C', 'out']).status, 2); // control: a bare basename would
  const plan = tarPlan('-xf', 'C:\\dl\\node-v24:x.tar', 'C:\\out', path.win32);
  assert.strictEqual(plan.args[1], './node-v24:x.tar');
  assert.strictEqual(gnuTarModel(plan.args).status, 0);
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
// blobulated tjs binary with no zstd of its own — so libexec/bun-graph.cjs spawns one. It used
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

// DECODE ARGV DIFFERS PER CANDIDATE — `zstd -d -q -f -o out f`, `unzstd -q -f -o out f`,
// `zstdcat -q -f -o out f` — so one shared argv would resolve a host that has only an alias and
// then run it wrong. zstd
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
  // Honours the -o contract (copies its input to the named output file), so it is refused for
  // its BYTES, not for failing to write where it was told.
  fs.writeFileSync(fake, '#!/bin/sh\n# ignore every other flag; copy the last argument\'s bytes to the -o file\n'
    + 'eval "f=\\${$#}"; out=\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done\n'
    + 'exec cat "$f" > "$out"\n');
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
    // The reason, not just the install hint every refusal carries: the fake honours -o, so it
    // must be refused for its BYTES. A broken -o loop in the fake would fail differently.
    /CLODE_ZSTD='[^']*passthru' \([^)]*\): ran fine but produced the wrong bytes/,
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
    JSON.stringify({ gzip: { candidate: 'gunzip', path: '/bin/gunzip' } }));
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ov2-'));
  const ovPath = path.join(bindir, 'mygzip');
  fs.writeFileSync(ovPath, '#!/bin/sh\n', { mode: 0o755 });
  const got = provision('gzip', {
    env: { CLODE_GZIP: ovPath, PATH: '/usr/bin:/bin' },
    spawn: realGunzipSpawn(), fs, dataDir, isExec: () => true,
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

// Where an injected fake must put its output: the `-o <out>` the registry's argv names. Every zstd
// candidate decodes to a FILE (see host-provision.cjs), and the known-answer test reads that file,
// so a fake that answered on stdout would be refused for the wrong reason and prove nothing.
function outArg(args) {
  const i = args.indexOf('-o');
  assert.ok(i >= 0 && args[i + 1], `the zstd argv must name an -o output file: ${JSON.stringify(args)}`);
  return args[i + 1];
}

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
  fs.writeFileSync(outArg(args), Buffer.concat(out));
  return { status: 0, stdout: '', stderr: '' };
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
      spawn: (bin, args) => { fs.writeFileSync(outArg(args), expected + '\n'); return { status: 0, stdout: '', stderr: '' }; },
      fs, dataDir: tmpDataDir(),
    }),
    /CLODE_ZSTD/,
    'the decoded bytes are embedded verbatim; a stray newline corrupts the asset');
});

// THE KNOWN-ANSWER TEST READS THE -o FILE, NOT STDOUT. Every candidate decodes to a file because
// zstd.EXE's writes to a stdout PIPE intermittently fail on windows-latest (`error 70 ... No space
// left on device`, ~1 run in 5; CI runs 36039332441, 35692416628) — and bun-graph reads the file
// back, so the self-check has to prove that exact invocation. Two injected decoders pin it, and
// they are each other's control: the right bytes in the -o file are ACCEPTED (so the refusals above
// are about their bytes, not their plumbing); the same right bytes on stdout, -o ignored, are REFUSED.
test('provision(zstd) ACCEPTS a decoder that writes the right bytes to the -o file', () => {
  const { expected } = REGISTRY.zstd.KAT;
  const got = provision('zstd', {
    env: { PATH: '/nowhere' }, findTool: () => '/fake/zstd',
    spawn: (bin, args) => { fs.writeFileSync(outArg(args), expected); return { status: 0, stdout: '', stderr: '' }; },
    fs, dataDir: tmpDataDir(),
  });
  assert.strictEqual(got.path, '/fake/zstd');
});

test('provision(zstd) REFUSES a decoder that answers on stdout and ignores -o', () => {
  const { expected } = REGISTRY.zstd.KAT;
  assert.throws(
    () => provision('zstd', {
      env: { PATH: '/nowhere' }, findTool: () => '/fake/zstd',
      spawn: () => ({ status: 0, stdout: expected, stderr: '' }),
      fs, dataDir: tmpDataDir(),
    }),
    // THE REASON, not just "refused": every refusal carries the CLODE_ZSTD install hint, so
    // matching that alone passed while the refusal said "produced the wrong bytes" — false here,
    // the bytes were right and went to stdout. On a host nobody is sitting at (windows-latest's
    // unverified zstd.EXE, a zstdcat whose -o does not override its forced stdout) that lie
    // points at the decoder's correctness instead of its output mode.
    /exited 0 but wrote no -o output file; it printed 100 bytes to stdout instead/,
    'bun-graph reads the -o file; a decoder that never writes it would hand the carve nothing');
});
