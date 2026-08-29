'use strict';
// host-provision — one KAT-verified resolver for required host tools.
//
// Every artifact (the clode builder, quaude, naude) resolves host tools the
// SAME way at runtime: probe PATH for a candidate, RUN it on a known input and
// verify the exact expected output (the KAT — "does this actually work"), cache
// the winner to ~/.local/share/clode/hosttools.json, and fail loud with an
// install hint if none works. The registry is just code: it is consumed at
// runtime by the clode builder (esbuild-inlined into clode-main.bundle.cjs)
// and by naude (bundled into naude-entry.bundle.cjs), and rides as a forwarded
// member in the builder-role quaude fuse so a self-fused clode-native can
// re-fuse targets. The quaude PRODUCT carries no provision consumer
// (trailer-member deps, bundle-discovered shell, updates are notify-only — a
// version check, no rebuild), so it deliberately does not ship it. The bake injects nothing
// and never resolves target-runtime tools (cross-build safety). Dependency-free:
// Node stdlib + sibling requires.
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hosttools = require('./clode-hosttools.cjs');
const cpaths = require('./clode-paths.cjs');

// Normalize any sha256 tool's output to a lowercase 64-hex digest, or null.
// Handles `<hex>  file`, `SHA256 (file) = <hex>`, `SHA256(file)= <hex>`, bare
// `<hex>`, and certutil's space-separated bytes on their own line.
function parseSha256(out) {
  const clean = String(out).match(/\b[0-9a-f]{64}\b/i);
  if (clean) return clean[0].toLowerCase();
  for (const line of String(out).split(/\r?\n/)) {
    const squished = line.replace(/[^0-9a-fA-F]/g, '');
    if (/^[0-9a-f]{64}$/i.test(squished)) return squished.toLowerCase();
  }
  return null;
}

const SHA256_KAT = { input: 'clode', expected: '300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c' };

// A fixed gzip stream of exactly "clode" (produced by zlib). Decompression is
// deterministic, so ANY conforming decompressor inflates this to "clode" — the
// KAT proves the resolved tool actually inflates gzip, on any platform.
const GZIP_KAT = {
  gz: [31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 75, 206, 201, 79, 73, 5, 0, 82, 5, 130, 22, 5, 0, 0, 0],
  expected: 'clode',
};

// A fixed, deterministic ZIP (STORED, no compression, fixed 1980-01-01 DOS
// timestamp so the bytes never change build to build) containing one entry
// "ok" whose content is "clode". Built with Python's zlib-free zipfile module:
//   zipfile.ZipFile(buf, 'w', zipfile.ZIP_STORED).writestr(
//     zipfile.ZipInfo('ok', date_time=(1980,1,1,0,0,0)), 'clode')
// Any conforming unzip extracts entry "ok" to exactly "clode" — the KAT proves
// the resolved tool actually extracts a zip, on any platform.
const ZIP_KAT = {
  zip: [
    80, 75, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 33, 0, 82, 5, 130, 22, 5, 0, 0, 0,
    5, 0, 0, 0, 2, 0, 0, 0, 111, 107, 99, 108, 111, 100, 101, 80, 75, 1, 2, 20,
    3, 20, 0, 0, 0, 0, 0, 0, 0, 33, 0, 82, 5, 130, 22, 5, 0, 0, 0, 5, 0, 0, 0,
    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 0, 0, 0, 0, 111, 107, 80, 75,
    5, 6, 0, 0, 0, 0, 1, 0, 1, 0, 48, 0, 0, 0, 37, 0, 0, 0, 0, 0,
  ],
  expected: 'clode',
};

// A fixed zstd frame of "clode" repeated 20 times, produced by `zstd -q -c` (1.5.7) from
// `printf 'clode%.0s' $(seq 1 20)`. 25 bytes in, 100 bytes out.
//
// THE INPUT IS REPETITIVE ON PURPOSE, and this is the whole strength of the test. The first
// version of this KAT was `zstd -q -c` of the bare 5-byte string "clode", which zstd stores as
// a RAW block — the plaintext sits in the frame verbatim. A "decoder" that only parses the frame
// header and copies out raw-block payloads therefore PASSED it while decompressing nothing, and
// on a real compressed row that same program exits 0 and returns the wrong bytes. (bun-graph's
// Frame_Content_Size check happens to catch that on all 101 rows of 2.1.251, but only because
// all 101 carry an FCS — "caught by accident on today's input" is not a defence we accept.)
//
// Repetitive input makes zstd emit a COMPRESSED block (Block_Type 2), so producing this
// plaintext requires actually running the entropy decoder. The frame also carries a
// Frame_Content_Size of 100 (Frame_Header_Descriptor 0x24: single-segment, 1-byte FCS) and a
// 4-byte XXH64 content checksum, and the plaintext is FOUR TIMES the frame's length — so
// echoing the input, truncating, or emitting a payload verbatim cannot produce it either.
// Any conforming zstd decompressor turns these 25 bytes into exactly that 100-byte string.
// test/host-provision.test.cjs asserts the not-RAW and larger-than-the-frame properties, so
// a future edit cannot quietly weaken it back.
const ZSTD_KAT = {
  zst: [40, 181, 47, 253, 36, 100, 101, 0, 0, 40, 99, 108, 111, 100, 101,
        1, 0, 140, 169, 104, 1, 254, 7, 238, 136],
  expected: 'clode'.repeat(20),
};

