'use strict';
// host-provision — one KAT-verified resolver for required host tools.
//
// (Not sha256: a file's hash is native and in-process, clode-net.cjs sha256Of. Not tar,
// gzip or unzip either: every archive is read in process, libexec/unpack.cjs, over node:zlib,
// which is the engine's miniz under tjs. zstd is the one host tool left.)
// Every artifact (the clode builder, quaude, naude) resolves host tools the
// SAME way at runtime: probe PATH for a candidate, RUN it on a known input and
// verify the exact expected output (the KAT — "does this actually work"), cache
// the winner to ~/.local/share/clode/hosttools.json, and fail loud with an
// install hint if none works. The registry is just code: it is consumed at
// runtime by the clode builder (esbuild-inlined into clode-main.bundle.cjs;
// naude no longer carries it, its deps.tar is read by unpack.cjs), and rides as a forwarded
// member in the builder-role quaude blobulate so a self-blobulated clode-native can
// re-blobulate targets. The quaude PRODUCT carries no provision consumer
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
  // REQUIRED TO CARVE UPSTREAM 2.1.251+, on every artifact we publish. Claude Code embeds
  // its text assets as zstd frames; `node:zlib.zstdDecompressSync` arrived in Node 22.15/24
  // and covers the DEV path only — every shipped clode is a blobulated tjs binary, tjs has no
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
    // drive it wrong.
    //
    // EACH DECODES TO A FILE (`-o out`), NOT TO STDOUT. On windows-latest zstd.EXE's writes to
    // its stdout PIPE intermittently fail — `zstd: error 70 : Write error : cannot write block
    // : No space left on device`, ~1 run in 5 (CI runs 36039332441, 35692416628, 35670438691,
    // 35562770090, 35562521239) — and it is not a full disk: a 1.33 MB frame failed and the
    // 3.98 MB one after it passed 342 ms later in the same process, and one run exited 70 with
    // an EMPTY stderr, which a full disk cannot cause. The UCRT's _write_nolock turns a WriteFile
    // that reports 0 bytes written into ENOSPC; on a pipe that is a short write, not a volume
    // (the recon's reading of the source, not reproduced here). A file output takes
    // the pipe out of the decode on every host, and with it any dependence on how a runtime
    // drains stdout. `-q` keeps the progress line off stderr; `-f` overwrites a stale output.
    // zstdcat is zstd with `-dcf` preset, and its `-o` DOES override the forced stdout —
    // verified 2026-09-24 with zstd 1.5.7 (pkgsrc, darwin): `zstdcat -q -f -o out kat.zst`
    // wrote the 100-byte KAT plaintext to `out` and 0 bytes to stdout. A zstdcat that ignored
    // -o would fail verify() below (no output file), not decode silently to the wrong place.
    candidates: [
      { name: 'zstd', args: (f, out) => ['-d', '-q', '-f', '-o', out, f] },
      { name: 'unzstd', args: (f, out) => ['-q', '-f', '-o', out, f] },
      { name: 'zstdcat', args: (f, out) => ['-q', '-f', '-o', out, f] },
    ],
    // Exposed so the tests can assert on the constant itself rather than re-deriving it.
    KAT: ZSTD_KAT,
    // Decompress the embedded known frame; verify the exact bytes. EXACT, with no trailing-
    // whitespace strip.
    // bun-graph embeds what comes back as the asset's TEXT, so a decoder that appends a newline
    // is not this decoder: on a row with no Frame_Content_Size nothing downstream would notice
    // the extra byte, and the target would carry a corrupted asset. Through the SAME argv
    // bun-graph uses, and read back from the SAME place — the -o file, never stdout — so the
    // self-check proves the exact invocation the carve will make.
    verify({ candidate, path: bin, run, fs }) {
      const tmp = path.join(os.tmpdir(), `clode-kat-zstd-${process.pid}.zst`);
      const out = path.join(os.tmpdir(), `clode-kat-zstd-${process.pid}.out`);
      try { fs.unlinkSync(out); } catch { /* absent */ }
      fs.writeFileSync(tmp, Buffer.from(ZSTD_KAT.zst));
      try {
        const r = run(bin, candidate.args(tmp, out));
        if (!r || r.status !== 0) return false;
        let got;
        try { got = fs.readFileSync(out, 'utf8'); } catch {
          // No output file: it did not decode to where bun-graph will look. THROWN, not `false`:
          // a false with status 0 and a quiet stderr reads, in whyRejected(), as "ran fine but
          // produced the wrong bytes" — a lie when the bytes were right and went to stdout
          // (a decoder that ignores -o, which is the fallback the zstdcat note above relies on).
          const printed = !r.stdout ? 0
            : (Buffer.isBuffer(r.stdout) ? r.stdout.length : Buffer.byteLength(String(r.stdout)));
          throw new Error('exited 0 but wrote no -o output file'
            + (printed ? `; it printed ${printed} bytes to stdout instead` : ''));
        }
        return got === ZSTD_KAT.expected;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
        try { fs.unlinkSync(out); } catch { /* absent */ }
      }
    },
    installHint: 'install zstd (or unzstd/zstdcat), or set CLODE_ZSTD to a `zstd -d -o <out> <in>`-compatible decompressor. Needed to carve Claude Code 2.1.251+, which embeds its text assets as zstd frames.',
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
// gets zstdcat's form, without zstd's `-d`), falling back to the first candidate's form for a
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

module.exports = { provision, REGISTRY };
