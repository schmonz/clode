'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveChannel, releasesBase, checkUpdate } =
  require('../libexec/target-update-check.cjs');

// Fake fetch: returns a body for the channel URL, or a network error.
function fakeFetch(bodyOrErr) {
  return async () => {
    if (bodyOrErr instanceof Error) throw bodyOrErr;
    return { ok: true, status: 200, text: async () => bodyOrErr };
  };
}
// Numeric-dotted order, standing in for Bun.semver.order (npm semver compare).
const order = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
  return 0;
};

test('resolveChannel precedence: explicit > env > default latest', () => {
  assert.strictEqual(resolveChannel('stable', {}), 'stable');
  assert.strictEqual(resolveChannel(undefined, { CLODE_UPDATE_CHANNEL: 'beta' }), 'beta');
  assert.strictEqual(resolveChannel(undefined, {}), 'latest');
});

test('releasesBase honors CLODE_RELEASES_URL override', () => {
  assert.strictEqual(releasesBase({}), 'https://downloads.claude.ai/claude-code-releases');
  assert.strictEqual(releasesBase({ CLODE_RELEASES_URL: 'https://x/y' }), 'https://x/y');
});

test('checkUpdate: newer when channel version > current', async () => {
  const r = await checkUpdate({ current: '2.1.218', channel: 'latest',
    fetchImpl: fakeFetch('2.1.220\n'), semverOrder: order });
  assert.deepStrictEqual(r, { state: 'newer', latest: '2.1.220', current: '2.1.218' });
});

test('checkUpdate: current when channel version <= current', async () => {
  const r = await checkUpdate({ current: '2.1.218', channel: 'stable',
    fetchImpl: fakeFetch('2.1.212\n'), semverOrder: order });
  assert.strictEqual(r.state, 'current');
});

test('checkUpdate: numeric channel is the version itself (no fetch)', async () => {
  let called = false;
  const r = await checkUpdate({ current: '2.1.218', channel: '2.1.219',
    fetchImpl: async () => { called = true; throw new Error('should not fetch'); },
    semverOrder: order });
  assert.strictEqual(called, false);
  assert.strictEqual(r.state, 'newer');
  assert.strictEqual(r.latest, '2.1.219');
});

test('checkUpdate: unknown when the fetch throws (offline)', async () => {
  const r = await checkUpdate({ current: '2.1.218', channel: 'latest',
    fetchImpl: fakeFetch(new Error('ENOTFOUND')), semverOrder: order });
  assert.deepStrictEqual(r, { state: 'unknown', latest: null, current: '2.1.218' });
});

test('checkUpdate: unknown when semver comparison throws (garbage body)', async () => {
  const r = await checkUpdate({ current: '2.1.218', channel: 'latest',
    fetchImpl: fakeFetch('not-a-version'),
    semverOrder: () => { throw new Error('Invalid Version'); } });
  assert.strictEqual(r.state, 'unknown');
});

// The check runs inside the diagnostics builder that /status and `claude doctor`
// await, so a stalled channel GET must fail fast to 'unknown' (the "couldn't check"
// note), not block the screen for undici's ~300s default.
test('checkUpdate: a hung fetch aborts on the bounded signal -> unknown, promptly', async () => {
  // fetchImpl never resolves on its own; it only settles when the injected
  // AbortSignal.timeout fires. A tiny timeoutMs keeps the test fast + deterministic
  // (the timing is injected, not slept-through).
  let sawSignal = null;
  const hungFetch = (_url, opts) => new Promise((_resolve, reject) => {
    sawSignal = opts && opts.signal;
    if (sawSignal) sawSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    // otherwise: never resolves
  });
  const started = Date.now();
  const r = await checkUpdate({ current: '2.1.218', channel: 'latest',
    fetchImpl: hungFetch, semverOrder: order, timeoutMs: 20 });
  assert.deepStrictEqual(r, { state: 'unknown', latest: null, current: '2.1.218' });
  assert.ok(sawSignal, 'resolveLatest must pass an { signal } to fetch');
  assert.ok(Date.now() - started < 2000, 'must not block for the real fetch timeout');
});

// The PRELUDE's __clodeCheckUpdate wraps checkUpdate into the bundle's
// {wasUpdated,latestVersion,lockFailed} shape and never reports wasUpdated.
test('__clodeCheckUpdate returns a never-installed, notify-only shape', async () => {
  const { checkUpdate } = require('../libexec/target-update-check.cjs');
  // Simulate the PRELUDE wrapper inline (the PRELUDE string builds this).
  async function clodeCheckUpdate(current, deps) {
    const r = await checkUpdate({ current, ...deps });
    return { wasUpdated: false, latestVersion: r.state === 'newer' ? r.latest : null,
      lockFailed: false, __clodeState: r.state };
  }
  const order = (a, b) => (a === b ? 0 : a > b ? 1 : -1);
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '2.1.220' });
  const r = await clodeCheckUpdate('2.1.218', { channel: 'latest', fetchImpl, semverOrder: order });
  assert.strictEqual(r.wasUpdated, false);
  assert.strictEqual(r.__clodeState, 'newer');
  assert.strictEqual(r.latestVersion, '2.1.220');
});
