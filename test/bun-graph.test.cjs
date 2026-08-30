// Characterization for libexec/bun-graph.cjs — the decoder for Bun's standalone module
// graph, which is how clode sees a CODE-SPLIT bundle (Claude Code 2.1.243+) at all.
//
// Two layers, same doctrine as test/regression.test.cjs:
//
//   1. ALWAYS-ON, hermetic. Synthetic bytes, no provider needed. These assert the
//      REFUSALS, because the decoder's whole value is that it throws instead of
//      returning a plausible-looking wrong answer. A 32-byte error in `base` produced
//      names that looked perfectly valid attached to the WRONG module's source — the
//      failure mode this file exists to make impossible to ship.
//
//   2. REAL PROVIDER, gated. Decodes actual binaries and asserts the facts clode will
//      branch on. The gate resolves a provider the same way the product does, and
//      SKIPS ONLY when there is genuinely none — never silently, and never keyed to a
//      single hard-coded directory. (On 2026-08-25, 16 clode-watch tests were found to
//      have skipped in CI forever because their gate checked the shared user store
//      while CI populates deps/claude. A gate that looks somewhere the code does not is
//      a coin flip, not a test.)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const bunGraph = require('../libexec/bun-graph.cjs');
const {
  decodeBunGraph, loadGraphFromBytes, loadGraphFull, loadAssetsFromBytes, TRAILER, MODULE_FORMAT, LOADER,
} = bunGraph;

// ---- layer 1: hermetic refusals ---------------------------------------------

function bytes(str) {
  const u = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff;
  return u;
}

test('refuses input with no Bun trailer', () => {
  assert.throws(() => decodeBunGraph(bytes('not a bun binary at all')), /no .*Bun.* trailer/);
});

test('refuses a trailer too close to the start of the file', () => {
  assert.throws(() => decodeBunGraph(bytes(TRAILER)), /too close to start|runs off the front/);
});

test('refuses a byteCount that runs off the front of the file', () => {
  // 32-byte Offsets struct with a byteCount far larger than the file.
  const head = new Uint8Array(32);
  const put = (p, v) => { head[p] = v & 255; head[p + 1] = (v >> 8) & 255; head[p + 2] = (v >> 16) & 255; head[p + 3] = (v >>> 24) & 255; };
  put(0, 0xffffff);                      // byteCount lo
  const u = new Uint8Array(head.length + TRAILER.length);
  u.set(head, 0); u.set(bytes(TRAILER), head.length);
  assert.throws(() => decodeBunGraph(u), /runs off the front/);
});

test('refuses a module table whose length is not a multiple of the row stride', () => {
  const total = 256;
  const u = new Uint8Array(total + TRAILER.length);
  const h = total - 32;
  const put = (p, v) => { u[p] = v & 255; u[p + 1] = (v >> 8) & 255; u[p + 2] = (v >> 16) & 255; u[p + 3] = (v >>> 24) & 255; };
  put(h, total - 32);      // byteCount -> base 0
  put(h + 8, 0);           // modulesOffset
  put(h + 12, 53);         // modulesLength: NOT a multiple of 52
  u.set(bytes(TRAILER), total);
  assert.throws(() => decodeBunGraph(u), /not a multiple of 52/);
});

test('the ESM/CJS discriminator is a stable, documented pair', () => {
  // clode branches carve-vs-relink on this. If upstream ever adds a third value the
  // branch must be revisited deliberately, not defaulted.
  assert.deepStrictEqual(MODULE_FORMAT, { ESM: 1, CJS: 2 });
  assert.strictEqual(LOADER[1], 'js');
  assert.strictEqual(LOADER[10], 'napi');
});

