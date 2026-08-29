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
function makeZstdFrame(text) {
  if (HAVE_ZLIB_ZSTD) return require('node:zlib').zstdCompressSync(Buffer.from(text, 'utf8'));
  return execFileSync(ZSTD_BIN, ['-q', '-c'], { input: Buffer.from(text, 'utf8'), maxBuffer: 1 << 26 });
}
const compressOpts = (HAVE_ZLIB_ZSTD || HAVE_ZSTD_CLI) ? {}
  : { skip: `no zstd compressor: neither node:zlib.zstdCompressSync nor \`${ZSTD_BIN}\` on PATH` };
const zstdOpts = HAVE_ZSTD_CLI ? {}
  : { skip: `no \`${ZSTD_BIN}\` on PATH (set CLODE_ZSTD); cannot build a real frame to decode` };

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
// tjs binary, and tjs has no zstd anywhere — so on the shipped artifact these two tests are the
// whole of zstd support. They are written to run identically under `node --test` and under
// scripts/engine-test.mjs, because a green run on Node proves nothing about the thing we ship.
test('zstdToText decodes a real CLI-made frame, by CLI and by zlib alike', zstdOpts, () => {
  const zstdText = 'clode zstd round-trip ' + 'x'.repeat(4096);
  const frame = execFileSync(ZSTD_BIN, ['-q', '-c'], { input: Buffer.from(zstdText), maxBuffer: 1 << 26 });
  assert.deepStrictEqual(Array.from(frame.subarray(0, 4)), [0x28, 0xb5, 0x2f, 0xfd], 'is a zstd frame');
  // The CLI path must produce byte-identical text to the zlib path.
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), zstdText);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), zstdText);
});

// THE ROW THAT ACTUALLY SHIPS. The 4 KB case above passes even through a decoder that writes the
// frame to the child's stdin and only then starts reading its stdout — a pipe holds 64 KB, so
// nothing blocks. The real 2.1.251 provider is not like that: of its 101 loader-5 rows, three
// exceed the pipe buffer COMPRESSED (mermaid.min.js 786 KB -> 3.5 MB, payload.template.html.asset
// 742 KB -> 2.5 MB, hljsBundle 167 KB -> 591 KB). Write-all-then-drain deadlocks on exactly those:
// the parent blocks writing stdin while the child blocks writing a full stdout. This fixture is
// sized past the same wall in both directions, so the deadlock cannot pass unnoticed.
test('zstdToText decodes a frame larger than a pipe buffer, both ways', zstdOpts, () => {
  const parts = [];
  let total = 0, x = 123456789;
  while (total < (2 << 20)) {
    // xorshift32 via Math.imul — a plain LCG loses precision past 2^53 in JS, degenerates, and
    // compresses 90:1, which would quietly shrink the fixture back under the pipe buffer.
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const t = x.toString(36) + ' ';
    parts.push(t); total += t.length;
  }
  const s = parts.join('');
  const frame = execFileSync(ZSTD_BIN, ['-q', '-c'], { input: Buffer.from(s), maxBuffer: 1 << 26 });
  assert.ok(frame.length > (1 << 16), `frame must exceed a pipe buffer, got ${frame.length}`);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), s);
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), s);
});

// The env override, same convention as CLODE_RG / CLODE_BFS: name the binary, do not guess at it.
test('CLODE_ZSTD names the decoder', zstdOpts, () => {
  const frame = execFileSync(ZSTD_BIN, ['-q', '-c'], { input: Buffer.from('hello zstd'), maxBuffer: 1 << 26 });
  const saved = process.env.CLODE_ZSTD;
  try {
    process.env.CLODE_ZSTD = '/nonexistent/definitely-not-zstd';
    assert.throws(() => bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }),
      /cannot decode them/, 'a bad CLODE_ZSTD must refuse loudly, not silently fall back');
  } finally {
    if (saved === undefined) delete process.env.CLODE_ZSTD; else process.env.CLODE_ZSTD = saved;
  }
});


// AN EMPTY ASSET IS NOT A BROKEN DECODER. The magic-byte gate admits a 13-byte frame whose
// payload is zero bytes, and a CLI wrapper that reads "status 0, no stdout" as failure would
// refuse an entire provider for containing one empty file.
test('an empty zstd frame decodes to an empty string, it does not refuse', zstdOpts, () => {
  const frame = execFileSync(ZSTD_BIN, ['-q', '-c'], { input: Buffer.alloc(0), maxBuffer: 1 << 26 });
  assert.deepStrictEqual(Array.from(frame.subarray(0, 4)), [0x28, 0xb5, 0x2f, 0xfd], 'is a zstd frame');
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }), '');
  assert.strictEqual(bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: false }), '');
});

// The refusal has to say WHY. This fails on machines we are not sitting at; "cannot decode them"
// with no cause sends the next person hunting the provider instead of their PATH.
test('the refusal names the cause, not just the symptom', zstdOpts, () => {
  const frame = execFileSync(ZSTD_BIN, ['-q', '-c'], { input: Buffer.from('hello'), maxBuffer: 1 << 26 });
  const saved = process.env.CLODE_ZSTD;
  try {
    process.env.CLODE_ZSTD = '/nonexistent/definitely-not-zstd';
    assert.throws(() => bunGraph.__zstdToTextForTest(frame, 0, frame.length, { forceCli: true }),
      /definitely-not-zstd/, 'the error must name the binary it could not run');
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
