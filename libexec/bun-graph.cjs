'use strict';
// DECODE BUN'S STANDALONE MODULE GRAPH — the table that says which bytes are which
// module. clode reads a bundle it does not own, and as of Claude Code 2.1.243 that
// bundle is CODE-SPLIT: the CLI is no longer one @bun-cjs block to carve, it is ~1382
// bare-ESM modules wired by static and dynamic imports. Carving cannot see that shape;
// this can.
//
// NO DEPENDENCY ON BUN'S SOURCE, DELIBERATELY. Every field below is justified from the
// bytes of real binaries, not from oven-sh/bun. Anthropic may ship a patched Bun, so
// upstream Zig would be a LEAD, not an authority — and a struct that reads plausibly
// while being subtly wrong is the worst outcome available here. (Same trap as 2.1.243's
// changelog, which truthfully said "the binary is now zstd-compressed" about a
// completely different artifact and cost a day.)
//
// THE ONE NUMBER THAT MATTERS:
//
//     base = trailerStart - 32 - byteCount
//
// `byteCount` measures up to the OFFSETS STRUCT, not to the trailer. Getting this wrong
// by 32 bytes is not a small error: 32 is not a multiple of the 52-byte row stride, so
// field +8 of a shifted row lands exactly on field +40 of the REAL PREVIOUS row. Names
// then look perfectly valid while their contents come from the neighbouring module —
// which presents as `does not provide an export named 'X'` and sends you hunting a
// pairing bug that does not exist. It also makes measurements contradict each other:
// "u5 points at a source start 1374 times" and "zero exact matches" were both artifacts
// of this single shift. Two proofs of the correct value:
//
//   * "/$bunfs/root/src/entrypoints/cli.js" occurs at absolute 271023121 in 2.1.243;
//     row 801's name field says 202554377; the difference is exactly
//     trailerStart-32-byteCount. With the old base no such string exists there.
//   * With the correct base the table ends 1 pad byte before the Offsets struct — in
//     BOTH 2.1.241 and 2.1.243. With the old base the last row literally contains the
//     Offsets struct itself.
//
// ROW LAYOUT (52 bytes = six {u32 off, u32 len} + 4 enum bytes):
//
//   +0  name          the graph key, NUL-terminated. For the entry this is
//                     "/$bunfs/root/cli" — what Bun actually runs.
//   +8  contents      the module source. Row 801 in 2.1.243 is 19949 bytes, parses as
//                     an ES module, and contains `cli_after_main_complete`.
//   +16 always {0,0}  asserted on both binaries. Sourcemaps are NOT in the container
//                     (the bundle carries DD_SOURCEMAP_GROUP; they are uploaded).
//   +24 blobA         JSC bytecode, 4.7-5.4x the contents. Useless to node/quickjs.
//   +32 blobB         small, 2.1.243 only, unidentified, unused.
//   +40 sourcePath    the BUILD path, in a region packed with NO NUL separators — so
//                     never find a name by scanning back to a NUL; you will splice
//                     several names together.
//   +48..51           [encoding, loader, moduleFormat, _]
//
//   loader        1=js 5=file 10=napi — partitions the rows exactly by content type.
//   moduleFormat  1 on all 1382 ESM rows in 2.1.243; 2 on all 6 @bun-cjs rows in
//                 2.1.241. THIS is how clode decides carve-vs-relink: a fact from the
//                 container, not a guess from sniffing the source for "@bun-cjs".
//
// The decoder ASSERTS the whole per-row run is contiguous —
// [blobA][blobB][sourcePath]\0[name]\0[contents]\0 — and throws on any gap, non-NUL
// terminator, duplicate name, out-of-range pointer, or table length not divisible by 52.
// It refuses rather than returning a plausible wrong answer, which is the same contract
// as extract-claude-js.cjs's pickEntry. It throws cleanly on a non-Bun binary.
//
// PROVEN: node's own ESM linker instantiates and links every module this returns —
// 1382/1382 on 2.1.243 and 6/6 on 2.1.241, same code, no version branches, with only
// node builtins left as externals. See test/bun-graph.test.cjs.
//
// PORTABILITY: Uint8Array, String.fromCharCode and integer maths only — no Buffer, no
// npm, nothing exotic. `clode build` must work with Node ABSENT, so this has to run
// under quickjs. Node appears only in the optional convenience wrappers at the bottom
// and in the tests, where it is an ORACLE and not a runtime.