// ---- what 2.1.246 taught us about the CONTAINER, pinned hermetically ----------
//
// These exist because the lesson arrived as a RED MATRIX rather than as a test. Claude
// Code 2.1.246 repacked its module rows, and this decoder asserted the whole per-row
// LAYOUT — field@+16 empty, contents at exactly name+len+1, blobA/blobB/sourcePath
// forming one contiguous backwards run. All five fired. That was an accurate description
// of 2.1.243-2.1.245 and was never a property of the format, and because isSplitBundle()
// swallowed the exception, clode reported "bundle format may have changed" on a bundle
// whose graph was fine.
//
// The fix narrowed the invariants to what the format actually guarantees. Without these
// tests that fix is only "true because a 2.1.246 provider happened to be installed when
// someone ran the suite" — so they build the awkward shapes directly and need no provider.
//
// Row: u32 nameOff, u32 nameLen, u32 bodyOff, u32 bodyLen, 2 u32 unused, blobA, blobB,
// sourcePath, loader@+49, moduleFormat@+50. base = 0 here, so offsets are file offsets.
function container(rows, opts = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const meta = [];
  let off = 0;
  for (const r of rows) {
    const name = enc.encode(r.name);
    const body = r.body instanceof Uint8Array ? r.body : enc.encode(r.body);
    const gap = opts.gap || 0;                       // bytes wedged between name\0 and body
    parts.push(name, Uint8Array.of(0));
    if (gap) parts.push(new Uint8Array(gap));
    parts.push(body, Uint8Array.of(0));
    meta.push({
      nameOff: off, nameLen: name.length,
      bodyOff: off + name.length + 1 + gap, bodyLen: body.length,
      loader: r.loader === undefined ? 1 : r.loader,
      moduleFormat: r.moduleFormat === undefined ? 1 : r.moduleFormat,
    });
    off += name.length + 1 + gap + body.length + 1;
  }
  const dataLen = off;
  const table = new Uint8Array(rows.length * 52);
  const tdv = new DataView(table.buffer);
  meta.forEach((m, i) => {
    const b = i * 52;
    tdv.setUint32(b + 0, m.nameOff, true); tdv.setUint32(b + 4, m.nameLen, true);
    tdv.setUint32(b + 8, m.bodyOff, true); tdv.setUint32(b + 12, m.bodyLen, true);
    if (opts.dirtyUnusedField) { tdv.setUint32(b + 16, 7, true); tdv.setUint32(b + 20, 3, true); }
    table[b + 49] = m.loader;
    table[b + 50] = m.moduleFormat;
  });
  const h = dataLen + table.length + 1;
  const total = h + 32;
  const u = new Uint8Array(total + TRAILER.length);
  let p = 0;
  for (const c of parts) { u.set(c, p); p += c.length; }
  u.set(table, dataLen);
  const dv = new DataView(u.buffer);
  dv.setUint32(h, h, true);                    // byteCount lo (base = 0)
  dv.setUint32(h + 8, dataLen, true);          // modulesOffset
  dv.setUint32(h + 12, table.length, true);    // modulesLength
  dv.setUint32(h + 16, opts.entry || 0, true); // entryPointId
  u.set(bytes(TRAILER), total);
  return u;
}

test('decodes a container whose contents do NOT immediately follow name+NUL', () => {
  // The 2.1.246 shape. Packing is upstream's business; what we require is that the
  // offsets are in range and the strings end where the row says they do.
  const u = container([
    { name: '/$bunfs/root/cli', body: 'export const a = 1;' },
    { name: '/$bunfs/root/dep.js', body: 'export const b = 2;' },
  ], { gap: 7 });
  const mods = loadGraphFromBytes(u);
  assert.strictEqual(mods.size, 2);
  assert.strictEqual(mods.get('/$bunfs/root/cli'), 'export const a = 1;');
  assert.strictEqual(mods.get('/$bunfs/root/dep.js'), 'export const b = 2;');
});

test('a non-empty field at +16 is not a reason to refuse', () => {
  // Also asserted the layout once. Upstream may use those bytes; we do not read them.
  const u = container([{ name: '/$bunfs/root/cli', body: 'export const a = 1;' }],
    { dirtyUnusedField: true });
  assert.strictEqual(loadGraphFromBytes(u).get('/$bunfs/root/cli'), 'export const a = 1;');
});

test('but a mis-stated length still fails LOUDLY — the invariant we KEPT', () => {
  // The check that earns its place: it catches a misread offset, which is the failure
  // that yields a plausible WRONG answer rather than an error. Corrupt the name length so
  // the byte at name+len is not the NUL the row promises.
  const u = container([{ name: '/$bunfs/root/cli', body: 'export const a = 1;' }]);
  const h = u.length - TRAILER.length - 32;
  const dv = new DataView(u.buffer);
  const tableOff = dv.getUint32(h + 8, true);
  dv.setUint32(tableOff + 4, 3, true);          // nameLen 16 -> 3
  assert.throws(() => loadGraphFromBytes(u), /not NUL-terminated/);
});

