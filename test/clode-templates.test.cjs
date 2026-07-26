'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseManifest, listTargets, resolveTarget, TemplatesError } = require('../libexec/clode-templates.cjs');

const FIX = JSON.stringify({
  schema: 1,
  tjsPin: 'v26.6.0-1a230d3',
  targets: {
    'linux-x64':    { tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-deadbeef',    sha256: 'a'.repeat(64), verified: 'smoke' },
    'netbsd-sparc': { tag: 'netbsd-10.1-sparc',    engine: 'tjs-netbsd-sparc-cafef00d', sha256: 'b'.repeat(64), verified: 'attest-only' },
  },
});

test('parseManifest returns schema/pin/targets', () => {
  const m = parseManifest(FIX);
  assert.strictEqual(m.tjsPin, 'v26.6.0-1a230d3');
  assert.strictEqual(Object.keys(m.targets).length, 2);
});

test('parseManifest throws TemplatesError on bad JSON / missing targets', () => {
  assert.throws(() => parseManifest('{not json'), (e) => e instanceof TemplatesError);
  assert.throws(() => parseManifest('{"schema":1}'), (e) => e instanceof TemplatesError && /targets/.test(e.message));
});

test('listTargets is sorted with name/tag/verified', () => {
  const l = listTargets(parseManifest(FIX));
  assert.deepStrictEqual(l.map((t) => t.name), ['linux-x64', 'netbsd-sparc']);
  assert.strictEqual(l[0].verified, 'smoke');
});

test('resolveTarget returns the entry or null', () => {
  const m = parseManifest(FIX);
  assert.strictEqual(resolveTarget(m, 'linux-x64').engine, 'tjs-linux-x64-deadbeef');
  assert.strictEqual(resolveTarget(m, 'nope'), null);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { obtainEngine } = require('../libexec/clode-templates.cjs');

test('obtainEngine: pin mismatch is refused', async () => {
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: 'x' }, { cacheDir: os.tmpdir(), thisPin: 'A', manifestPin: 'B', fetch: async () => Buffer.alloc(0) }),
    (e) => e instanceof TemplatesError && /pin/i.test(e.message));
});

test('obtainEngine: fetch, verify sha, cache, chmod; second call cached', async () => {
  const bytes = Buffer.from('ENGINE-BYTES');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  let calls = 0;
  const fetch = async (url) => { calls++; assert.match(url, /base\/tjs-x-abc/); return bytes; };
  const p = await obtainEngine({ engine: 'tjs-x-abc', sha256: sha }, { cacheDir, baseUrl: 'base/', fetch, thisPin: 'P', manifestPin: 'P' });
  assert.strictEqual(fs.readFileSync(p).toString(), 'ENGINE-BYTES');
  // Windows has no POSIX exec bit — chmod(0o755) is a no-op there and mode never
  // carries 0o111. Executability on Windows is by extension, not mode. The fetch/
  // verify/cache behavior below is what matters cross-platform.
  if (process.platform !== 'win32') assert.ok(fs.statSync(p).mode & 0o111, 'executable');
  await obtainEngine({ engine: 'tjs-x-abc', sha256: sha }, { cacheDir, baseUrl: 'base/', fetch, thisPin: 'P', manifestPin: 'P' });
  assert.strictEqual(calls, 1, 'cached second time');
});

test('obtainEngine: sha mismatch is refused', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng2-'));
  await assert.rejects(
    () => obtainEngine({ engine: 'e', sha256: 'f'.repeat(64) }, { cacheDir, baseUrl: 'b/', fetch: async () => Buffer.from('x'), thisPin: 'P', manifestPin: 'P' }),
    (e) => e instanceof TemplatesError && /sha256/.test(e.message));
});
