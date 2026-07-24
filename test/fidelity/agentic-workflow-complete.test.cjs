'use strict';
// H11 — Workflow runs to COMPLETION under quaude (terminal-state gate; the launch-ack
// diff can't see this). Drives a bare log()+return workflow via the mock and asserts
// the engine's wf_<id>.json records status:completed + result + the log marker.
// Guards the node:vm context-isolation fix (src/mod_vm.c + modules/vm.cjs): before it,
// a workflow SIGABRT'd/SIGSEGV'd on the Date.now determinism guard leaking into the
// shared global. See docs/superpowers/plans/2026-07-24-vm-context-isolation.md.
// tjs + CLODE_PROVIDER_BIN gated.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
const WF_ID = 'toolu_wf_complete_1';
const MARKER = 'WF-COMPLETE-MARKER';
const WF_SCRIPT =
  "export const meta = { name: 'fidelity-complete', description: 'm', phases: [] }\n" +
  "log(" + JSON.stringify(MARKER) + ")\n" +
  "return { ok: true }";

function stage(bin) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wfcomplete-')));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}
function run(cmd, args, dir, env, timeoutMs) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let so = '', se = ''; c.stdout.on('data', (d) => so += d); c.stderr.on('data', (d) => se += d);
    const to = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('exit', (s) => { clearTimeout(to); res({ status: s, stdout: so, stderr: se }); });
    c.on('error', (e) => { clearTimeout(to); res({ status: null, stdout: so, stderr: String(e) }); });
  });
}
function walk(d, acc) {
  for (const e of (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
function findWfJson(configDir) {
  const proj = path.join(configDir, 'projects');
  const f = walk(proj, []).find((p) => /workflows\/wf_[^/]+\.json$/.test(p));
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

test('Workflow runs to completion under quaude (vm isolation)', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!providerBin()) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { dir, cli } = stage(providerBin());
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-'));
  const mock = await startMockAnthropic({
    respond: (body) => (body.includes('"tool_result"') && body.includes(WF_ID))
      ? cannedSSE('WFDONE')
      : cannedToolUseSSE('Workflow', { script: WF_SCRIPT }, WF_ID),
  });
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock',
    CLAUDE_CONFIG_DIR: configDir,
    NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules'),
  };
  const r = await run(tjsPath(), ['run', LOADER, cli, '-p', 'run the workflow', '--allowedTools', 'Workflow'], dir, env, 90000);
  await mock.close();
  await new Promise((res) => setTimeout(res, 3000)); // let the runner flush wf_<id>.json

  assert.strictEqual(r.status, 0, `quaude -p must exit 0 (no crash). stderr=${JSON.stringify((r.stderr || '').slice(-300))}`);
  const wf = findWfJson(configDir);
  assert.ok(wf, 'no wf_<id>.json produced (workflow never ran)');
  assert.strictEqual(wf.status, 'completed', `workflow status=${JSON.stringify(wf.status)} (expected completed)`);
  assert.deepStrictEqual(wf.result, { ok: true }, `workflow result=${JSON.stringify(wf.result)}`);
  assert.ok(Array.isArray(wf.logs) && wf.logs.includes(MARKER), `log() marker missing from wf.logs=${JSON.stringify(wf.logs)}`);
});