// BUILD THE FIXTURE THE WAY THE ENGINE CAN. `zlib.zstdCompressSync` is Node-only — the shim has
// no zstd whatsoever — so a fixture built with it made this test, the one that pins the loader-5
// decode, fail on the ENGINE for a reason that had nothing to do with the decode. The host CLI
// builds the same frame under both runtimes.
// THE CLI DECODE PATH CACHES ITS RESOLVED TOOL IN THE REAL STORE, so this file has to move the
// store before it runs. `zstdToText` -> `zstdViaCli` -> `provision('zstd')` with no `dataDir`,
// which defaults to `clodeDataDir(env)` = ~/.local/share/clode, and a successful resolve WRITES
// hosttools.json there. That caching is right for the product and stays; it is only a test that
// must not do it to a real directory.
//
// IT HAS TO BE THE ENVIRONMENT, not an options bag: bun-graph reads `process.env` itself
// (deliberately — it is the CLODE_RG / CLODE_BFS convention), so there is no opts seam to inject
// through, and the same env must reach the CHILD runtimes the deadlock guard spawns. Same
// CLODE_STATE_ROOT idiom as test/naude-sea.test.cjs and test/node-shim-toolchain.test.cjs.
//
// AND IT IS INVISIBLE ON A DEVELOPER BOX, which is the whole reason it shipped: test/run.mjs's
// hermetic guard catches `ABSENT -> created`, and on any machine that has ever run clode the
// store already exists, so the transition never happens. It failed on every fresh CI runner and
// on no local run. Reproduce the CI condition with `HOME=$(mktemp -d)` before believing a green
// run here. (node:test gives each FILE its own process, so this cannot leak sideways; the exit
// hook restores it anyway for anyone who loads this file some other way.)
const REAL_STATE_ROOT = process.env.CLODE_STATE_ROOT;
process.env.CLODE_STATE_ROOT = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'clode-bg-state-'));
process.on('exit', () => {
  if (REAL_STATE_ROOT === undefined) delete process.env.CLODE_STATE_ROOT;
  else process.env.CLODE_STATE_ROOT = REAL_STATE_ROOT;
});

const ZSTD_BIN = process.env.CLODE_ZSTD || 'zstd';
function hostZstd() {
  try {
    const r = require('node:child_process').spawnSync(ZSTD_BIN, ['--version'], { encoding: 'utf8' });
    return !!r && r.status === 0;
  } catch (e) { return false; }
}
const HAVE_ZSTD_CLI = hostZstd();
function haveZlibZstd() {
  try { return typeof require('node:zlib').zstdCompressSync === 'function'; } catch (e) { return false; }
}
const HAVE_ZLIB_ZSTD = haveZlibZstd();
// EVERY FIXTURE FRAME IS BUILT FROM A FILE, never through the child's stdin. The stdin shape is
// the write-all-then-drain hazard the product itself now avoids (see bun-graph.cjs); a fixture
// builder that used it would, on a leg whose wall sits lower than this one's, turn into a silent
// 120-second engine-test timeout instead of a comprehensible failure. The `timeout` is a second
// belt: if it ever does hang, it fails in 60 s naming the cause.
let SCRATCH = null;
function scratch() {
  // ROOM FOR THE BIG FIXTURE, WITHOUT MOVING EVERY TOOL'S SCRATCH. The deadlock guard below
  // decompresses a ~4MB frame to 6MB, and on Windows runners os.tmpdir() is
  // C:\\Users\\RUNNER~1\\AppData\\Local\\Temp on the small C: volume — that job died twice with
  // `zstd: error 70 : Write error : ... No space left on device`. RUNNER_TEMP is on the roomy
  // D:, so ask for it HERE rather than redirecting TMP/TEMP/TMPDIR for the whole job: Git for
  // Windows ships GNU tar, which reads `D:\\a\\_temp\\x` as the remote host `D` and fails with
  // `/usr/bin/tar: D` (MSYS mounts C: but not D:). Job-wide redirection was tried and reverted.
  if (!SCRATCH) {
    const roomy = process.env.RUNNER_TEMP || require('node:os').tmpdir();
    SCRATCH = fs.mkdtempSync(path.join(roomy, 'clode-zstd-test-'));
  }
  return SCRATCH;
}
function makeZstdFrame(text) {
  if (HAVE_ZLIB_ZSTD) return require('node:zlib').zstdCompressSync(Buffer.from(text, 'utf8'));
  const src = path.join(scratch(), 'plain.txt');
  fs.writeFileSync(src, Buffer.from(text, 'utf8'));
  try {
    return execFileSync(ZSTD_BIN, ['-q', '-c', src], { maxBuffer: 1 << 28, timeout: 60000 });
  } finally { try { fs.unlinkSync(src); } catch (e) { /* best effort */ } }
}
// The CLI specifically, even where zlib could compress — the deadlock guard below needs a frame
// whose SIZE it controls, and zlib and the CLI do not produce identical sizes.
function makeZstdFrameViaCli(buf) {
  const src = path.join(scratch(), 'plain.bin');
  fs.writeFileSync(src, buf);
  try {
    return execFileSync(ZSTD_BIN, ['-q', '-c', src], { maxBuffer: 1 << 28, timeout: 60000 });
  } finally { try { fs.unlinkSync(src); } catch (e) { /* best effort */ } }
}
const compressOpts = (HAVE_ZLIB_ZSTD || HAVE_ZSTD_CLI) ? {}
  : { skip: `no zstd compressor: neither node:zlib.zstdCompressSync nor \`${ZSTD_BIN}\` on PATH` };
const zstdOpts = HAVE_ZSTD_CLI ? {}
  : { skip: `no \`${ZSTD_BIN}\` on PATH (set CLODE_ZSTD); cannot build a real frame to decode` };

