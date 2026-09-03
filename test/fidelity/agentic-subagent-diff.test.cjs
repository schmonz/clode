'use strict';
// H6 — subagent/Task dispatch, as a TRUE three-engine differential (the recipe's
// localization model in a test): run the SAME Task scenario under naude (node
// cli.cjs) AND quaude (tjs loader cli.cjs), each against a fresh mock, and assert
// the Task tool_result is IDENTICAL. This guards the subagent-dispatch/marshaling
// path for fidelity (quaude == naude) without depending on the -p+mock being able
// to fully run the Agent (it hits an auto-mode safety gate the same way in both).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, isApeFile, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
const TASK_ID = 'toolu_task_diff_1';
const SUBTOKEN = 'SUBDIFF-PROMPT-77', SUBANSWER = 'SUBDIFF-ANSWER-77';

// THROUGH CLODE'S OWN STAGING (../oracle-models.cjs's stageCli), not the raw
// extractor directly. The raw libexec/extract-claude-js.cjs emits the graph
// EXACTLY as upstream shipped it, residual cyclic
// `import.meta.require("/$bunfs/root/chunk-….js")` edges and all; only clode's
// staging (libexec/clode-extract.cjs) merges those away. This file used to call
// the raw extractor directly and died on the first residual require — see
// oracle-models.cjs's own header for the full incident (five CI jobs at once).
function stage(bin) {
  const { dir, cli } = require('../oracle-models.cjs').stageCli(bin);
  return { dir, cli };
}
function run(cmd, args, dir, env, timeoutMs) {
  // A cosmo APE engine can't be execve'd on non-Windows — wrap it in the /bin/sh
  // ENOEXEC trampoline. Node (the naude side of this differential) is not an APE,
  // so it passes through unchanged.
  if (isApeFile(cmd)) { args = ['-c', '"$@"', 'sh', cmd, ...args]; cmd = '/bin/sh'; }
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let so = '', se = ''; c.stdout.on('data', (d) => so += d); c.stderr.on('data', (d) => se += d);
    const to = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('exit', (s) => { clearTimeout(to); res({ status: s, stdout: so, stderr: se }); });
    c.on('error', (e) => { clearTimeout(to); res({ status: null, stdout: so, stderr: String(e) }); });
  });
}
function taskResult(requests) {
  const fu = requests.find((q) => q.method === 'POST' && q.body && q.body.includes(TASK_ID) && q.body.includes('tool_result'));
  if (!fu) return null;
  try {
    const j = JSON.parse(fu.body);
    for (const m of j.messages || []) for (const b of (Array.isArray(m.content) ? m.content : [])) {
      if (b && b.type === 'tool_result' && b.tool_use_id === TASK_ID) return JSON.stringify(b.content);
    }
  } catch { /* shape drift */ }
  return null;
}
async function engineRun(cmd, argv) {
  const bin = providerBin();
  const { dir, cli } = stage(bin);
  const mock = await startMockAnthropic({
    respond: (body) => (body.includes('"tool_result"') && body.includes(TASK_ID)) ? cannedSSE('TASKDONE')
      : body.includes(SUBTOKEN) ? cannedSSE(SUBANSWER)
        : cannedToolUseSSE('Task', { description: 'delegate', prompt: `answer with ${SUBTOKEN}`, subagent_type: 'general-purpose' }, TASK_ID),
  });
  const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock', NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  const r = await run(cmd, [...argv(cli), '-p', 'delegate the work', '--allowedTools', 'Task'], dir, env, 90000);
  const result = { status: r.status, done: /TASKDONE/.test(r.stdout), taskResult: taskResult(mock.requests) };
  await mock.close();
  return result;
}

test('subagent (Task) dispatch is identical under naude and quaude', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!providerBin()) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const naude = await engineRun(process.execPath, (cli) => [cli]);
  const quaude = await engineRun(tjsPath(), (cli) => ['run', LOADER, cli]);
  assert.strictEqual(naude.status, 0, 'naude did not exit 0');
  assert.strictEqual(quaude.status, 0, 'quaude did not exit 0');
  assert.ok(naude.done && quaude.done, 'both engines must reach the final turn');
  assert.ok(naude.taskResult, 'naude produced no Task tool_result');
  assert.strictEqual(quaude.taskResult, naude.taskResult, 'quaude Task tool_result must byte-match naude');
});