// Bun writes this immediately after the graph; everything is located relative to it.
var TRAILER = '\n---- Bun! ----\n';

function findTrailer(u8) {
  var t = TRAILER, n = t.length;
  for (var i = u8.length - n; i >= 0; i--) {
    var j = 0;
    while (j < n && u8[i + j] === t.charCodeAt(j)) j++;
    if (j === n) return i;
  }
  return -1;
}

function u32(u8, p) {
  return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) + u8[p + 3] * 16777216;
}

function latin1(u8, p, len) {
  var out = '', CH = 4096;
  for (var i = 0; i < len; i += CH) {
    var end = i + CH < len ? i + CH : len, part = '';
    for (var k = i; k < end; k++) part += String.fromCharCode(u8[p + k]);
    out += part;
  }
  return out;
}

// Decode the whole graph. Returns rows in table order. Throws loudly on any
// structural surprise rather than returning a plausible-looking wrong answer.
function decodeBunGraph(u8) {
  var at = findTrailer(u8);
  if (at < 0) throw new Error('bun-graph: no "\\n---- Bun! ----\\n" trailer');
  var h = at - 32;
  if (h < 0) throw new Error('bun-graph: trailer too close to start of file');
  var lo = u32(u8, h), hi = u32(u8, h + 4);
  if (hi !== 0) throw new Error('bun-graph: byteCount exceeds 2^32');
  var byteCount = lo;
  var modOff = u32(u8, h + 8), modLen = u32(u8, h + 12), entryId = u32(u8, h + 16);
  var base = at - 32 - byteCount;
  if (base < 0) throw new Error('bun-graph: byteCount ' + byteCount + ' runs off the front of the file');
  if (modLen % 52 !== 0) throw new Error('bun-graph: module table length ' + modLen + ' is not a multiple of 52');
  var n = modLen / 52;
  var tbl = base + modOff;
  if (tbl + modLen > h) throw new Error('bun-graph: module table [' + tbl + ',' + (tbl + modLen) + ') overruns the Offsets struct at ' + h);
  if (entryId >= n) throw new Error('bun-graph: entryPointId ' + entryId + ' >= ' + n + ' rows');

  var rows = [], i, p, k;
  for (i = 0; i < n; i++) {
    p = tbl + i * 52;
    var f = [];
    for (k = 0; k < 6; k++) f.push({ off: u32(u8, p + k * 8), len: u32(u8, p + k * 8 + 4) });
    for (k = 0; k < 6; k++) {
      if (f[k].len === 0) continue;
      if (base + f[k].off + f[k].len > h) {
        throw new Error('bun-graph: row ' + i + ' field ' + k + ' {' + f[k].off + ',' + f[k].len + '} runs past the module table');
      }
    }
    var name = latin1(u8, base + f[0].off, f[0].len);
    if (u8[base + f[0].off + f[0].len] !== 0) throw new Error('bun-graph: row ' + i + ' name not NUL-terminated: ' + name);
    if (u8[base + f[1].off + f[1].len] !== 0) throw new Error('bun-graph: row ' + i + ' contents not NUL-terminated: ' + name);
    // WE CHECK WHAT THE FORMAT GUARANTEES, NOT HOW BUN HAPPENED TO PACK IT.
    //
    // This used to assert the whole per-row LAYOUT: field@+16 empty, contents starting at
    // exactly name+len+1, and blobA/blobB/sourcePath forming one contiguous backwards run
    // ending at `name`. That was an accurate description of 2.1.243-2.1.245 and it is not
    // a property of the container. Claude Code 2.1.246 repacked the rows, every one of
    // those five assertions fired, and because isSplitBundle() treated ANY decode failure
    // as "not a split bundle", clode fell through to the CommonJS carve and reported
    // "bundle format may have changed" — pointing at the wrong thing entirely. The graph
    // was fine: relaxing these, 2.1.246 decodes to 1,409 modules and 31.9MB of source.
    //
    // What we still verify is what actually protects the caller: every field lies inside
    // the module table (checked above), and name and contents are NUL-terminated where
    // the row says they end. Those catch a misread offset — which is the failure that
    // silently produces a plausible wrong answer. Adjacency only ever caught upstream
    // rearranging its own bytes, which upstream is entitled to do.
    //
    // Anything genuinely impossible is still loud. There is no "best effort" here.
    rows.push({
      index: i,
      name: name,
      sourcePath: f[5].len ? latin1(u8, base + f[5].off, f[5].len) : '',
      contentsStart: base + f[1].off,
      contentsEnd: base + f[1].off + f[1].len,
      contentsLength: f[1].len,
      blobA: f[3], blobB: f[4],
      loader: u8[p + 49],
      moduleFormat: u8[p + 50],   // 1 = ESM, 2 = CommonJS (@bun-cjs)
      enumBytes: [u8[p + 48], u8[p + 49], u8[p + 50], u8[p + 51]],
    });
  }
  var seen = {};
  for (i = 0; i < n; i++) {
    if (seen['#' + rows[i].name]) throw new Error('bun-graph: duplicate module name ' + rows[i].name);
    seen['#' + rows[i].name] = 1;
  }
  return { base: base, trailerAt: at, byteCount: byteCount, modulesOffset: modOff,
           modulesLength: modLen, entryPointId: entryId, entryName: rows[entryId].name,
           count: n, rows: rows, bytes: u8 };
}