// POORLY COMPRESSIBLE ON PURPOSE. The stdin deadlock is driven by FRAME size, so a fixture has to
// resist compression to reach it — and a first draft of this used a plain LCG
// (`x*1103515245+12345`), which loses precision past 2^53 in JS, degenerates, and compressed 90:1.
// 4 MB of "random" text became a 44 KB frame, well under the wall the test was supposed to clear.
// xorshift32 stays in 32-bit range and holds a ~1.58:1 ratio.
function pseudoText(nbytes) {
  const parts = [];
  let total = 0, x = 123456789;
  while (total < nbytes) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const t = x.toString(36) + ' ';
    parts.push(t); total += t.length;
  }
  return parts.join('');
}

// Re-invoke WHICHEVER RUNTIME is executing this file, so the deadlock guard tests the engine when
// run under the engine and node when run under node. engine-test.mjs scrubs CLODE_* but sets
// CLODE_TJS explicitly, which is how the child engine is located.
const IS_TJS = typeof globalThis.tjs !== 'undefined';
function childRuntime(script) {
  if (IS_TJS) {
    return [process.env.CLODE_TJS, ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'), script]];
  }
  return [process.execPath, [script]];
}

// The stderr row needs a POSIX shell script as a fake decoder; win32 has no /bin/sh to run one.
const stderrOpts = !HAVE_ZSTD_CLI ? zstdOpts
  : (process.platform === 'win32' ? { skip: 'needs a /bin/sh fake decoder; not on win32' } : {});

// 2.1.251 MOVED 94 EMBEDDED ASSETS from loader 13 to loader 5 by COMPRESSING them, and taking
// only loader 13 shipped a target that built green and died on its first turn with upstream's
// own "embedded text asset is missing or corrupt". Rows by loader, measured on the real
// providers: 2.1.250 {"1":1777,"5":4,"10":5,"13":166} -> 2.1.251 {"1":1799,"5":101,"10":5,"13":72}.
// Loader 10 (napi) stays out; it is native .node code no target loads.
test('loadAssets takes loader 5 as well as 13, and decodes the zstd frames', compressOpts, () => {
  const plain = '# SKILL\nbody text\n';
  const frame = new Uint8Array(makeZstdFrame(plain));
  assert.deepStrictEqual([...frame.slice(0, 4)], [0x28, 0xb5, 0x2f, 0xfd], 'fixture must be a zstd frame');
  const u = container([
    { name: '/$bunfs/root/cli', body: 'export{};', loader: 1 },
    { name: '/$bunfs/root/plain.md', body: plain, loader: 13 },
    { name: '/$bunfs/root/squeezed.md.zst', body: frame, loader: 5 },
    { name: '/$bunfs/root/native.node', body: 'BINARY', loader: 10 },
  ]);
  const assets = loadAssetsFromBytes(u);
  assert.strictEqual(assets.get('/$bunfs/root/plain.md'), plain, 'loader 13 is unchanged');
  assert.strictEqual(assets.get('/$bunfs/root/squeezed.md.zst'), plain,
    'a loader-5 zstd frame must arrive DECOMPRESSED — the target has no zstd to do it later');
  assert.ok(!assets.has('/$bunfs/root/native.node'), 'loader 10 (napi) stays out');
  assert.strictEqual(assets.size, 2);
});

// An uncompressed loader-5 row is not hypothetical: it is what a future bundle would produce if
// upstream stopped compressing, and the magic check is what tells the two apart.
test('loadAssets passes an UNCOMPRESSED loader-5 row through as text', () => {
  const u = container([
    { name: '/$bunfs/root/cli', body: 'export{};', loader: 1 },
    { name: '/$bunfs/root/raw.txt', body: 'not compressed', loader: 5 },
  ]);
  assert.strictEqual(loadAssetsFromBytes(u).get('/$bunfs/root/raw.txt'), 'not compressed');
});

test('loader 13 is text — the row class 2.1.246 introduced', () => {
  // 164 rows in 2.1.246 (118 .md), zero before it. Dropping them builds a target that
  // boots and dies on its first turn, so the decoder has to name this class.
  assert.strictEqual(LOADER[13], 'text');
});

// ---- the external zstd decoder: the ONLY path the SHIPPED builder has --------
//
// `node:zlib.zstdDecompressSync` is a Node 22.15/24+ thing. Every PUBLISHED clode is a fused
// tjs binary, and tjs has no zstd anywhere — so on the shipped artifact these tests are the
// whole of zstd support. They are written to run identically under `node --test` and under
// scripts/engine-test.mjs, because a green run on Node proves nothing about the thing we ship.

test('zstdToText decodes a real CLI-made frame, by CLI and by zlib alike', zstdOpts, () => {
  const zstdText = 'clode zstd round-trip ' + 'x'.repeat(4096);
  const frame = makeZstdFrameViaCli(Buffer.from(zstdText));
  assert.deepStrictEqual(Array.from(frame.subarray(0, 4)), [0x28, 0xb5, 0x2f, 0xfd], 'is a zstd frame');
  // The CLI path must produce byte-identical text to the zlib path.
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), zstdText);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), zstdText);
});

