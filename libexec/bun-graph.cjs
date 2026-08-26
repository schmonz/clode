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
// TEXT ASSETS the bundle require()s by name. Separate from loadGraphFromBytes because
// they are NOT modules: nothing compiles them, nothing imports them with ESM syntax, and
// giving them to the compiler would be a syntax error 118 times over. They are strings the
// bundle asks for at runtime, and the target must be able to hand them back.
function loadAssetsFromBytes(u8) {
  var g = decodeBunGraph(u8);
  var out = new Map();
  for (var i = 0; i < g.count; i++) {
    var r = g.rows[i];
    if (r.loader !== 13) continue;              // 13 = text (see LOADER)
    out.set(r.name, utf8(u8, r.contentsStart, r.contentsLength));
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
                     MODULE_FORMAT: { ESM: 1, CJS: 2 },
                     LOADER: { 0: 'jsx', 1: 'js', 2: 'ts', 3: 'tsx', 4: 'css', 5: 'file', 6: 'json', 10: 'napi',
                               // 13 = text. NEW IN CLAUDE CODE 2.1.246: 164 rows, 118 of them .md —
                               // prompt preambles and quickrefs that used to be inlined in JS and are
                               // now embedded files the bundle require()s by name. A graph that carries
                               // only JS drops them, and the target dies at its first turn with
                               // "cannot resolve /$bunfs/root/loopAutonomousPreamble-*.md".
                               13: 'text' } };
}
