'use strict';
// throwawayHome's env leaves nothing in the box's shared /tmp/claude-<uid> (every-tool Task 3 fix round).
//
// WHAT HAPPENED. Claude Code's per-uid temp dir defaults to /tmp/claude-<uid>. A turn whose Bash tool runs makes a
// directory there named for its working directory, and every agentic row ran one with test/throwaway-home.cjs's env
// spread, which set HOME and CLAUDE_CONFIG_DIR but not CLAUDE_CODE_TMPDIR: this box had 1110 dirs there
// named for a temp cwd (35 of them agentic-tools' `...-T-agtool-*`), beside the developer's own sessions. throwawayHome now sets
// CLAUDE_CODE_TMPDIR to a private dir under the test's own.
//
// THE ROW: one -p turn whose Bash tool runs, with exactly the spread the agentic rows use
// ({ ...process.env, ...throwawayHome(dir), mock }), by a quaude built from this tree and by native where one runs.
// Nothing named for the turn's cwd appears in /tmp/claude-<uid>, and the dir lands under the throwaway tmp instead.
// THE CONTROL: the same turn with CLAUDE_CODE_TMPDIR taken out of the env DOES leave one there (then removed), so the
// check can fail.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { throwawayHome } = require('./throwaway-home.cjs');
const { spawnCollect } = require('./spawn-collect.cjs');
const { builtQuaude } = require('./built-binary.cjs');
const { rgOracle } = require('./provider-resolve.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');

const SKIP = process.platform === 'win32' ? 'the per-uid dir is /tmp/claude-<uid>, a POSIX path' : false;
const SHARED = () => `/tmp/claude-${process.getuid()}`;
const BASH = { name: 'Bash', input: { command: 'echo TMP-PROBE-$((6*7))' }, id: 'toolu_tmp_probe' };
const ran = (m) => toolResultText(m, BASH.id).includes('TMP-PROBE-42');
// The entries of `dir` named for the turn's cwd (Claude Code names them by the cwd with every / turned into -).
const turnEntries = (dir, cwd) => { try { return fs.readdirSync(dir).filter((e) => e.includes(path.basename(cwd))); } catch { return []; } };

async function turn(bin, withTmp) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-probe-')));
  const home = throwawayHome(dir);
  const mock = await startMockAnthropic({
    respond: (seen) => seen.includes(BASH.id) ? cannedSSE('TMP-DONE') : cannedToolUseSSE(BASH.name, BASH.input, BASH.id),
  });
  try {
    const env = { ...process.env, ...home, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' };
    if (!withTmp) delete env.CLAUDE_CODE_TMPDIR;
    const r = await spawnCollect(bin, ['-p', 'probe', '--allowedTools', 'Bash'], { cwd: dir, env }, { timeoutMs: 180000 });
    return { r, dir, home, mock, shared: turnEntries(SHARED(), dir), own: turnEntries(path.join(home.CLAUDE_CODE_TMPDIR, `claude-${process.getuid()}`), dir) };
  } finally { await mock.close(); }
}

test('a turn with throwawayHome\'s env leaves nothing in /tmp/claude-<uid>; without its CLAUDE_CODE_TMPDIR it does', { skip: SKIP }, async (t) => {
  const bins = [];
  const q = builtQuaude();
  if (!q.skip) bins.push(['quaude', q.path]);
  const native = rgOracle(process.env);
  if (native) bins.push(['native', native]);
  if (!bins.length) { t.skip(`no quaude (${q.skip}) and no native that runs`); return; }
  assertFailsOnMissingOutput(ran, BASH);
  for (const [label, bin] of bins) {
    const fixed = await turn(bin, true);
    try {
      assert.strictEqual(fixed.r.status, 0, `${label}: ${fixed.r.stderr.slice(0, 800)}`);
      assert.ok(ran(fixed.mock), `${label}: the Bash tool ran: ${JSON.stringify(toolResultText(fixed.mock, BASH.id))}`);
      assert.deepStrictEqual(fixed.shared, [], `${label}: the turn left ${fixed.shared.join(', ')} in ${SHARED()}`);
      assert.strictEqual(fixed.own.length, 1, `${label}: the turn's dir is under the throwaway CLAUDE_CODE_TMPDIR`);
    } finally { fs.rmSync(fixed.dir, { recursive: true, force: true }); }
    // the control: the leak is real when CLAUDE_CODE_TMPDIR is not set (and what it leaves is removed at once)
    const leaky = await turn(bin, false);
    try {
      assert.ok(ran(leaky.mock), `${label} (control): the Bash tool ran`);
      assert.strictEqual(leaky.shared.length, 1, `${label} (control): without CLAUDE_CODE_TMPDIR the turn leaves its dir in ${SHARED()}`);
    } finally {
      for (const e of leaky.shared) fs.rmSync(path.join(SHARED(), e), { recursive: true, force: true });
      fs.rmSync(leaky.dir, { recursive: true, force: true });
    }
  }
});