// A MULTI-BLOCK frame, so the round-trip covers more than one zstd block in each direction. This
// is a CORRECTNESS row and nothing more — it does NOT guard the stdin deadlock. Its earlier
// comment claimed it did, which was false: 2 MB of this text compresses to ~1.33 MB, and a
// stdin-shaped decoder handles that size perfectly well on the engine (measured). The guard is
// the next test, and it is sized against the measured wall.
test('zstdToText decodes a multi-block frame identically both ways', zstdOpts, () => {
  const s = pseudoText(2 << 20);
  const frame = makeZstdFrameViaCli(Buffer.from(s));
  assert.ok(frame.length > (1 << 20), `frame should be multi-block, got ${frame.length}`);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), s);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), s);
});

// THE REGRESSION GUARD FOR THE STDIN DEADLOCK, and it is sized from a measurement rather than a
// guess. tjs's spawnSync writes the whole of `input` to the child before it starts draining
// stdout, so a large enough frame deadlocks: parent blocked writing stdin, child blocked writing
// a full stdout. Where the wall sits is NOT obvious and is not the pipe capacity (65536 here) —
// measured on darwin/arm64 under the engine, decoding through stdin:
//
//     plaintext 2 MB -> frame 1,326,257  OK        plaintext 4 MB -> frame 2,653,148  HANGS
//     plaintext 3 MB -> frame 1,989,824  OK        plaintext 6 MB -> frame 3,980,022  HANGS
//
// So the fixture is 6 MB of plaintext (~3.98 MB frame), half again past the smallest size proven
// to hang, on the most permissive platform available here. Linux and Windows pipes are smaller,
// so a fixture sized for darwin is conservative everywhere.
//
// It runs in a CHILD of whichever runtime is executing this file, with a timeout, so a decoder
// that regresses to `{ input: buf }` FAILS IN 60 SECONDS SAYING SO instead of hanging the harness
// until engine-test's own timeout kills it with no explanation. Proved red by actually reverting
// zstdViaCli to the stdin shape and running it under engine-test — not by the seam being absent.
const deadlockOpts = !HAVE_ZSTD_CLI ? zstdOpts
  : (IS_TJS && !process.env.CLODE_TJS)
    ? { skip: 'running on tjs but CLODE_TJS is unset, so the child engine cannot be located' }
    : {};
// The guard below can fail three ways and only ONE of them is the regression it was built for.
// Told apart from the child's own result rather than assumed — see the hermetic row at the
// bottom of this file for the incident that made naming them separately necessary.
function describeDecodeFailure(frameLen, r) {
  const stderr = String(r.stderr || '').trim();
  const head = `decoding a ${frameLen}-byte frame did not complete`;
  // node's spawnSync reports a timeout as status null + a signal + error.code ETIMEDOUT; any
  // other kill also arrives as status null with a signal. Either way the child never chose to
  // exit, which is what "hung" means here.
  const hung = (r.error && r.error.code === 'ETIMEDOUT') || (r.status === null && !!r.signal);
  if (hung) {
    return `${head}: the child HUNG and had to be killed (signal=${r.signal}, `
      + `err=${r.error && r.error.code}). That is this guard's regression: the decoder is `
      + "streaming the frame through the child's stdin, so the parent blocks writing it while "
      + 'the child blocks on a stdout nobody is draining.'
      + (stderr ? `\nwhat the child said before it hung:\n${stderr.slice(0, 800)}` : '');
  }
  if (stderr) {
    return `${head}: the decoder FAILED on its own terms — it exited ${r.status} rather than `
      + 'hanging, so the hazard this guard watches for is NOT what happened. What it said IS '
      + `the diagnosis:\n${stderr.slice(0, 1200)}`;
  }
  return `${head}: the child exited ${r.status} and said nothing — no output at all, so neither `
    + '"it hung" nor "it failed for reason X" can be concluded from this result. Re-run it with '
    + "the child's stderr inherited.";
}