const REGISTRY = {
  sha256: {
    id: 'sha256',
    overrideEnv: 'CLODE_SHA256',
    // Ordered, most-universal first.
    candidates: [
      { name: 'sha256sum', args: (f) => [f] },
      { name: 'shasum', args: (f) => ['-a', '256', f] },
      { name: 'gsha256sum', args: (f) => [f] },
      { name: 'sha256', args: (f) => [f] },
      { name: 'cksum', args: (f) => ['-a', 'sha256', f] },
      { name: 'openssl', args: (f) => ['dgst', '-sha256', f] },
      { name: 'digest', args: (f) => ['-a', 'sha256', f] },
      { name: 'certutil', args: (f) => ['-hashfile', f, 'SHA256'] },
    ],
    parse: parseSha256,
    // Run the candidate on a temp file of known bytes; verify the parsed digest.
    verify({ candidate, path: bin, run, fs }) {
      const tmp = path.join(os.tmpdir(), `clode-kat-sha256-${process.pid}`);
      fs.writeFileSync(tmp, SHA256_KAT.input);
      try {
        const r = run(bin, candidate.args(tmp));
        return !!r && r.status === 0 && parseSha256(r.stdout) === SHA256_KAT.expected;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
      }
    },
    installHint: 'install one of: sha256sum, shasum, gsha256sum, sha256, cksum, openssl, digest, certutil (or set CLODE_SHA256 to a sha256sum-compatible program). Needed to verify downloads.',
  },
  tar: {
    id: 'tar',
    overrideEnv: 'CLODE_TAR',
    candidates: [
      { name: 'tar', args: (f) => ['-xf', f] },
      { name: 'gtar', args: (f) => ['-xf', f] },
      { name: 'bsdtar', args: (f) => ['-xf', f] },
    ],
    // Round-trip KAT: create a tar of a known file with the candidate, extract
    // it with the candidate, and confirm the byte-exact content. No embedded
    // archive constant needed, and it proves create+extract actually work.
    verify({ path: bin, run, fs }) {
      const base = path.join(os.tmpdir(), `clode-kat-tar-${process.pid}`);
      const src = base + '.src';
      const dst = base + '.dst';
      const arc = base + '.tar';
      // Pass the archive by BASENAME with cwd=its dir, never as an absolute path.
      // On Windows under a bash PATH, `tar` is Git Bash's GNU tar, which reads an
      // absolute archive arg like `C:\…\x.tar` as a remote `host:path` (the
      // drive-letter colon → host "C") and dies "Cannot connect to C:". A bare
      // basename has no colon, so create/extract work uniformly on GNU tar
      // (Windows/Linux) and bsdtar (macOS). `-C <dir>` is a change-dir, not
      // remote-parsed, so an absolute path there is fine. Mirrors naude-sea.cjs.
      const arcDir = path.dirname(arc);
      const arcName = path.basename(arc);
      try {
        fs.rmSync(src, { recursive: true, force: true });
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(src, { recursive: true });
        fs.mkdirSync(dst, { recursive: true });
        fs.writeFileSync(path.join(src, 'ok'), 'clode-tar-kat');
        const c = run(bin, ['-cf', arcName, '-C', src, 'ok'], { cwd: arcDir });
        if (!c || c.status !== 0) return false;
        const x = run(bin, ['-xf', arcName, '-C', dst], { cwd: arcDir });
        if (!x || x.status !== 0) return false;
        return fs.readFileSync(path.join(dst, 'ok'), 'utf8') === 'clode-tar-kat';
      } catch {
        return false;
      } finally {
        for (const p of [src, dst, arc]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* absent */ } }
      }
    },
    installHint: 'install tar (or gtar/bsdtar), or set CLODE_TAR. Needed to unpack downloads.',
  },
  gzip: {
    id: 'gzip',
    overrideEnv: 'CLODE_GZIP',
    // Decompressors, most-universal first. Each inflates a file arg to stdout.
    candidates: [
      { name: 'gzip', args: (f) => ['-dc', f] },
      { name: 'gunzip', args: (f) => ['-c', f] },
      { name: 'zcat', args: (f) => [f] },
      { name: 'pigz', args: (f) => ['-dc', f] },
    ],
    // Inflate the embedded known gzip blob; verify the exact inflated bytes.
    verify({ candidate, path: bin, run, fs }) {
      const tmp = path.join(os.tmpdir(), `clode-kat-gzip-${process.pid}.gz`);
      fs.writeFileSync(tmp, Buffer.from(GZIP_KAT.gz));
      try {
        const r = run(bin, candidate.args(tmp));
        return !!r && r.status === 0 && String(r.stdout).replace(/\s+$/, '') === GZIP_KAT.expected;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
      }
    },
    installHint: 'install gzip (or gunzip/zcat/pigz), or set CLODE_GZIP to a `gzip -dc`-compatible decompressor. Needed to unpack the templates pack.',
  },
  unzip: {
    id: 'unzip',
    overrideEnv: 'CLODE_UNZIP',
    candidates: [
      { name: 'unzip', args: (f, destDir) => ['-o', '-q', f, '-d', destDir] },
    ],
    // Extract the embedded known zip to a temp dir; verify the exact content
    // of its single entry. Round-trip-free (unlike tar) since unzip only
    // extracts — mirrors GZIP_KAT's embedded-blob shape instead.
    verify({ candidate, path: bin, run, fs }) {
      const base = path.join(os.tmpdir(), `clode-kat-unzip-${process.pid}`);
      const zip = `${base}.zip`;
      const dest = `${base}.dst`;
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(zip, Buffer.from(ZIP_KAT.zip));
        const r = run(bin, candidate.args(zip, dest));
        if (!r || r.status !== 0) return false;
        return fs.readFileSync(path.join(dest, 'ok'), 'utf8') === ZIP_KAT.expected;
      } catch {
        return false;
      } finally {
        try { fs.unlinkSync(zip); } catch { /* absent */ }
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* absent */ }
      }
    },
    installHint: 'install unzip, or set CLODE_UNZIP to an unzip-compatible extractor. Needed to unpack Windows Node downloads.',
  },
  // REQUIRED TO CARVE UPSTREAM 2.1.251+, on every artifact we publish. Claude Code embeds
  // its text assets as zstd frames; `node:zlib.zstdDecompressSync` arrived in Node 22.15/24
  // and covers the DEV path only — every shipped clode is a fused tjs binary, tjs has no
  // zstd, and node-shim/modules/zlib.cjs deliberately has none. So libexec/bun-graph.cjs
  // spawns a host zstd, and it resolves it through here rather than hand-rolling a lookup:
  // without the KAT, a CLODE_ZSTD (or a PATH `zstd`) that exits 0 and echoes its input makes
  // the carve embed the COMPRESSED FRAME as the asset's text, and the target builds green
  // and dies on its first turn with "embedded text asset is missing or corrupt".
  zstd: {
    id: 'zstd',
    overrideEnv: 'CLODE_ZSTD',
    // Decompressors, most-universal first. ARGV DIFFERS PER CANDIDATE and that is the whole
    // reason `args` lives on the candidate rather than on the requirement: zstd switches mode
    // on argv[0], so `unzstd` and `zstdcat` are the same binary already in decompress mode and
    // do not take (or need) `-d`. One shared argv would resolve an alias-only host and then
    // drive it wrong. `zstd -d -c f` / `unzstd -c f` / `zstdcat f` are each that tool's own
    // documented decompress-to-stdout form.
    candidates: [
      { name: 'zstd', args: (f) => ['-d', '-c', f] },
      { name: 'unzstd', args: (f) => ['-c', f] },
      { name: 'zstdcat', args: (f) => [f] },
    ],
    // Exposed so the tests can assert on the constant itself rather than re-deriving it.
    KAT: ZSTD_KAT,
    // Decompress the embedded known frame; verify the exact bytes. EXACT, with no trailing-
    // whitespace strip — unlike the gzip family above, whose consumer unpacks an archive.
    // bun-graph embeds what comes back as the asset's TEXT, so a decoder that appends a newline
    // is not this decoder: on a row with no Frame_Content_Size nothing downstream would notice
    // the extra byte, and the target would carry a corrupted asset.
    verify({ candidate, path: bin, run, fs }) {
      const tmp = path.join(os.tmpdir(), `clode-kat-zstd-${process.pid}.zst`);
      fs.writeFileSync(tmp, Buffer.from(ZSTD_KAT.zst));
      try {
        const r = run(bin, candidate.args(tmp));
        return !!r && r.status === 0 && String(r.stdout) === ZSTD_KAT.expected;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
      }
    },
    installHint: 'install zstd (or unzstd/zstdcat), or set CLODE_ZSTD to a `zstd -d -c`-compatible decompressor. Needed to carve Claude Code 2.1.251+, which embeds its text assets as zstd frames.',
  },
};