// Map<moduleName, sourceText> over the JS-loader rows only, as the task asks.
// ZSTD FRAME MAGIC, and it is the only reliable discriminator here. From 2.1.251 upstream
// compresses the assets it embeds, and it does NOT do so by extension: `mermaid.min.js`,
// `payload.template.html.asset` and 97 `*.zst` rows all begin with these four bytes. Measured
// on the real darwin-arm64 2.1.251 provider — all 101 loader-5 rows are zstd frames, and 0 of
// them are anything else.
var ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
function isZstdFrame(u8, p, len) {
  if (len < 4) return false;
  for (var i = 0; i < 4; i++) if (u8[p + i] !== ZSTD_MAGIC[i]) return false;
  return true;
}

// DECOMPRESSED AT CARVE TIME, ON PURPOSE, and the bundle's own code is why it works. Upstream
// reads an embedded asset like this (2.1.251, chunk-t0k3nmf2.js):
//
//     var u=[40,181,47,253];
//     function s(t){return t.length>=4&&u.every((e,r)=>t[r]===e)}          // is it a zstd frame?
//     function nt(t,e){ ... let n=o(r); return (s(n)?Bun.zstdDecompressSync(n):n).toString("utf8") }
//
// The decompression is CONDITIONAL on the magic. Hand it plain text and `s()` is false and the
// text is used verbatim — so decoding here means the target never needs a zstd implementation at
// all. That matters: tjs has none, `node-shim/modules/zlib.cjs` deliberately has none, and
// writing one is several hundred lines of entropy coding we have no business vendoring.
// THE EXTERNAL DECODER — and on every PUBLISHED clode it is the only one there is.
// `node:zlib.zstdDecompressSync` arrived in Node 22.15/24, so raising the Node floor fixes the
// DEV path and nothing else: tjs has no zstd, `node-shim/modules/zlib.cjs` deliberately has none,
// and all 40 shipped assets are fused tjs binaries. Without this, the shipped builder cannot carve
// upstream 2.1.251+ at all. Same doctrine as translating rg to ugrep/bfs: one portable
// implementation, reached by spawning a tool the host already has, named by CLODE_ZSTD if the
// host keeps it somewhere unusual (the CLODE_RG / CLODE_BFS convention).
//
// THE FRAME GOES THROUGH A FILE, NOT THROUGH STDIN, and that is not fastidiousness. tjs's
// spawnSync is `__tjs_spawn_sync` (mod_spawn_sync.c), which writes the WHOLE of `input` to the
// child before it starts its poll-drain of stdout. A pipe holds 65536 bytes here (measured), so
// once the frame plus the child's unread output exceed that, the parent blocks writing stdin while
// the child blocks writing stdout and neither ever moves. Measured on this box 2026-08-29: the
// real 2.1.251 rows survive it (mermaid.min.js, 786 KB -> 3.5 MB, decodes in 7 ms), but a 16 MB
// frame hangs forever, and upstream's assets only get bigger. A temp file leaves stdout as the
// only pipe, and stdout IS drained by the poll loop. Node's own spawnSync has no such hazard —
// this is the portable shape that is correct under both, not a tjs special case.
// RESOLVED THROUGH host-provision.cjs, not by a name lookup here. That module already owns the
// shape this needs — an override env, an ORDERED CANDIDATE LIST with per-candidate argv, a
// known-answer test, an install hint, a cached winner — and the KAT is the part that is
// load-bearing rather than tidy. A "zstd" that exits 0 and echoes its input (a wrapper script,
// a mis-set CLODE_ZSTD, a same-named tool that is something else) satisfies every cheap check
// available at this call site: status 0, output present, nothing on stderr, and on a frame with
// no Frame_Content_Size even the length check below is blind. The carve then embeds the
// COMPRESSED FRAME as the asset's text and the target dies on its first real turn. Running the
// candidate on a frame whose plaintext we already know is the only thing that catches it, and
// doing it here rather than in a second hand-rolled resolver keeps ONE answer to "which host
// tools does clode need, and how does it prove they work".
//
// Memoized per override value: a 2.1.251 carve decodes 101 rows, and re-reading the tool cache
// (plus, when CLODE_ZSTD is set, re-running the KAT — an override deliberately bypasses that
// cache) 101 times buys nothing. Keyed on the override so a test, or a user, that changes
// CLODE_ZSTD mid-process gets the decoder they asked for. Only successes are memoized; a
// failure re-resolves, so installing zstd and retrying works without restarting.
var ZSTD_TOOL = null, ZSTD_TOOL_KEY = null;
function zstdTool(env) {
  var key = (env && env.CLODE_ZSTD) || '';
  if (ZSTD_TOOL && ZSTD_TOOL_KEY === key) return ZSTD_TOOL;
  var got = require('./host-provision.cjs').provision('zstd', { env: env });
  ZSTD_TOOL = got; ZSTD_TOOL_KEY = key;
  return got;
}