test('the decoder must not stream the frame through the child stdin (deadlock guard)', deadlockOpts, () => {
  const plain = Buffer.from(pseudoText(6 << 20));
  const frame = makeZstdFrameViaCli(plain);
  assert.ok(frame.length > 2653148,
    `fixture must exceed the smallest frame PROVEN to deadlock, got ${frame.length}`);
  const framePath = path.join(scratch(), 'deadlock.zst');
  fs.writeFileSync(framePath, frame);
  const script = path.join(scratch(), 'decode.cjs');
  fs.writeFileSync(script, `
    const fs = require('node:fs');
    const bg = require(${JSON.stringify(path.join(REPO, 'libexec/bun-graph.cjs'))});
    const f = fs.readFileSync(${JSON.stringify(framePath)});
    console.log('LEN ' + bg.__zstdToTextForTest(f, 0, f.length, { forceCli: true }).length);
  `);
  const [cmd, argv] = childRuntime(script);
  const r = require('node:child_process').spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, describeDecodeFailure(frame.length, r));
  assert.strictEqual((r.stdout || '').trim(), 'LEN ' + plain.length);
});

// CONCATENATED FRAMES ARE THE ONE INPUT ON WHICH THE TWO PATHS DISAGREE: `zstd -d -c` returns
// every frame in the sequence, node:zlib returns only the first, and neither errors. Whichever
// one upstream's Bun.zstdDecompressSync matches, the other embeds different bytes into the
// target — silently. No 2.1.251 row is like this; the point is to hear about it if one ever is.
//
// BOTH paths must refuse, which is why the check is structural. A decoded-LENGTH check against
// Frame_Content_Size catches the CLI (it returns both frames) but is blind on the zlib path,
// where the returned first frame matches its own header exactly while the second is dropped.
// This test failed on precisely that asymmetry before the byte-level frame walk was added.
test('a concatenated frame sequence is REFUSED, not silently half-decoded', zstdOpts, () => {
  const one = makeZstdFrameViaCli(Buffer.from('first frame contents\n'));
  const two = makeZstdFrameViaCli(Buffer.from('second frame contents\n'));
  const pair = Buffer.concat([one, two]);
  for (const forceCli of [true, false]) {
    assert.throws(() => bunGraph.__zstdToTextForTest(pair, 0, pair.length, { forceCli }),
      /bytes after the end of its first frame|declares \d+ bytes of content but decoded to \d+/,
      `forceCli=${forceCli}: a frame sequence must be refused, not half-decoded`);
  }
  // and the single frame it was built from still decodes fine, so the check is not just "throw"
  assert.strictEqual(bunGraph.__zstdToTextForTest(one, 0, one.length, { forceCli: true }),
    'first frame contents\n');
});

// AN EMPTY ASSET IS NOT A BROKEN DECODER. The magic-byte gate admits a 13-byte frame whose
// payload is zero bytes, and a CLI wrapper that reads "status 0, no stdout" as failure would
// refuse an entire provider for containing one empty file.
test('an empty zstd frame decodes to an empty string, it does not refuse', zstdOpts, () => {
  const frame = makeZstdFrameViaCli(Buffer.alloc(0));
  assert.deepStrictEqual(Array.from(frame.subarray(0, 4)), [0x28, 0xb5, 0x2f, 0xfd], 'is a zstd frame');
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), '');
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), '');
});

// The env override, same convention as CLODE_RG / CLODE_BFS: name the binary, do not guess at it.
// The refusal has to say WHY. This fails on machines we are not sitting at; "cannot decode them"
// with no cause sends the next person hunting the provider instead of their PATH.
test('CLODE_ZSTD names the decoder, and the refusal names the cause', zstdOpts, () => {
  const frame = makeZstdFrameViaCli(Buffer.from('hello'));
  const saved = process.env.CLODE_ZSTD;
  try {
    process.env.CLODE_ZSTD = '/nonexistent/definitely-not-zstd';
    assert.throws(() => bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }),
      /cannot decode them/, 'a bad CLODE_ZSTD must refuse loudly, not silently fall back');
    assert.throws(() => bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }),
      /definitely-not-zstd/, 'the error must name the binary it could not run');
  } finally {
    if (saved === undefined) delete process.env.CLODE_ZSTD; else process.env.CLODE_ZSTD = saved;
  }
});

// CHARACTERIZATION (not proved red — it pins behaviour the fix already had): when the decoder
// RUNS but fails, its own stderr is the only thing that can say why, so it must reach the caller.
test('a decoder that runs and fails surfaces its stderr', stderrOpts, () => {
  const frame = makeZstdFrameViaCli(Buffer.from('hello'));
  const fake = path.join(scratch(), 'fake-zstd');
  fs.writeFileSync(fake, '#!/bin/sh\necho "zstd: unsupported frame parameter" 1>&2\nexit 3\n');
  fs.chmodSync(fake, 0o755);
  const saved = process.env.CLODE_ZSTD;
  try {
    process.env.CLODE_ZSTD = fake;
    assert.throws(() => bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }),
      /unsupported frame parameter/, 'the decoder stderr must reach the refusal');
  } finally {
    if (saved === undefined) delete process.env.CLODE_ZSTD; else process.env.CLODE_ZSTD = saved;
  }
});

