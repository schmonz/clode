'use strict';
// Follow-up 5 — the one range-fetchable templates blob.
// Spec: docs/superpowers/specs/2026-07-27-release-followups-design.md
//
// The release used to publish a manifest plus ~38 loose `<engine>.gz` rows,
// which buried the builder list the release page exists to show. It now
// publishes TWO assets: `templates-<pin>` (every engine's gzip member
// concatenated) and `templates-<pin>.json` (which records each target's
// {offset,length}). The same index drives BOTH
//   - remote  `Range: bytes=<offset>-<end>` for one ~2.4MB slice, and
//   - offline `fs.read(fd, offset, length)` from a pre-downloaded blob,
// so a user can bring their own blob and clode dials out for nothing.
//
// WHAT MAKES THE WHOLE THING WORK, and what these tests are really pinning:
// each member is an INDEPENDENT gzip stream, so an arbitrary byte slice is a
// complete .gz. If that ever stopped being true the slice would still often
// inflate to SOMETHING (concatenated members are a valid single stream), so the
// tests below check the inflated bytes are the RIGHT engine, not merely that
// inflation succeeded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { parseManifest, obtainEngine, TemplatesError } = require('../libexec/clode-templates.cjs');
const net = require('../libexec/clode-net.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// INJECTED inflate, exactly as test/clode-templates.test.cjs does. Letting the real
// gunzipBuffer run would call host-provision, which CACHES a resolved gzip tool into
// ~/.local/share/clode — a REAL dir test/run.mjs's hermeticity guard watches. That is
// invisible on a dev box where the store already exists and fails every fresh CI runner
// with ABSENT -> created. The real gunzipBuffer path is covered by clode-net's own tests.
const gunzip = async (b) => zlib.gunzipSync(b);

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clode-blob-${tag}-`));
}

// Three engines with DISTINCT, recognizable contents so a mis-sliced read is
// unmistakable rather than plausible.
function fixtureEngines() {
  return [
    { name: 'alpha-amd64', body: Buffer.from('ENGINE-ALPHA'.repeat(400)) },
    { name: 'beta-arm64', body: Buffer.from('ENGINE-BETA-'.repeat(700)) },
    { name: 'gamma-ppc', body: Buffer.from('ENGINE-GAMMA'.repeat(100)) },
  ];
}

// Build a blob the same way packBlob does, without importing the ESM builder
// into a CJS test: gzip each, concatenate, record offsets.
function packFixture(engines) {
  const parts = [];
  const slices = {};
  let offset = 0;
  for (const e of [...engines].sort((a, b) => a.name.localeCompare(b.name))) {
    const gz = zlib.gzipSync(e.body, { level: 9 });
    parts.push(gz);
    slices[e.name] = { offset, length: gz.length };
    offset += gz.length;
  }
  return { blob: Buffer.concat(parts), slices };
}

function fixtureManifest(engines, slices, pin = 'PIN') {
  const targets = {};
  for (const e of engines) {
    targets[e.name] = {
      tag: e.name, engine: `tjs-${e.name}-${pin}`, sha256: sha(e.body),
      verified: 'smoke', offset: slices[e.name].offset, length: slices[e.name].length,
    };
  }
  return { schema: 2, tjsPin: pin, blob: `templates-${pin}`, compression: 'gzip', targets };
}

test('each slice of the blob is an independent, complete gzip stream', () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  for (const e of engines) {
    const { offset, length } = slices[e.name];
    const slice = blob.subarray(offset, offset + length);
    assert.strictEqual(slice[0], 0x1f, `slice for ${e.name} does not start with gzip magic`);
    assert.strictEqual(slice[1], 0x8b, `slice for ${e.name} does not start with gzip magic`);
    assert.deepStrictEqual(zlib.gunzipSync(slice), e.body,
      `slice for ${e.name} inflated to the wrong bytes`);
  }
  // Sanity on the packing itself: the members must tile the blob with no gaps
  // and no overlap, or some target is unreachable / reads its neighbour.
  const ordered = Object.values(slices).sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const s of ordered) {
    assert.strictEqual(s.offset, cursor, 'slices must tile the blob with no gap/overlap');
    cursor += s.length;
  }
  assert.strictEqual(cursor, blob.length, 'slices must cover the whole blob');
});

test('parseManifest accepts schema 2 and rejects a blob whose targets lack offsets', () => {
  const engines = fixtureEngines();
  const { slices } = packFixture(engines);
  const m = fixtureManifest(engines, slices);
  assert.strictEqual(parseManifest(JSON.stringify(m)).blob, 'templates-PIN');

  const broken = JSON.parse(JSON.stringify(m));
  delete broken.targets['beta-arm64'].offset;
  assert.throws(() => parseManifest(JSON.stringify(broken)),
    (e) => e instanceof TemplatesError && /beta-arm64.*offset\/length/.test(e.message));
});

test('obtainEngine offline: reads its slice from a local blob, no network at all', async () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  const m = fixtureManifest(engines, slices);
  const dir = tmpdir('offline');
  const blobPath = path.join(dir, 'templates-PIN');
  fs.writeFileSync(blobPath, blob);

  const target = m.targets['beta-arm64'];
  const p = await obtainEngine(target, {
    cacheDir: path.join(dir, 'cache'),
    thisPin: 'PIN', manifestPin: 'PIN', compression: 'gzip', gunzip,
    blob: m.blob, blobPath,
    // Any network use at all is a test failure, not a fallback.
    fetch: async () => { throw new Error('offline mode must not fetch'); },
    fetchRange: async () => { throw new Error('offline mode must not fetch'); },
  });
  assert.deepStrictEqual(fs.readFileSync(p), engines.find((e) => e.name === 'beta-arm64').body);
});

test('obtainEngine remote: Range-fetches ONLY its own slice', async () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  const m = fixtureManifest(engines, slices);
  const dir = tmpdir('range');

  const asked = [];
  const fetchRange = async (url, offset, length) => {
    asked.push({ url, offset, length });
    return blob.subarray(offset, offset + length);
  };

  const target = m.targets['gamma-ppc'];
  const p = await obtainEngine(target, {
    cacheDir: path.join(dir, 'cache'),
    baseUrl: 'https://example.invalid/dl/',
    thisPin: 'PIN', manifestPin: 'PIN', compression: 'gzip', gunzip,
    blob: m.blob, blobPath: null,
    fetchRange,
    fetch: async () => { throw new Error('blob mode must not whole-asset fetch'); },
  });

  assert.deepStrictEqual(fs.readFileSync(p), engines.find((e) => e.name === 'gamma-ppc').body);
  assert.strictEqual(asked.length, 1, 'exactly one range request');
  assert.strictEqual(asked[0].url, 'https://example.invalid/dl/templates-PIN');
  assert.strictEqual(asked[0].offset, slices['gamma-ppc'].offset);
  assert.strictEqual(asked[0].length, slices['gamma-ppc'].length);
  // The whole point: we pulled a slice, not the pack.
  assert.ok(asked[0].length < blob.length,
    'a range fetch that asks for the whole blob has defeated the feature');
});

test('obtainEngine still handles a schema-1 (loose per-engine) manifest unchanged', async () => {
  const body = Buffer.from('LEGACY-ENGINE');
  const dir = tmpdir('schema1');
  const asked = [];
  const p = await obtainEngine(
    { engine: 'tjs-legacy-PIN', sha256: sha(body) },
    {
      cacheDir: path.join(dir, 'cache'), baseUrl: 'base/',
      thisPin: 'PIN', manifestPin: 'PIN', compression: 'gzip', gunzip,
      // no blob => the pre-2026-08 path
      fetch: async (u) => { asked.push(u); return zlib.gzipSync(body); },
    });
  assert.deepStrictEqual(fs.readFileSync(p), body);
  assert.deepStrictEqual(asked, ['base/tjs-legacy-PIN.gz']);
});

test('obtainEngine refuses a blob manifest whose target has no slice', async () => {
  const dir = tmpdir('inconsistent');
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: 'x' }, {
      cacheDir: dir, thisPin: 'P', manifestPin: 'P',
      blob: 'templates-P', // declared...
      fetch: async () => Buffer.alloc(0),
    }),
    (e) => e instanceof TemplatesError && /no `?offset\/length/.test(e.message));
});

