'use strict';
// Q1b items 3/5/6 end-to-end: `clode build` fuses a real quaude on this machine
// (template tjs + compiled 2.1.204-class bundle), then the artifact is put
// through the acceptance battery:
//   - the build itself smokes PONG + attest internally (exit 0 required);
//   - attest golden: STABLE manifest fields only (schema, versions, shas the
//     test recomputes independently) — never fusedAt;
//   - reserved-namespace mechanics against the real bootstrap (unknown
//     --quaude-foo errors from quaude, exit 64, bundle never runs;
//     --quaude-attest short-circuits even with bundle args present);
//   - the STRICT-MODE sweep the design memo requires (§6.3): the agentic Bash
//     mock oracle from test/node-shim-agentic.test.cjs, pointed at the fused
//     binary — the bundle runs as compiled-module bytecode (strict), so this
//     is the tool-use path's strictness gate;
//   - TUI paint smoke, additionally gated on CLODE_LIVE_RENDER=1 (Keychain).
// Gates: tjs template + CLODE_PROVIDER_BIN (like the other bundle-spawning
// suites). Hermetic: CLODE_CACHE points into the fixture tmp dir; the repo's
// own node_modules feeds the dep members (ensureDeps early-returns).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tjsPath, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { cacheKey } = require('../libexec/clode-resolve.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').replace(/\n+$/, '');
function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

let SKIP = null, DIR = null, QUAUDE = null, BUILD = null;
before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  if (!providerBin()) { SKIP = 'no CLODE_PROVIDER_BIN'; return; }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quaude-build-'));
  QUAUDE = path.join(DIR, 'quaude');
  BUILD = spawnSync(process.execPath, [ENTRY, 'build', '--out', QUAUDE], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_CLAUDE_BIN: providerBin(),
      CLODE_CACHE: path.join(DIR, 'cache'),   // hermetic: never the real cache
      CLODE_TJS: tjsPath(),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

// Async spawn of the fused binary (the agentic oracle needs the in-process mock
// to stay serviceable — spawnSync would starve it).
function runQuaude(args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(QUAUDE, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}
// The fused binary must be self-contained: no NODE_PATH ever.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_PATH;
  return env;
}

test('clode build fuses a quaude and its internal PONG + attest smokes pass', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.strictEqual(BUILD.status, 0, `clode build failed:\n${BUILD.stdout}\n${BUILD.stderr}`);
  assert.match(BUILD.stdout, /clode: fused /);
  assert.match(BUILD.stdout, /PONG round-trip ok, attest ok/);
  assert.ok(fs.statSync(QUAUDE).size > 30 * 1024 * 1024, 'fused binary implausibly small');
  assert.ok(fs.statSync(QUAUDE).mode & 0o111, 'fused binary not executable');
});

