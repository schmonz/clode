'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  rcodesignAsset, rcodesignBinPath, ensureRcodesign, RCODESIGN_VERSION,
} = require('../libexec/clode-rcodesign.cjs');

test('rcodesignAsset: a supported host resolves to a pinned release asset', () => {
  const a = rcodesignAsset('linux', 'x64');
  assert.match(a.url, /github\.com\/indygreg\/apple-platform-rs\/releases/);
  assert.ok(/^[0-9a-f]{64}$/.test(a.sha256));
  assert.ok(a.filename.length > 0);
});

test('rcodesignAsset: an unsupported host fails loud', () => {
  assert.throws(() => rcodesignAsset('sunos', 'x64'), /rcodesign.*not.*(supported|pinned)/i);
});

test('rcodesignBinPath is per-(version,platform,arch)', () => {
  const env = { CLODE_DEPS: '/data' };
  const a = rcodesignBinPath(env, 'linux', 'x64');
  const b = rcodesignBinPath(env, 'linux', 'arm64');
  assert.notStrictEqual(a, b);
  assert.ok(a.endsWith(path.join(RCODESIGN_VERSION, 'linux-x64', 'rcodesign')), a);
});

test('ensureRcodesign fetches + sha-verifies + caches; a mismatch fails loud + cleans up', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  const env = { CLODE_DEPS: data };
  const good = rcodesignAsset('linux', 'x64').sha256;
  let dl = 0;
  const p = await ensureRcodesign({
    env, platform: 'linux', arch: 'x64',
    download: async (_url, dst) => { dl++; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, 'ARCHIVE'); },
    verify: async () => good,
    extract: async (_arc, into) => { fs.mkdirSync(into, { recursive: true }); fs.writeFileSync(path.join(into, 'rcodesign'), 'RCBIN'); },
  });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'RCBIN');
  assert.strictEqual(dl, 1);
  // cached: a second call does not re-download
  await ensureRcodesign({ env, platform: 'linux', arch: 'x64', download: async () => { dl++; }, verify: async () => good, extract: async () => {} });
  assert.strictEqual(dl, 1, 'cached hit must not re-download');
  // mismatch fails loud + leaves no poisoned entry
  const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs2-'));
  await assert.rejects(() => ensureRcodesign({
    env: { CLODE_DEPS: data2 }, platform: 'linux', arch: 'x64',
    download: async (_u, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, 'X'); },
    verify: async () => 'deadbeef'.repeat(8), extract: async () => {},
  }), /sha|mismatch/i);
  assert.ok(!fs.existsSync(rcodesignBinPath({ CLODE_DEPS: data2 }, 'linux', 'x64')), 'no poisoned store entry');
});
