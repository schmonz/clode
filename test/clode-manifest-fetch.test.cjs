'use strict';
// The pack auto-fetch: with no CLODE_TEMPLATES_MANIFEST, clode derives its own
// release URL from (version, tjs pin) and downloads templates-<pin>.json + engines
// — so `clode build --target X` Just Works with zero env vars. Local-manifest and
// explicit-base overrides stay for offline use + tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fuse = require('../libexec/clode-fuse.cjs');

const REPO = path.resolve(__dirname, '..');
const LIBEXEC = path.join(REPO, 'libexec');

test('releaseBaseUrl: <CLODE_RELEASE_BASE>/v<version>/ by default, overrides honored', () => {
  assert.strictEqual(fuse.releaseBaseUrl({}, { version: '1.2.3' }),
    'https://github.com/schmonz/clode/releases/download/v1.2.3/');
  assert.strictEqual(fuse.releaseBaseUrl({}, { version: 'v1.2.3' }),  // v-prefix not doubled
    'https://github.com/schmonz/clode/releases/download/v1.2.3/');
  assert.strictEqual(fuse.releaseBaseUrl({ CLODE_RELEASE_BASE: 'https://mirror/dl' }, { version: '9' }),
    'https://mirror/dl/v9/');
  assert.strictEqual(fuse.releaseBaseUrl({ CLODE_TEMPLATES_BASEURL: 'file:///packs/x' }, { version: '1' }),
    'file:///packs/x/');                                              // explicit base wins, slash added
  assert.strictEqual(fuse.releaseBaseUrl({}, {}), null);              // no version -> null
});

test('resolveManifest: a local CLODE_TEMPLATES_MANIFEST wins (offline)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  const mf = path.join(d, 'm.json');
  fs.writeFileSync(mf, JSON.stringify({ schema: 1, tjsPin: 'p', targets: { x: { tag: 't', engine: 'e', sha256: 'a'.repeat(64), verified: 'smoke' } } }));
  const { manifest, baseUrl } = await fuse.resolveManifest({
    env: { CLODE_TEMPLATES_MANIFEST: mf, CLODE_TEMPLATES_BASEURL: 'file:///e/' }, version: '1', libexec: LIBEXEC,
  });
  assert.strictEqual(manifest.tjsPin, 'p');
  assert.strictEqual(baseUrl, 'file:///e/');   // engines come from the explicit base
});

test('resolveManifest: auto-fetches templates-<pin>.json from THIS version release', async () => {
  let requested = null;
  const manifestJson = JSON.stringify({ schema: 1, tjsPin: 'v26.6.0-1a230d3', targets: {} });
  const { manifest, baseUrl } = await fuse.resolveManifest({
    env: { CLODE_TJS_PIN: 'v26.6.0-1a230d3' }, version: '2.0.0', libexec: LIBEXEC,
    fetchManifest: async (url) => { requested = url; return manifestJson; },
  });
  assert.strictEqual(requested,
    'https://github.com/schmonz/clode/releases/download/v2.0.0/templates-v26.6.0-1a230d3.json');
  assert.strictEqual(baseUrl, 'https://github.com/schmonz/clode/releases/download/v2.0.0/');
  assert.strictEqual(manifest.tjsPin, 'v26.6.0-1a230d3');
});

test('resolveManifest: no local manifest and no derivable pin fails loud', async () => {
  await assert.rejects(
    () => fuse.resolveManifest({ env: {}, version: '1', libexec: '/nonexistent' }),
    (e) => /tjs pin/.test(e.message) && /CLODE_TJS_PIN|CLODE_TEMPLATES_MANIFEST/.test(e.message));
});

test('resolveManifest: pin present but no version fails loud (cannot derive URL)', async () => {
  await assert.rejects(
    () => fuse.resolveManifest({ env: { CLODE_TJS_PIN: 'p' }, version: '', libexec: LIBEXEC }),
    (e) => /release URL/.test(e.message));
});

function sink() { let s = ''; return { write: (x) => { s += x; return true; }, text: () => s }; }

test('clode build --target: auto-fetches manifest + engine from the release (no env manifest)', async () => {
  const engineBytes = Buffer.from('CI-BUILT-ENGINE');
  const sha = crypto.createHash('sha256').update(engineBytes).digest('hex');
  const pin = 'v26.6.0-1a230d3';
  const manifestJson = JSON.stringify({
    schema: 1, tjsPin: pin,
    targets: { 'linux-x64': { tag: 'linux-x86_64', engine: `tjs-linux-x64-${pin}`, sha256: sha, verified: 'smoke' } },
  });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'af-'));
  let manifestUrl = null, engineUrl = null;
  await fuse.clodeBuild(['--target', 'linux-x64', '--out', path.join(d, 'q')], {
    // CLODE_STATE_ROOT: this build fails downstream (no provider) but still
    // reaches clodeBuild's finally, which appends one build-trace.jsonl line
    // per build (Task 5) to a path resolved off HOME/XDG when nothing
    // overrides it — without this, the real ~/.local/share/clode.
    env: { CLODE_TJS_PIN: pin, CLODE_STATE_ROOT: d },   // no CLODE_TEMPLATES_MANIFEST — must auto-fetch
    here: REPO, libexec: LIBEXEC, version: '3.1.4', stdout: sink(), stderr: sink(),
    templateCacheDir: path.join(d, 'cache'),
    fetchManifest: async (u) => { manifestUrl = u; return manifestJson; },
    fetchEngine: async (u) => { engineUrl = u; return engineBytes; },
  });
  assert.strictEqual(manifestUrl,
    `https://github.com/schmonz/clode/releases/download/v3.1.4/templates-${pin}.json`);
  assert.strictEqual(engineUrl,
    `https://github.com/schmonz/clode/releases/download/v3.1.4/tjs-linux-x64-${pin}`);
  // The engine was obtained + set as the cross-fuse template (build fails later:
  // no provider in this env — but the fetch path is what we're proving).
  const cached = path.join(d, 'cache', `tjs-linux-x64-${pin}`);
  assert.ok(fs.existsSync(cached), 'engine fetched from the release + cached');
  assert.strictEqual(fs.readFileSync(cached).toString(), 'CI-BUILT-ENGINE');
});