function cachePath(dataDir) {
  return path.join(dataDir, 'hosttools.json');
}
function readCache(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeCache(fs, file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n');
  } catch { /* cache is an optimization; a write failure must not break provisioning */ }
}

// AN OVERRIDE IS EXCLUSIVE, not merely first. If the operator said CLODE_ZSTD=/x/y, then
// /x/y is the answer; falling through to a PATH `zstd` when /x/y fails its KAT would quietly
// use a tool nobody asked for and report success — the silent-softening shape this repo's
// doctrine forbids, and it makes "point CLODE_ZSTD at a broken decoder" untestable because
// the fallback always rescues it. Failing the override fails the requirement, loudly.
//
// Its argv is that of the candidate whose BASENAME it matches (CLODE_ZSTD=/usr/bin/zstdcat
// gets `zstdcat f`, not `zstd -d -c f`), falling back to the first candidate's form for a
// name the registry does not know — a wrapper script, a differently-named build.
function candidateList(req, env) {
  const ov = req.overrideEnv && env[req.overrideEnv];
  if (!ov) return req.candidates.slice();
  const base = String(ov).replace(/\.[^.\\/]+$/, '').split(/[\\/]/).pop();
  const like = req.candidates.find((c) => c.name === base) || req.candidates[0];
  return [{ name: ov, args: like.args, override: ov }];
}

