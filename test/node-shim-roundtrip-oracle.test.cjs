'use strict';
// The parity oracle: ONE staged cli.cjs, run under BOTH build targets' runtimes
// against the same offline mock, diffed.
//
//   naude-model  = cli.cjs under real node   -> the REFERENCE (native built-ins)
//   quaude-model = cli.cjs under tjs + shim  -> the SUBJECT (our node-shim)
//
// This is what `clode build --naude` and `clode build` produce, minus the
// packaging (test/oracle-binaries.test.cjs proves the packaged binaries agree
// with these models). Nothing here touches bin/clode or CLODE_ENGINE: the
// builder-only surface has no runner, and the gate that guards quaude's shim
// must outlive it.
//
// SKIPs unless a Bun-packaged CC provider resolves (CLODE_PROVIDER_BIN,
// CLODE_CLAUDE_BIN, or the provider store); the quaude side also needs a tjs.
const test = require('node:test');
const assert = require('node:assert');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { stageProviderCli, runNaudeModelAsync, runQuaudeModelAsync } = require('./oracle-models.cjs');

const TIMEOUT = 90000;

function mockEnv(mock) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: 'sk-ant-mock',        // dummy; the mock ignores it. NOT a secret.
  };
}

function postedMessages(mock) {
  return mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0]));
}

test('naude-model (node reference): -p prints the mock response, exit 0', async (t) => {
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)'); return; }
  const mock = await startMockAnthropic();
  try {
    const r = await runNaudeModelAsync(staged.cli, ['-p', 'say PONG'], {
      cwd: staged.dir, env: mockEnv(mock), timeout: TIMEOUT,
    });
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout was:\n${r.stdout}`);
    assert.ok(postedMessages(mock),
      `bundle never POSTed the messages endpoint; hit: ${JSON.stringify(mock.requests.map((q) => q.method + ' ' + q.url))}`);
  } finally {
    await mock.close();
  }
});

// The gate proper. The mock is canned, so the two runtimes running the same
// cli.cjs must produce the SAME bytes — any difference is a node-shim defect.
test('quaude-model (tjs + node-shim) matches the naude reference byte for byte', async (t) => {
  if (skipUnlessTjs(t)) return;
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)'); return; }

  const naudeMock = await startMockAnthropic();
  let naude;
  try {
    naude = await runNaudeModelAsync(staged.cli, ['-p', 'say PONG'], {
      cwd: staged.dir, env: mockEnv(naudeMock), timeout: TIMEOUT,
    });
  } finally {
    await naudeMock.close();
  }

  // A fresh mock per side: same canned answers, independent request logs.
  const quaudeMock = await startMockAnthropic();
  let quaude;
  try {
    quaude = await runQuaudeModelAsync(staged.cli, ['-p', 'say PONG'], {
      cwd: staged.dir, env: { ...mockEnv(quaudeMock), CLODE_SHIM_TRACE: '1' }, timeout: TIMEOUT,
    });
  } finally {
    await quaudeMock.close();
  }

  assert.strictEqual(quaude.status, 0, `quaude stderr:\n${quaude.stderr}`);
  assert.match(quaude.stdout, /PONG/, `quaude stdout:\n${quaude.stdout}`);
  assert.ok(postedMessages(quaudeMock), 'quaude never POSTed the messages endpoint');

  assert.strictEqual(quaude.status, naude.status, 'exit divergence: quaude vs the naude reference');
  assert.strictEqual(quaude.stdout.trim(), naude.stdout.trim(),
    `stdout divergence against the naude reference:\n--- naude ---\n${naude.stdout}\n--- quaude ---\n${quaude.stdout}`);

  // Axis 1: any API the shim was asked for and does not have.
  const walls = [...new Set(quaude.stderr.split('\n').filter((l) => l.includes('[wall]'))
    .map((l) => l.replace(/^.*\[wall\]\s*/, '').trim()).filter(Boolean))];
  assert.deepStrictEqual(walls, [], `the shim hit walls this round-trip exercised: ${walls.join(', ')}`);
});