// Returns a Buffer, or null with the reason in ZSTD_WHY. The reason is not decoration: this
// fails on a machine we are not sitting at, and "cannot decode them" without "zstd: command not
// found" or the decoder's own stderr sends the next person hunting the wrong thing.
var ZSTD_WHY = '';
function zstdViaCli(buf) {
  ZSTD_WHY = '';
  var cp = null, fs = null, os = null, path = null;
  try {
    cp = require('node:child_process');
    fs = require('node:fs'); os = require('node:os'); path = require('node:path');
  } catch (e) { ZSTD_WHY = 'no child_process/fs in this runtime: ' + (e && e.message); return null; }
  var bin, argv;
  try {
    var env = {};
    try { env = (process && process.env) || {}; } catch (e2) { /* no env */ }
    var tool = zstdTool(env);
    bin = tool.path; argv = tool.candidate.args;
  } catch (e) {
    // provision's refusal already names every candidate it tried, why each was rejected
    // (including the tool's own stderr), and how to install one. Pass it through verbatim.
    ZSTD_WHY = (e && e.message) || 'no zstd decoder resolved';
    return null;
  }
  var file;
  try {
    file = path.join(zstdScratchDir(fs, os, path), 'frame.zst');
    fs.writeFileSync(file, buf);
  } catch (e) { ZSTD_WHY = 'could not stage the frame in tmpdir: ' + (e && e.message); return null; }
  var r;
  try {
    r = cp.spawnSync(bin, argv(file), { maxBuffer: 1 << 28 });
  } catch (e) {
    ZSTD_WHY = 'spawning ' + bin + ' threw: ' + (e && e.message); return null;
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* best effort; the dir is a mkdtemp */ }
  }
  if (!r) { ZSTD_WHY = 'spawnSync ' + bin + ' returned nothing'; return null; }
  if (r.status !== 0) {
    // r.error does NOT mean the same thing on both runtimes, and saying "could not run" would be
    // a lie on the one that ships. Node sets it for a failed LAUNCH (status null). The shim sets
    // it only on the ETIMEDOUT path (child_process.cjs), and since no `timeout` is passed here,
    // the sole way to reach it under tjs is a maxBuffer overrun — mod_spawn_sync.c reports an
    // overrun and a real timeout through the same `timedOut` flag and cannot tell them apart.
    // So on the engine this branch means "started fine, produced more than we allowed", and the
    // child's stderr is the only thing that can say which. Append it in both cases.
    var tail = String(r.stderr || '').trim();
    ZSTD_WHY = (r.error ? ('could not run or complete ' + bin + ': ' + r.error.message)
      : (bin + ' exited ' + r.status + (r.signal ? ' on ' + r.signal : '')))
      + (tail ? ': ' + tail : '');
    return null;
  }
  // status 0 with EMPTY stdout is a SUCCESSFUL decode of an empty asset, not a failure. The
  // magic-byte gate upstream of here admits a 13-byte zstd frame whose payload is zero bytes,
  // and treating that as "the decoder is broken" would refuse a provider for being correct.
  if (!r.stdout) return Buffer.alloc(0);
  return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
}

