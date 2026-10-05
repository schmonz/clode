'use strict';
// SANDBOXED BASH FAILS CLOSED under quaude (user ruling 2026-10-05, until real sandbox support lands).
//
// quaude cannot provide Claude Code's sandbox yet: its initialization needs node:net servers the node-shim does not
// have, and fails ("Sandbox is enabled but failed to initialize: not a function"). The 2.1.283 bundle then sets
// sandboxDisabledThisSession, and every LATER Bash call ran UNSANDBOXED (measured 2026-10-05, a quaude built from
// d93cbd1 on macOS: call 1 refused, calls 2 and 3 wrote outside the working directory, where native's sandbox
// refused them). quaude now hands the bundle sandbox.failIfUnavailable (libexec/quaude-bootstrap.mjs states the
// divergence), so with the sandbox enabled the bundle takes its own sandbox-REQUIRED branch: every Bash call refused,
// nothing written.
//
// A BUILT quaude (test/built-binary.cjs), one -p turn per settings source, three Bash calls each writing a marker
// inside the working directory and one outside it; a throwaway HOME, CLAUDE_CONFIG_DIR and TJS_HOME per run. With
// the sandbox on (user, project or local settings): every call is refused with the bundle's required-branch reason
// and no marker exists. With it off: all three run. Measured on macOS; on Linux with bubblewrap and socat present the
// same, and with them absent the bundle refuses at STARTUP (its own "sandbox required but unavailable"): nothing
// runs either way, which this test accepts on Linux only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { builtQuaude } = require('../built-binary.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');
const { toolResult, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

const REQUIRED = /^Sandbox is required but failed to initialize\b/;
const STARTUP_REFUSAL = /sandbox required but unavailable/;
const marker = (n) => `fc-marker-${n}`;
const M1 = { name: 'Bash', input: { command: `echo in > ${marker(1)}; echo x > ../out-1; echo FC-RAN-$((40+1))`, description: 'one' }, id: 'toolu_fc_1' };
const M2 = { name: 'Bash', input: { command: `echo in > ${marker(2)}; echo x > ../out-2; echo FC-RAN-$((40+2))`, description: 'two' }, id: 'toolu_fc_2' };
const M3 = { name: 'Bash', input: { command: `echo in > ${marker(3)}; echo x > ../out-3; echo FC-RAN-$((40+3))`, description: 'three' }, id: 'toolu_fc_3' };
function emit(USE) { return () => cannedToolUseSSE(USE.name, USE.input, USE.id); }
const SCRIPT = [[M1, emit(M1)], [M2, emit(M2)], [M3, emit(M3)]];

// The checks: refused by the bundle's required branch (an is_error tool_result saying so), or ran (the computed marker).
const refused1 = (m) => { const r = toolResult(m, M1.id); return !!r && r.isError && REQUIRED.test(r.text); };
const refused2 = (m) => { const r = toolResult(m, M2.id); return !!r && r.isError && REQUIRED.test(r.text); };
const refused3 = (m) => { const r = toolResult(m, M3.id); return !!r && r.isError && REQUIRED.test(r.text); };
const ran1 = (m) => { const r = toolResult(m, M1.id); return !!r && !r.isError && r.text.includes('FC-RAN-41'); };
const ran2 = (m) => { const r = toolResult(m, M2.id); return !!r && !r.isError && r.text.includes('FC-RAN-42'); };
const ran3 = (m) => { const r = toolResult(m, M3.id); return !!r && !r.isError && r.text.includes('FC-RAN-43'); };
const verdicts = (m) => ({ refused: [refused1(m), refused2(m), refused3(m)], ran: [ran1(m), ran2(m), ran3(m)] });

function turn(bin, cwd, env) {
  return new Promise((resolve) => {
    const c = spawn(bin, ['-p', 'write the markers', '--allowedTools', 'Bash'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    c.stdout.on('data', () => {});
    c.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => c.kill('SIGKILL'), 180000);
    c.on('exit', (status) => { clearTimeout(to); resolve({ status, stderr }); });
    c.on('error', (e) => { clearTimeout(to); resolve({ status: null, stderr: String(e) }); });
  });
}

// One turn with `source` holding {"sandbox":{"enabled":true}} (or nothing, 'off'). -> { verdict, markers, r }
async function runWith(bin, source) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-fail-closed-')));
  try {
    const work = path.join(base, 'work'), home = path.join(base, 'home'), cfg = path.join(home, '.claude'), tjsHome = path.join(base, 'tjs-home');
    for (const d of [path.join(work, '.claude'), cfg, tjsHome]) fs.mkdirSync(d, { recursive: true });
    const ON = JSON.stringify({ sandbox: { enabled: true } });
    if (source === 'user') fs.writeFileSync(path.join(cfg, 'settings.json'), ON);
    if (source === 'project') fs.writeFileSync(path.join(work, '.claude', 'settings.json'), ON);
    if (source === 'local') fs.writeFileSync(path.join(work, '.claude', 'settings.local.json'), ON);
    const mock = await startMockAnthropic({
      respond: (body) => { const next = SCRIPT.find(([u]) => !body.includes(u.id)); return next ? next[1]() : cannedSSE('FC-DONE'); },
    });
    try {
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
      Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, TJS_HOME: tjsHome, SHELL: '/bin/bash',
        ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' });
      const r = await turn(bin, work, env);
      const markers = [1, 2, 3].flatMap((n) => [[marker(n), work], [`out-${n}`, base]].filter(([f, d]) => fs.existsSync(path.join(d, f))).map(([f]) => f));
      return { verdict: verdicts(mock), markers, r };
    } finally { await mock.close(); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

const SKIP = process.platform === 'win32' ? 'the Bash tool needs bash; Windows sandboxing is not this gap' : false;
test('sandboxed Bash fails CLOSED under quaude: every call refused, nothing written, from any settings source; off, all run', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  assertFailsOnMissingOutput(refused1, M1); assertFailsOnMissingOutput(refused2, M2); assertFailsOnMissingOutput(refused3, M3);
  assertFailsOnMissingOutput(ran1, M1); assertFailsOnMissingOutput(ran2, M2); assertFailsOnMissingOutput(ran3, M3);
  const findings = [];
  for (const source of ['user', 'project', 'local']) {
    const { verdict, markers, r } = await runWith(q.path, source);
    const startupRefused = process.platform === 'linux' && r.status !== 0 && STARTUP_REFUSAL.test(r.stderr);
    if (markers.length) findings.push(`${source}: wrote ${markers.join(', ')} (ran unsandboxed)`);
    if (!startupRefused && !verdict.refused.every(Boolean)) findings.push(`${source}: not every call was refused by the required branch: ${JSON.stringify(verdict)} rc ${r.status} ${r.stderr.slice(0, 300)}`);
  }
  const off = await runWith(q.path, 'off');
  if (!off.verdict.ran.every(Boolean)) findings.push(`off: not every call ran: ${JSON.stringify(off.verdict)} rc ${off.r.status} ${off.r.stderr.slice(0, 300)}`);
  if (off.markers.length !== 6) findings.push(`off: markers ${off.markers.join(', ')} (want all six)`);
  assert.deepStrictEqual(findings, []);
});
