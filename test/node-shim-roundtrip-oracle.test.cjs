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

// HERMETICITY (2026-08-06): this used to inherit the operator's real HOME, so
// both models read the real ~/.claude — including ~/.claude/.credentials.json.
// The mere PRESENCE of that file was open bug #1, so this "hermetic mock" oracle
// failed on any box where the operator was logged in, for a reason unrelated to
// the mock. Worse for a DIFFERENTIAL: naude and quaude read the same real HOME
// and can disagree about it, so the diff under test stops being just the engine.
// One fresh HOME per model run.
const fsx = require('node:fs');
const osx = require('node:os');
const pathx = require('node:path');
function freshHome() {
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'oracle-home-'));
  fsx.mkdirSync(pathx.join(home, '.claude'), { recursive: true });
  return home;
}
// KEYCHAIN HERMETICITY: the naude-model side runs cli.cjs under REAL node with NO
// shim in the loop, so CLODE_KC_MODE (which only gates node-shim's `_kcMaybe`) has
// NO effect on it whatsoever — proved live (see task-10-report.md): with
// ANTHROPIC_API_KEY already set, naude-model still called the REAL `security
// find-generic-password -a <user> -w -s "Claude Code"/"Claude Code-credentials"`
// against the operator's real login Keychain. That is very likely the "more
// [dialogs], naming the operator's own account" half of the original bug report
// (the OTHER half, `__clode_kc_probe__`, is quaude-model's `_kcDetect()`, gated by
// CLODE_KC_MODE in test/run.mjs).
//
// Fix: prepend a directory holding a STUB `security` executable to PATH — it
// shadows the real /usr/bin/security (PATH search finds it first) while leaving
// the REST of the real PATH intact, so every other PATH-resolved tool the bundle
// wants (rg/bfs/ugrep/git/sh) still resolves exactly as before. An EARLIER version
// of this fix prepended an EMPTY decoy dir instead: that does NOT shadow anything
// — an empty directory has no `security` entry to match, so PATH search just skips
// past it to the real one further down the chain. (KC_FORCE_EMULATE_ENV in
// node-shim-child-process.test.cjs gets away with a truly empty decoy only because
// it REPLACES PATH outright for a tiny synthetic fixture that needs nothing else
// on PATH; doing that here for a full bundle -p run lost rg/bfs/ugrep resolution
// and printed unrelated "clode: rg needs 'ugrep'" noise instead.) The stub mimics
// real security's actual "item not found" reply (exit 44, the same stderr text
// child_process.cjs's KC_NOT_FOUND_STDERR documents) for find-generic-password,
// which is the only subcommand naude-model was observed to call. `security` is
// darwin-only, so this only needs setting up on darwin.
const kcStubDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'oracle-kc-stub-'));
if (process.platform === 'darwin') {
  const stubBody = '#!/bin/sh\n'
    + 'case "$1" in\n'
    + '  find-generic-password) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." 1>&2; exit 44 ;;\n'
    + '  *) exit 1 ;;\n'
    + 'esac\n';
  const stubPath = pathx.join(kcStubDir, 'security');
  fsx.writeFileSync(stubPath, stubBody);
  fsx.chmodSync(stubPath, 0o755);
}
function mockEnv(mock, home = freshHome()) {
  return {
    ...process.env,
    HOME: home,                              // never the operator's real ~/.claude
    // Shadow `security` (darwin only); a no-op elsewhere since the real one never
    // resolves it on those legs anyway.
    PATH: kcStubDir + pathx.delimiter + (process.env.PATH || ''),
    CLODE_DEPS: pathx.join(home, 'deps'),
    CLODE_CACHE: pathx.join(home, 'cache'),
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
