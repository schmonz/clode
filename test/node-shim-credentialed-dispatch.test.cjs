'use strict';
// Open bug #1 (fixed 2026-08-06): with ANY `~/.claude/.credentials.json` present,
// `quaude -p` exited 0 with EMPTY stdout and EMPTY stderr and never POSTed
// /v1/messages. No throw, no error, no explicit exit — a promise never settled
// and the loop simply drained.
//
// Root cause was the shim's Readable dropping data pushed before a consumer
// attached (see test/node-shim-stream.test.cjs). The bundle reads the credential
// through execa, whose collector attaches on a later tick.
//
// HERMETIC BY CONSTRUCTION — the property the old roundtrip tests lacked:
//   * a FRESH temp HOME per case, so the operator's real ~/.claude is never read
//     (inheriting it is what made those tests fail on a dev box at all);
//   * CLODE_KC_MODE=emulate pins the headless keychain branch, which is where the
//     bug lives — a GUI desktop probes to 'passthrough' and never reaches it, so
//     an unpinned test silently passes on a laptop and only bites on a real
//     headless box;
//   * every credential fixture is SYNTHETIC. No real token is read or written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { stageProviderCli, runQuaudeModelAsync } = require('./oracle-models.cjs');

// Synthetic only. `expiresAt` is computed forward so the fixture never rots.
const wellFormed = () => JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-NOT-A-REAL-TOKEN',
    refreshToken: 'sk-ant-ort01-NOT-A-REAL-TOKEN',
    expiresAt: Date.now() + 86400000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
});

// Each fixture reproduces the bug WITHOUT any real credential: what mattered was
// that the file EXISTED, not what it held.
const FIXTURES = [
  { name: 'empty file', body: '' },
  { name: 'empty JSON object', body: '{}' },
  { name: 'oauth key present but empty', body: '{"claudeAiOauth":{}}' },
  { name: 'well-formed (synthetic) token', body: wellFormed() },
];

async function dispatch(t, credBody) {
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)'); return null; }
  const mock = await startMockAnthropic();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-dispatch-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    if (credBody !== null) {
      fs.writeFileSync(path.join(home, '.claude/.credentials.json'), credBody, { mode: 0o600 });
    }
    const r = await runQuaudeModelAsync(staged.cli, ['-p', 'say PONG'], {
      cwd: staged.dir,
      env: {
        ...process.env,
        HOME: home,                       // hermetic: never the operator's real HOME
        CLODE_KC_MODE: 'emulate',         // pin the headless branch
        CLODE_DEPS: path.join(home, 'deps'),
        CLODE_CACHE: path.join(home, 'cache'),
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock', // dummy; NOT a secret
      },
      timeout: 120000,
    });
    const posts = mock.requests.filter((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0]));
    return { r, posts, seen: mock.requests.map((q) => `${q.method} ${q.url.split('?')[0]}`) };
  } finally {
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const fx of FIXTURES) {
  test(`credentialed dispatch: a credentials file (${fx.name}) still reaches /v1/messages`, async (t) => {
    if (skipUnlessTjs(t)) return;
    const out = await dispatch(t, fx.body);
    if (!out) return;
    const { r, posts, seen } = out;
    // The signature of the bug: exit 0, both streams empty, only the /api/hello
    // probe recorded. Assert the POSITIVE outcome so a silent regression fails.
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `no model output — bug #1 shape. saw requests: ${JSON.stringify(seen)}`);
    assert.strictEqual(posts.length, 1, `expected exactly one /v1/messages POST, saw: ${JSON.stringify(seen)}`);
  });
}

// The control: no file at all always worked, so it must keep working. Without
// this, a "fix" that ignored credentials entirely would look green.
test('credentialed dispatch: no credentials file still reaches /v1/messages (control)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const out = await dispatch(t, null);
  if (!out) return;
  assert.strictEqual(out.r.status, 0, `stderr:\n${out.r.stderr}`);
  assert.match(out.r.stdout, /PONG/);
  assert.strictEqual(out.posts.length, 1);
});