// ONE mkdtemp for the whole carve, not one per asset: 2.1.251 has 101 zstd rows, and a temp dir
// each would be 101 create+remove round trips for no gain. mkdtemp rather than a predictable name
// because tmpdir is shared and a planted symlink would otherwise steer the write. The (empty)
// directory outlives the process; that is the OS's to reap, and it is one per carve.
var ZSTD_SCRATCH = null;
function zstdScratchDir(fs, os, path) {
  if (ZSTD_SCRATCH) return ZSTD_SCRATCH;
  ZSTD_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-zstd-'));
  return ZSTD_SCRATCH;
}

// THE ONE INPUT ON WHICH THE TWO PATHS DISAGREE: concatenated frames. `zstd -d -c` decodes a
// frame SEQUENCE and returns all of it; `zlib.zstdDecompressSync` returns only the FIRST frame.
// Measured: two 23-byte-content frames back to back give 46 bytes from the CLI and 23 from zlib,
// both with no error. At most one of those matches upstream's `Bun.zstdDecompressSync`, so on
// such a row the dev path and the shipped path would embed DIFFERENT bytes and neither would say
// so — the exact "builds green, dies on the first turn" shape. No 2.1.251 row is like this (all
// 101 verified single-frame), and this makes sure we hear about it if one ever is.
//
// Frame_Content_Size (RFC 8878 3.1.1.1) is the cheap check: the header states the decoded size of
// THIS frame, so a decode that overruns it decoded something else as well. Measured on the real
// 2.1.251 provider: present and exact on 101 of 101 rows. Returns null when the field is absent
// (legal, and then we simply cannot check).
function zstdContentSize(u8, p, len) {
  if (len < 6) return null;
  var d = u8[p + 4];                                    // Frame_Header_Descriptor
  var fcsFlag = (d >> 6) & 3, single = (d >> 5) & 1, didFlag = d & 3;
  var fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : (fcsFlag === 1 ? 2 : (fcsFlag === 2 ? 4 : 8));
  if (!fcsSize) return null;
  var didSize = didFlag === 3 ? 4 : didFlag;            // 0/1/2/4, never 3
  var at = p + 5 + (single ? 0 : 1) + didSize;          // +1 Window_Descriptor unless single-segment
  if (at + fcsSize > p + len) return null;
  var lo = 0, hi = 0, i;
  for (i = 0; i < (fcsSize < 4 ? fcsSize : 4); i++) lo += u8[at + i] * Math.pow(2, 8 * i);
  for (i = 4; i < fcsSize; i++) hi += u8[at + i] * Math.pow(2, 8 * (i - 4));
  var v = lo + hi * 4294967296;
  if (fcsSize === 2) v += 256;                          // the 2-byte encoding is biased by 256
  return v;
}

