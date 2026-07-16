'use strict';
// The full-binary oracle: build a REAL naude and a REAL quaude from the SAME
// Claude Code, run both against the same offline mock, and diff.
//
// node-shim-roundtrip-oracle.test.cjs diffs the runtime MODELS (cli.cjs under
// node vs under tjs+shim). This diffs the PACKAGED TARGETS — a Node SEA with the
// CC baked in, and a fused tjs binary with cli.qbc baked in. It is what proves
// the models keep telling the truth about the things users actually build: the
// packaging (asset materialization, the trailer, run-as-node, bytecode compile)
// gets its own vote.
//
// Expensive (two real builds, ~2-4 min), so it is opt-in:
//   CLODE_ORACLE_BINARIES=1 node --test test/oracle-binaries.test.cjs
// and additionally needs Node >= 24 (SEA) + a tjs (fuse) + a Bun-packaged CC
// provider. Missing any of those, it SKIPs — never a false green.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tjsPath } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { REPO, stageProviderCli, runBinaryAsync } = require('./oracle-models.cjs');
const { seaBin } = require('../scripts/platform-tag.cjs');

const BUILD_TIMEOUT = 15 * 60 * 1000;
const RUN_TIMEOUT = 120000;

function why() {
  if (process.env.CLODE_ORACLE_BINARIES !== '1') return 'opt-in: set CLODE_ORACLE_BINARIES=1 (two real builds, minutes)';
  if (parseInt(process.versions.node.split('.')[0], 10) < 24) return 'needs Node >= 24 to build a naude SEA';
  if (!tjsPath()) return 'no tjs binary (CLODE_TJS or build/tjs/tjs) to fuse a quaude';
  return null;
}

function buildNaude(cli) {
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-naude.mjs'), '--cli', cli],
    { stdio: 'pipe', timeout: BUILD_TIMEOUT, cwd: REPO });
  return seaBin(REPO, 'naude');
}

function buildQuaude(outDir) {
  const out = path.join(outDir, 'quaude');
  execFileSync(path.join(REPO, 'bin', 'clode'), ['build', '--out', out],
    { stdio: 'pipe', timeout: BUILD_TIMEOUT, cwd: REPO });
  return out;
}

test('naude and quaude binaries agree on the same baked Claude Code', async (t) => {
  const skip = why();
  if (skip) { t.skip(skip); return; }
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)'); return; }

  // Both targets bake the SAME cli.cjs: naude from the staged copy, quaude via
  // clode's own extract of the same resolved provider. Engine is the only variable.
  const naude = buildNaude(staged.cli);
  assert.ok(fs.existsSync(naude), `naude was not emitted at ${naude}`);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-bin-'));
  const quaude = buildQuaude(outDir);
  assert.ok(fs.existsSync(quaude), `quaude was not emitted at ${quaude}`);

  // Cheap axis first: --version is deterministic and needs no network. A binary
  // that cannot even self-report has nothing to say about parity.
  const [nv, qv] = [
    await runBinaryAsync(naude, ['--version'], { timeout: RUN_TIMEOUT }),
    await runBinaryAsync(quaude, ['--version'], { timeout: RUN_TIMEOUT }),
  ];
  assert.strictEqual(nv.status, 0, `naude --version failed:\n${nv.stderr}`);
  assert.strictEqual(qv.status, 0, `quaude --version failed:\n${qv.stderr}`);
  assert.strictEqual(qv.stdout.trim(), nv.stdout.trim(), 'the two targets report different Claude Code versions — they did not bake the same CC');

  // The real axis: a full -p round-trip through the canned mock. One mock per
  // side (same answers, independent logs); both must print PONG and agree.
  const runAt = async (bin, extraEnv) => {
    const mock = await startMockAnthropic();
    try {
      const r = await runBinaryAsync(bin, ['-p', 'say PONG'], {
        cwd: outDir,
        timeout: RUN_TIMEOUT,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: mock.url,
          ANTHROPIC_API_KEY: 'sk-ant-mock',        // dummy; the mock ignores it. NOT a secret.
          ...extraEnv,
        },
      });
      return { r, posted: mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])) };
    } finally {
      await mock.close();
    }
  };

  const n = await runAt(naude, {});
  const q = await runAt(quaude, { CLODE_SHIM_TRACE: '1' });

  assert.strictEqual(n.r.status, 0, `naude -p failed:\n${n.r.stderr}`);
  assert.match(n.r.stdout, /PONG/, `naude stdout:\n${n.r.stdout}`);
  assert.ok(n.posted, 'naude never POSTed the messages endpoint');

  assert.strictEqual(q.r.status, 0, `quaude -p failed:\n${q.r.stderr}`);
  assert.match(q.r.stdout, /PONG/, `quaude stdout:\n${q.r.stdout}`);
  assert.ok(q.posted, 'quaude never POSTed the messages endpoint');

  assert.strictEqual(q.r.status, n.r.status, 'exit divergence between the packaged targets');
  assert.strictEqual(q.r.stdout.trim(), n.r.stdout.trim(),
    `stdout divergence between the packaged targets:\n--- naude ---\n${n.r.stdout}\n--- quaude ---\n${q.r.stdout}`);

  const walls = [...new Set(q.r.stderr.split('\n').filter((l) => l.includes('[wall]'))
    .map((l) => l.replace(/^.*\[wall\]\s*/, '').trim()).filter(Boolean))];
  assert.deepStrictEqual(walls, [], `the fused quaude hit shim walls: ${walls.join(', ')}`);
});
