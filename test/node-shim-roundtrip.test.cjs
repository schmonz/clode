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
const { freshHome: freshBundleHome } = require('./throwaway-home.cjs');
const assert = require('node:assert');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { stageProviderCli, providerSkipReason, runQuaudeModelAsync } = require('./oracle-models.cjs');
const { runScanned } = require('./debug-log-gate.cjs');
const { refusalRecorder } = require('./option-refusals.cjs');

function stage(t) {
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)');
  if (skip) { t.skip(skip); return null; }
  return staged;
}

// HERMETICITY (2026-08-06): these tests used to inherit the operator's real HOME,
// so they read the real ~/.claude — including ~/.claude/.credentials.json. That
// is not a detail: the mere PRESENCE of that file was open bug #1, so on any box
// where the operator was logged in these "hermetic mock" tests failed for a
// reason that had nothing to do with the mock. A run's result must not depend on
// whether the person running it happens to be logged in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtrip-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

test('mock round-trip under tjs: -p prints PONG, exit 0', async (t) => {
  if (skipUnlessTjs(t)) return;
  const staged = stage(t);
  if (!staged) return;
  const mock = await startMockAnthropic();
  const home = freshHome();
  // the default path takes no refused option (test/option-refusals.cjs): checked BEFORE the stdout, which a swallowed
  // refusal leaves empty
  const refusals = refusalRecorder(home, 'mock -p turn');
  try {
    // quaude's debug log, READ (test/debug-log-gate.cjs): the absolute rules, no reference here
    const r = await runScanned(path.join(staged.dir, `roundtrip-debug-${process.hrtime.bigint()}.log`), (dbg) => runQuaudeModelAsync(staged.cli, ['-p', 'say PONG', ...dbg], {
      cwd: staged.dir,
      env: {
        ...process.env,
        ...refusals.env,
        HOME: home,                                    // never the operator's real ~/.claude
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        CLODE_DEPS: path.join(home, 'deps'),
        CLODE_CACHE: path.join(home, 'cache'),
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',              // dummy; NOT a secret
      },
      timeout: 90000,
    }), { label: 'quaude-model (-p say PONG)' });
    refusals.assertNone();
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout:\n${r.stdout}`);
    assert.ok(mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])), 'no messages POST recorded');
  } finally { await mock.close(); fs.rmSync(home, { recursive: true, force: true }); }
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
  const env = { ...process.env, ...freshBundleHome('roundtrip-live-') };   // the key comes from the env; the home is its own
  delete env.ANTHROPIC_BASE_URL;                        // real endpoint
  const r = await runScanned(path.join(staged.dir, 'roundtrip-live-debug.log'), (dbg) => runQuaudeModelAsync(staged.cli, ['-p', 'say PONG', ...dbg], {
    cwd: staged.dir, env, timeout: 120000,
  }), { label: 'quaude-model LIVE (-p say PONG)' });
  assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stdout, /PONG/i, `stdout:\n${r.stdout}`);
  // Timing only — no key, no headers echoed.
  console.log(`LIVE round-trip: exit 0, ${r.ms}ms, stdout bytes=${Buffer.byteLength(r.stdout)}`);
});