// Why a candidate was rejected, in the words of the thing that rejected it. `verify`
// answers a boolean, which is the right shape for deciding but useless for REPORTING —
// and these failures happen on a machine nobody is sitting at. Capturing the last spawn
// result per candidate lets the refusal say "your CLODE_ZSTD ran and printed
// `unsupported frame parameter`" instead of "no zstd tool found", which is the difference
// between a fix and an afternoon spent hunting PATH.
function whyRejected(last, threw) {
  if (threw) return threw.message;
  if (!last) return 'its known-answer test ran nothing';
  if (last.error) return last.error.message;
  const tail = String(last.stderr || '').trim().split(/\r?\n/)[0];
  if (tail) return tail;
  if (last.status !== 0) return `exited ${last.status}${last.signal ? ` on ${last.signal}` : ''}`;
  return 'ran fine but produced the wrong bytes';
}

function provision(id, opts = {}) {
  const req = REGISTRY[id];
  if (!req) throw new Error(`host-provision: unknown requirement '${id}'`);
  const {
    env = process.env,
    findTool = hosttools.findTool,
    spawn = spawnSync,
    fs = nodeFs,
    dataDir = cpaths.clodeDataDir(env),
    isExec = hosttools.isExecutableFile,
  } = opts;

  const file = cachePath(dataDir);
  const cache = readCache(fs, file);
  // AN EXPLICIT OVERRIDE OUTRANKS THE CACHE, in both directions: it is not consulted and
  // it is not written. The cache short-circuit used to run first, so once ANY winner was
  // cached, setting CLODE_<TOOL> silently did nothing — an override that is ignored is
  // worse than no override at all, because the operator believes they steered the build.
  // Not writing matters too: an override is a one-run instruction ("use this zstd for
  // this carve"), and persisting it under the plain id would leak that choice into every
  // later run that did not ask for it.
  const overridden = !!(req.overrideEnv && env[req.overrideEnv]);

  // 1. Cache hit: revalidate cheaply (the tool still executes) and return.
  const hit = overridden ? null : cache[id];
  if (hit && hit.path && isExec(hit.path)) {
    const cand = req.candidates.find((c) => c.name === hit.candidate)
      || { name: hit.candidate, args: req.candidates[0].args };
    return { candidate: cand, path: hit.path };
  }

  // 2. Probe: first candidate whose KAT passes wins.
  const tried = [];
  for (const cand of candidateList(req, env)) {
    const label = cand.override ? `${req.overrideEnv}='${cand.override}'` : cand.name;
    const bin = findTool(cand.name, { env, override: cand.override });
    if (!bin) { tried.push(`${label}: not found`); continue; }
    let last = null;
    const run = (b, args, extra) => (last = spawn(b, args, { encoding: 'utf8', maxBuffer: 1 << 20, ...extra }));
    let ok = false, threw = null;
    try { ok = req.verify({ candidate: cand, path: bin, run, fs, env }); } catch (e) { threw = e; ok = false; }
    if (!ok) { tried.push(`${label} (${bin}): ${whyRejected(last, threw)}`); continue; }
    // 3. Persist and return.
    if (!overridden) {
      cache[id] = { candidate: cand.name, path: bin };
      writeCache(fs, file, cache);
    }
    return { candidate: cand, path: bin };
  }

  throw new Error(`clode: no ${id} tool found on PATH — ${req.installHint}`
    + (tried.length ? ` [tried: ${tried.join('; ')}]` : ''));
}

module.exports = { provision, parseSha256, REGISTRY };