// A zstd frame WITH NO Frame_Content_Size, hand-built from RFC 8878's simplest legal shape:
// magic, a Frame_Header_Descriptor of 0 (no content size, not single-segment, no checksum, no
// dictionary), a 1-byte Window_Descriptor, then one LAST/RAW block. Deterministic, tiny, and
// buildable under either runtime with no tool at all — and NO decoder is needed to predict what
// it must decode to.
//
// It is the input that matters here because it is the one the frame-shape checks CANNOT judge:
// with the content size absent, `zstdContentSize` returns null and the length comparison is
// skipped, so nothing downstream can tell a real decode from a passthrough. Whether the resolved
// binary actually decodes zstd has to be established BEFORE it is trusted, which is what the
// host-provision known-answer test does.
function rawZstdFrame(text) {
  const body = Buffer.from(text, 'utf8');
  const h = 1 | (0 << 1) | (body.length << 3);   // Last_Block=1, Block_Type=0 (Raw), Block_Size
  return Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]),
    Buffer.from([h & 255, (h >> 8) & 255, (h >> 16) & 255]),
    body,
  ]);
}

// THE FAILURE THIS PREVENTS IS NOT HYPOTHETICAL, it is the shape that ships: a CLODE_ZSTD (or a
// PATH `zstd`) that exits 0 and hands back exactly what it was given passes every cheap check —
// status 0, output present, nothing on stderr — and the carve then embeds the COMPRESSED FRAME as
// the asset's text. The build is green, `--version` is green, the mock PONG is green, and the
// target dies on its first real turn with upstream's own "embedded text asset is missing or
// corrupt". Only running the candidate on a KNOWN frame and comparing exact bytes catches it.
test('a decoder that only echoes its input is REFUSED, not taken as asset text', stderrOpts, () => {
  const plain = 'hand-built raw block, no Frame_Content_Size';
  const frame = new Uint8Array(rawZstdFrame(plain));
  // Control: the frame is real, and a real decoder round-trips it on BOTH paths. Without this
  // the row below could pass because the fixture is malformed rather than because the fake was
  // caught — the green-control lesson, applied here.
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), plain);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), plain);

  const fake = path.join(scratch(), 'passthru-zstd');
  fs.writeFileSync(fake, '#!/bin/sh\n# ignore every flag; echo the last argument\'s bytes straight back\neval "f=\\${$#}"\nexec cat "$f"\n');
  fs.chmodSync(fake, 0o755);
  const saved = process.env.CLODE_ZSTD;
  try {
    process.env.CLODE_ZSTD = fake;
    assert.throws(() => bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }),
      /cannot decode them/,
      'a passthrough must be refused, never returned as the asset text');
  } finally {
    if (saved === undefined) delete process.env.CLODE_ZSTD; else process.env.CLODE_ZSTD = saved;
  }
});

// ---- layer 2: real providers -------------------------------------------------

// Resolve a provider the way the product does, then fall back to anything the test
// fixtures already know about. Skipping is reported with WHERE we looked.
function providers() {
  const found = [];
  const seen = new Set();
  const add = (p) => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); found.push(p); } };
  add(process.env.CLODE_PROVIDER_BIN);
  add(process.env.CLODE_CLAUDE_BIN);
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8' }).trim();
    add(out);
  } catch { /* no provider on this box; reported by the skip message */ }
  try {
    const { VERSIONS, providerBin } = require('./golden-shas-lib.cjs');
    for (const v of VERSIONS) add(providerBin(v));
  } catch { /* fixture lib unavailable */ }
  return found;
}

const PROVIDERS = providers();
const provOpts = {
  skip: PROVIDERS.length ? false
    : 'no Claude provider found (CLODE_PROVIDER_BIN, CLODE_CLAUDE_BIN, scripts/find-provider.mjs, or the golden-shas store)',
};

test('every real provider decodes, and every JS row is NUL-framed and named', provOpts, () => {
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    assert.ok(g.count > 0, `${bin}: no rows`);
    assert.ok(g.entryName.startsWith('/$bunfs/'), `${bin}: entry ${g.entryName}`);
    const js = g.rows.filter((r) => r.loader === 1);
    assert.ok(js.length > 0, `${bin}: no js rows`);
    for (const r of js) {
      assert.match(r.name, /^\/\$bunfs\/root\//, `${bin}: row ${r.index} name ${JSON.stringify(r.name)}`);
      assert.ok(r.contentsLength > 0, `${bin}: row ${r.index} empty contents`);
    }
  }
});