test('attest golden: stable manifest fields + full member verification', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const r = await runQuaude(['--quaude-attest'], cleanEnv());
  assert.strictEqual(r.status, 0, r.stderr);
  // Output = manifest JSON verbatim, then one ok/FAIL line per member, then the summary.
  const lines = r.stdout.split('\n');
  const firstMemberLine = lines.findIndex((l) => /^(ok {2}|FAIL) /.test(l));
  assert.ok(firstMemberLine > 0, 'no member verification lines');
  const manifest = JSON.parse(lines.slice(0, firstMemberLine).join('\n'));

  // GOLDEN (stable fields only — fusedAt deliberately unchecked beyond shape):
  assert.deepStrictEqual(Object.keys(manifest).sort(), [
    'bundleVersion', 'clodeVersion', 'engine', 'fusedAt', 'hooks', 'idna',
    'members', 'quaude', 'template',
  ]);
  assert.strictEqual(manifest.quaude, '1');
  assert.strictEqual(manifest.bundleVersion, cacheKey(providerBin()));
  assert.strictEqual(manifest.clodeVersion, VERSION);
  assert.ok(manifest.engine.quickjs && manifest.engine.tjs, 'engine pins missing');
  assert.ok(['uts46', 'l1'].includes(manifest.idna), `underived idna: ${manifest.idna}`);
  assert.strictEqual(manifest.template.sha256, sha256File(tjsPath()));
  assert.strictEqual(manifest.hooks['extract-claude-js.cjs'],
    sha256File(path.join(REPO, 'libexec/extract-claude-js.cjs')));
  assert.ok(!Number.isNaN(Date.parse(manifest.fusedAt)), 'fusedAt not ISO-parseable');
  for (const m of ['cli.qbc', 'bun-shim.cjs', 'node-shim/loader.cjs', 'node-shim/modules/process.cjs']) {
    assert.ok(manifest.members[m], `manifest missing member ${m}`);
  }
  // The shipped loader member must be byte-identical to the committed loader.
  assert.strictEqual(manifest.members['node-shim/loader.cjs'].sha256,
    sha256File(path.join(REPO, 'libexec/node-shim/loader.cjs')));

  // Verification: every member line ok, summary present, count matches
  // manifest members + manifest.json itself.
  const memberLines = lines.filter((l) => /^(ok {2}|FAIL) /.test(l));
  assert.strictEqual(memberLines.filter((l) => l.startsWith('FAIL')).length, 0);
  assert.strictEqual(memberLines.length, Object.keys(manifest.members).length + 1);
  assert.strictEqual(lines.filter(Boolean).pop(), 'quaude-attest: all members verified');
});

test('reserved namespace: unknown --quaude-foo errors from quaude, bundle never runs', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const r = await runQuaude(['--quaude-frobnicate', '-p', 'say PONG'], cleanEnv());
  assert.strictEqual(r.status, 64);
  assert.match(r.stderr, /quaude: unknown option '--quaude-frobnicate'/);
  assert.match(r.stderr, /reserved/);
  assert.strictEqual(r.stdout, '');   // nothing from the bundle
});

test('reserved namespace: --quaude-attest short-circuits before the bundle sees argv', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // With bundle args alongside, attest still wins and no session starts (no
  // mock is listening — a bundle boot would fail loudly or hang, not attest).
  const r = await runQuaude(['-p', 'say PONG', '--quaude-attest'], cleanEnv(), 60000);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /quaude-attest: all members verified/);
  assert.doesNotMatch(r.stdout, /PONG/);
});

test('strict-mode sweep: agentic Bash mock oracle against the fused quaude', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const MARKER = 'QUAUDE-AGENTIC-MARKER-4207';
  const TOOL_ID = 'toolu_mock_quaude_bash_1';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(TOOL_ID)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE('Bash', { command: `echo ${MARKER}` }, TOOL_ID),
  });
  try {
    const r = await runQuaude(
      ['-p', 'run the command', '--allowedTools', 'Bash'],
      cleanEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' }));
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /TOOLDONE/, `stdout:\n${r.stdout}`);
    const followUp = mock.requests.find((q) => q.method === 'POST' && q.body
      && q.body.includes(TOOL_ID) && q.body.includes('tool_result'));
    assert.ok(followUp, 'no follow-up POST carrying the tool_result');
    assert.ok(followUp.body.includes(MARKER), `tool_result lacks the command's stdout:\n${followUp.body.slice(0, 2000)}`);
    assert.ok(!followUp.body.includes('bash output unavailable'), 'tool_result degraded to the output-file readback failure');
    assert.ok(!followUp.body.includes('Output too large'), 'tool_result degraded to the persisted-file detour');
  } finally { await mock.close(); }
});

test('TUI paint smoke under the fused quaude (CLODE_LIVE_RENDER-gated)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (process.env.CLODE_LIVE_RENDER !== '1') { t.skip('live-render opt-in only (set CLODE_LIVE_RENDER=1)'); return; }
  const { sandbox } = require('./e2e.cjs');
  const { seedClaudeProfile, capture } = require('./e2e-pty.cjs');
  const sbx = sandbox(t);
  seedClaudeProfile(sbx.home, { cwd: REPO });
  const screen = capture(sbx, { seconds: 12, cmd: [QUAUDE] });
  assert.match(screen, /Claude Code/);
});