test('a corrupt slice fails the sha gate rather than fusing wrong bytes', async () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  const m = fixtureManifest(engines, slices);
  const dir = tmpdir('corrupt');
  // Hand back the WRONG (but perfectly valid) member — the exact failure a
  // silently-off offset would produce.
  const wrong = slices['alpha-amd64'];
  await assert.rejects(
    () => obtainEngine(m.targets['beta-arm64'], {
      cacheDir: path.join(dir, 'cache'), baseUrl: 'u/',
      thisPin: 'PIN', manifestPin: 'PIN', compression: 'gzip', gunzip, blob: m.blob,
      fetchRange: async () => blob.subarray(wrong.offset, wrong.offset + wrong.length),
    }),
    (e) => e instanceof TemplatesError && /sha256/.test(e.message),
    'a wrong-but-valid slice must be caught by the decompressed sha, not fused');
});

// --- clode-net range primitives -------------------------------------------

test('fetchRange: file:// URLs seek+read the same slice', async () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  const dir = tmpdir('fileurl');
  const p = path.join(dir, 'blob');
  fs.writeFileSync(p, blob);
  const s = slices['beta-arm64'];
  const got = await net.fetchRange(`file://${p}`, s.offset, s.length);
  assert.deepStrictEqual(zlib.gunzipSync(got),
    engines.find((e) => e.name === 'beta-arm64').body);
});

test('fetchRange: a server that ignores Range (200) is sliced locally, not trusted', async () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  const s = slices['gamma-ppc'];

  const realFetch = global.fetch;
  let fellBack = false;
  global.fetch = async () => ({
    status: 200,
    arrayBuffer: async () => blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.length),
  });
  try {
    const got = await net.fetchRange('https://mirror.invalid/blob', s.offset, s.length,
      { onFallback: () => { fellBack = true; } });
    assert.ok(fellBack, 'the 200 fallback should announce itself');
    assert.strictEqual(got.length, s.length);
    assert.deepStrictEqual(zlib.gunzipSync(got),
      engines.find((e) => e.name === 'gamma-ppc').body);
  } finally { global.fetch = realFetch; }
});

test('fetchRange: a 206 of the wrong length is an error, not a short engine', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    status: 206,
    arrayBuffer: async () => new Uint8Array(5).buffer,
  });
  try {
    await assert.rejects(() => net.fetchRange('https://x.invalid/b', 0, 100),
      /returned 5 bytes, expected 100/);
  } finally { global.fetch = realFetch; }
});

test('readRange: reads the slice, and a short read is an error', () => {
  const engines = fixtureEngines();
  const { blob, slices } = packFixture(engines);
  const dir = tmpdir('readrange');
  const p = path.join(dir, 'blob');
  fs.writeFileSync(p, blob);
  const s = slices['alpha-amd64'];
  assert.deepStrictEqual(zlib.gunzipSync(net.readRange(p, s.offset, s.length)),
    engines.find((e) => e.name === 'alpha-amd64').body);
  assert.throws(() => net.readRange(p, blob.length - 2, 50), /short read/);
});