test('module_format partitions cleanly — a bundle is all-CJS or all-ESM, never mixed', provOpts, () => {
  // This is the fact clode branches on. If a bundle ever mixes formats, the
  // carve-vs-relink decision stops being a property of the BUNDLE and becomes a
  // property of each module, which is a different design. Fail loudly if so.
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    const formats = new Set(g.rows.filter((r) => r.loader === 1).map((r) => r.moduleFormat));
    assert.strictEqual(formats.size, 1, `${bin}: mixed module formats ${[...formats]}`);
    const only = [...formats][0];
    assert.ok(only === MODULE_FORMAT.ESM || only === MODULE_FORMAT.CJS,
      `${bin}: unknown module_format ${only} — upstream added a third shape; revisit the branch`);
  }
});

test('a CJS bundle decodes to the same entry bytes clode carves today', provOpts, () => {
  // The safety property for every currently-working user: bringing the table-driven
  // decoder in must not disturb the carve path. The decoded module is exactly the
  // wrapper plus the body carveBlocks returns.
  const { carveBlocks } = require('../libexec/bundle-carve.cjs');
  const PRE = '// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {';
  let checked = 0;
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    const js = g.rows.filter((r) => r.loader === 1);
    if (!js.length || js[0].moduleFormat !== MODULE_FORMAT.CJS) continue;
    const text = fs.readFileSync(bin, 'latin1');
    const cli = carveBlocks(text).find((b) => b.name && /entrypoints\/cli\.js$/.test(b.name));
    if (!cli) continue;
    const row = g.rows.find((r) => r.name === g.entryName);
    const decoded = text.slice(row.contentsStart, row.contentsEnd);
    assert.ok(decoded.startsWith(PRE), `${bin}: entry does not start with the CJS wrapper`);
    assert.strictEqual(decoded.slice(PRE.length, PRE.length + cli.body.length), cli.body,
      `${bin}: decoded entry body differs from the carve`);
    assert.strictEqual(decoded.slice(PRE.length + cli.body.length), '})\n',
      `${bin}: unexpected tail after the carved body`);
    checked++;
  }
  if (!checked) return; // no CJS-format provider present; the partition test covers shape
  assert.ok(checked > 0);
});

test('loadGraphFromBytes returns only js rows, keyed by module name', provOpts, () => {
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    const mods = loadGraphFromBytes(new Uint8Array(fs.readFileSync(bin)));
    assert.strictEqual(mods.size, g.rows.filter((r) => r.loader === 1).length, bin);
    for (const [name, src] of mods) {
      assert.match(name, /^\/\$bunfs\/root\//, bin);
      assert.strictEqual(typeof src, 'string', bin);
    }
  }
});

// THE GUARD ABOVE MUST NOT NAME THE WRONG CAUSE. It asserts only that the child exited 0, and
// its message used to blame the stdin deadlock for every way that can fail. On 2026-08-29 a
// windows-latest runner ran out of disk; `C:\tools\zstd\zstd.EXE` exited 70 with
// `zstd: error 70 : Write error : cannot write block : No space left on device`; bun-graph
// reported that verbatim on the child's stderr — and the row still said "the decoder is
// streaming the frame through the child's stdin, which deadlocks under tjs". The real cause was
// sitting in `r.stderr` the whole time, and the wrong one cost a reviewer a diagnosis.
//
// A diagnostic that confidently names the wrong cause is worse than no diagnostic, so the three
// outcomes are told apart from the child's own result and asserted here — hermetically, with no
// zstd, no engine and no 6 MB fixture, so this row runs on every leg including the ones where
// the guard itself skips.
test('the deadlock guard tells a hung decode apart from a failed one', () => {
  const HUNG = describeDecodeFailure(3980022, {
    status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '',
  });
  assert.match(HUNG, /HUNG/, 'a timed-out child is the deadlock this guard exists for');
  assert.match(HUNG, /streaming the frame/,
    'and for THAT outcome the stdin claim is the right one to make');

  // The real CI failure, verbatim. It must NOT be reported as the deadlock.
  const FAILED = describeDecodeFailure(3980022, {
    status: 1, signal: null, error: undefined, stdout: '',
    stderr: 'Error: bun-graph: this provider embeds zstd-compressed assets and this runtime cannot '
      + 'decode them (C:\\tools\\zstd\\zstd.EXE exited 70: zstd: error 70 : Write error : cannot '
      + 'write block : No space left on device)',
  });
  assert.doesNotMatch(FAILED, /HUNG|streaming the frame/,
    'a decoder that FAILED and said why must not be reported as the stdin deadlock');
  assert.match(FAILED, /No space left on device/,
    "the decoder's own stderr is the diagnosis and must be quoted, not summarised away");
  assert.match(FAILED, /exited 1\b/);

  // Nonzero, silent: neither conclusion is available, and it must say so rather than pick one.
  const MUTE = describeDecodeFailure(3980022, { status: 3, signal: null, error: undefined, stdout: '', stderr: '   ' });
  assert.doesNotMatch(MUTE, /HUNG|streaming the frame/);
  assert.match(MUTE, /no output at all|said nothing/i);
});