// WHERE THE FIRST FRAME ENDS. The Frame_Content_Size check below pins the CLI path, but NOT the
// zlib one: given a concatenated sequence, zlib returns exactly the first frame, whose length
// matches its own header, so a length check sees nothing wrong while the second frame is silently
// dropped. Only the BYTES can answer this. Walking the block chain is ~15 lines and refuses any
// trailing content — a second frame, a skippable frame, junk — before either decoder runs, so
// both paths refuse the same input for the same reason.
//
// Block_Header is 3 bytes LE: bit 0 Last_Block, bits 1-2 Block_Type, bits 3+ Block_Size.
// Types: 0 Raw (Block_Size bytes follow), 1 RLE (exactly 1 byte follows), 2 Compressed
// (Block_Size bytes), 3 Reserved (invalid). Returns the offset just past the frame, or null if
// the frame cannot be walked — in which case we do not second-guess the decoders.
function zstdFrameEnd(u8, p, len) {
  var end = p + len;
  if (len < 6) return null;
  var d = u8[p + 4];
  var fcsFlag = (d >> 6) & 3, single = (d >> 5) & 1, checksum = (d >> 2) & 1, didFlag = d & 3;
  if ((d >> 3) & 1) return null;                        // reserved bit must be zero
  var fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : (fcsFlag === 1 ? 2 : (fcsFlag === 2 ? 4 : 8));
  var at = p + 5 + (single ? 0 : 1) + (didFlag === 3 ? 4 : didFlag) + fcsSize;
  for (;;) {
    if (at + 3 > end) return null;
    var h = u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16);
    var last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    if (type === 3) return null;                        // Reserved: not a frame we can walk
    at += 3 + (type === 1 ? 1 : size);
    if (at > end) return null;
    if (last) break;
  }
  if (checksum) at += 4;
  return at > end ? null : at;
}

// `opts.forceCli` exists ONLY for the test that pins the two paths to byte-identical output. A
// green `node --test` run otherwise never touches the CLI branch, which is the branch that ships.
function zstdToText(u8, p, len, opts) {
  var buf = Buffer.from(u8.buffer, u8.byteOffset + p, len);
  // Refuse a frame SEQUENCE before decoding, so both paths refuse it identically. Done on the
  // bytes because a decoded-length check cannot see it on the zlib path (see zstdFrameEnd).
  var frameEnd = zstdFrameEnd(u8, p, len);
  if (frameEnd !== null && frameEnd !== p + len) {
    throw new Error('bun-graph: this zstd row has ' + (p + len - frameEnd) + ' bytes after the '
      + 'end of its first frame. `zstd` decodes a frame SEQUENCE in full and node:zlib decodes '
      + 'only the first, so the dev path and the shipped path would embed different bytes. '
      + 'Refusing rather than picking one.');
  }
  var out = null;
  if (!(opts && opts.forceCli)) {
    var zlib = null;
    try { zlib = require('node:zlib'); } catch (e) { /* not node, or no zlib */ }
    // A THROW FROM zlib IS NOT A REASON TO TRY THE CLI, deliberately. If zstdDecompressSync
    // exists and rejects the frame (a window-size limit, a future frame feature), that is a fact
    // about the FRAME, and quietly succeeding via a different decoder would mean the dev path and
    // the shipped path disagree about the same bytes — which is the failure this whole section is
    // built to prevent. Let it escape and be loud. Chosen, not overlooked: do not "fix" it.
    if (zlib && typeof zlib.zstdDecompressSync === 'function') out = zlib.zstdDecompressSync(buf);
  }
  if (!out) {
    out = zstdViaCli(buf);
    if (!out) {
      throw new Error('bun-graph: this provider embeds zstd-compressed assets and this runtime '
        + 'cannot decode them (' + (ZSTD_WHY || 'no reason recorded') + '). Install `zstd` (or point '
        + 'CLODE_ZSTD at it); node:zlib.zstdDecompressSync also works on Node 22.15/24+. The '
        + 'alternative is a target that builds green and dies on its first turn with "embedded text '
        + 'asset is missing or corrupt".');
    }
  }
  var want = zstdContentSize(u8, p, len);
  if (want !== null && out.length !== want) {
    throw new Error('bun-graph: zstd frame declares ' + want + ' bytes of content but decoded to '
      + out.length + '. The usual cause is a CONCATENATED frame sequence, which `zstd` decodes in '
      + 'full and node:zlib decodes only the first of — so the two would embed different bytes. '
      + 'Refusing rather than picking one.');
  }
  return out.toString('utf8');
}

