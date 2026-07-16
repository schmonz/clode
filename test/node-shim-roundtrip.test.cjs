'use strict';
// The quaude-model round-trips: (1) the OFFLINE mock — cli.cjs -p 'say PONG'
// boots under tjs + the node-shim against the local mock, prints PONG, exit 0
// (hermetic; gated on tjs + a provider). (2) the LIVE finale — real
// api.anthropic.com, gated on CLODE_LIVE_ROUNDTRIP=1 + a real ANTHROPIC_API_KEY;
// never captures the key.
//
// Parity against the naude reference is node-shim-roundtrip-oracle.test.cjs;
// this file is quaude-only liveness. Both share test/oracle-models.cjs, whose
// async dispatch is REQUIRED here: the mock server lives in this process, and a
// spawnSync'd child would deadlock against its own answer.
const test = require('node:test');
const assert = require('node:assert');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { stageProviderCli, runQuaudeModelAsync } = require('./oracle-models.cjs');

function stage(t) {
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)'); return null; }
  return staged;
}

test('mock round-trip under tjs: -p prints PONG, exit 0', async (t) => {
  if (skipUnlessTjs(t)) return;
  const staged = stage(t);
  if (!staged) return;
  const mock = await startMockAnthropic();
  try {
    const r = await runQuaudeModelAsync(staged.cli, ['-p', 'say PONG'], {
      cwd: staged.dir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',              // dummy; NOT a secret
      },
      timeout: 90000,
    });
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout:\n${r.stdout}`);
    assert.ok(mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])), 'no messages POST recorded');
  } finally { await mock.close(); }
});

// The LIVE finale. SKIPs unless explicitly opted in AND a key is present. The
// key is read from the environment at run time and NEVER read into a variable
// that is logged, asserted on, or written anywhere.
test('LIVE finale: -p against api.anthropic.com (opt-in)', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (process.env.CLODE_LIVE_ROUNDTRIP !== '1') { t.skip('set CLODE_LIVE_ROUNDTRIP=1 to run the live finale'); return; }
  if (!process.env.ANTHROPIC_API_KEY) { t.skip('no ANTHROPIC_API_KEY in env'); return; }
  const staged = stage(t);
  if (!staged) return;
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;                        // real endpoint
  const r = await runQuaudeModelAsync(staged.cli, ['-p', 'say PONG'], {
    cwd: staged.dir, env, timeout: 120000,
  });
  assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stdout, /PONG/i, `stdout:\n${r.stdout}`);
  // Timing only — no key, no headers echoed.
  console.log(`LIVE round-trip: exit 0, ${r.ms}ms, stdout bytes=${Buffer.byteLength(r.stdout)}`);
});