// TEXT ASSETS the bundle reads by their container name. Separate from loadGraphFromBytes because
// they are NOT modules: nothing compiles them, nothing imports them with ESM syntax, and giving
// them to the compiler would be a syntax error 118 times over. They are strings the bundle asks
// for at runtime, and the target must be able to hand them back.
//
// TWO LOADERS, and taking only one of them shipped a broken 2.1.251. Rows by loader:
//
//     2.1.250   {"1":1777, "5":4,   "10":5, "13":166}
//     2.1.251   {"1":1799, "5":101, "10":5, "13":72}
//
// 94 rows moved from 13 (text) to 5 (file) because upstream started compressing them. Loader 5
// is NOT a mixed bag to be filtered: every one of the 101 rows is a zstd frame and every one is
// referenced by a module (measured, both versions). The native `.node` modules that must stay
// out of a target are loader 10 (napi), a different bucket entirely, and they are still excluded
// here exactly as before. The 2.1.250 loader-5 rows — mermaid, hljs, chart.umd — were already
// referenced and already unserved, so this closes a latent gap in the older bundle too; they are
// read lazily (only when a chart or diagram renders), which is why no smoke ever caught it.
function loadAssetsFromBytes(u8) {
  var g = decodeBunGraph(u8);
  var out = new Map();
  for (var i = 0; i < g.count; i++) {
    var r = g.rows[i];
    if (r.loader !== 13 && r.loader !== 5) continue;   // 13 = text, 5 = file (see LOADER)
    out.set(r.name, isZstdFrame(u8, r.contentsStart, r.contentsLength)
      ? zstdToText(u8, r.contentsStart, r.contentsLength)
      : utf8(u8, r.contentsStart, r.contentsLength));
  }
  return out;
}

function loadGraphFromBytes(u8) {
  var g = decodeBunGraph(u8);
  var mods = new Map();
  for (var i = 0; i < g.count; i++) {
    var r = g.rows[i];
    if (r.loader !== 1) continue;
    mods.set(r.name, utf8(u8, r.contentsStart, r.contentsLength));
  }
  return mods;
}

// Minimal UTF-8 decode (quickjs has TextDecoder, but this keeps it dependency-free).
function utf8(u8, p, len) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8.subarray(p, p + len));
  return latin1(u8, p, len);
}

// ---- Node-only conveniences (oracle / CLI) ---------------------------------
var loadGraph, loadGraphFull, loadAssets;
if (typeof require === 'function' && typeof module === 'object') {
  var fs = require('node:fs');
  loadGraph = function (binPath) { return loadGraphFromBytes(new Uint8Array(fs.readFileSync(binPath))); };
  loadGraphFull = function (binPath) { return decodeBunGraph(new Uint8Array(fs.readFileSync(binPath))); };
  loadAssets = function (binPath) { return loadAssetsFromBytes(new Uint8Array(fs.readFileSync(binPath))); };
  module.exports = { decodeBunGraph, loadGraphFromBytes, loadGraph, loadGraphFull,
                     loadAssets, loadAssetsFromBytes, TRAILER,
                     __zstdToTextForTest: zstdToText,
                     MODULE_FORMAT: { ESM: 1, CJS: 2 },
                     LOADER: { 0: 'jsx', 1: 'js', 2: 'ts', 3: 'tsx', 4: 'css', 5: 'file', 6: 'json', 10: 'napi',
                               // 13 = text. NEW IN CLAUDE CODE 2.1.246: 164 rows, 118 of them .md —
                               // prompt preambles and quickrefs that used to be inlined in JS and are
                               // now embedded files the bundle require()s by name. A graph that carries
                               // only JS drops them, and the target dies at its first turn with
                               // "cannot resolve /$bunfs/root/loopAutonomousPreamble-*.md".
                               13: 'text' } };
}
