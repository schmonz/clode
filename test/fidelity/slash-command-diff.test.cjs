'use strict';
// H2 — slash-command dispatch is identical under naude and quaude. A slash
// command is parsed and handled LOCALLY (no model call), so `-p '/status'`
// prints a deterministic client message ("/status isn't available in this
// environment"). Run it under both engines and assert the (ANSI-stripped)
// output matches — the slash parser/dispatch path is fidelity-clean.
const test = require('node:test');
const { spawnCollect } = require('../spawn-collect.cjs');
const { throwawayHome } = require('../throwaway-home.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('../node-shim-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
// THROUGH CLODE'S OWN STAGING (../oracle-models.cjs's stageCli), not the raw
// extractor directly. The raw libexec/extract-claude-js.cjs emits the graph
// EXACTLY as upstream shipped it, residual cyclic
// `import.meta.require("/$bunfs/root/chunk-….js")` edges and all; only clode's
// staging (libexec/clode-extract.cjs) merges those away. This file used to call
// the raw extractor directly and died on the first residual require — see
// oracle-models.cjs's own header for the full incident (five CI jobs at once).
function stage(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
  const { cli } = require('../oracle-models.cjs').stageCli(bin, { dir });
  return { dir, cli };
}
const STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r/g;
function run(cmd, argv) {
  const bin = providerBin();
  const { dir, cli } = stage(bin);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'slashcfg-'));
  const env = { ...process.env, ...throwawayHome(`${dir}-home`), CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: 'sk-ant-mock', NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  // 180 s, as the other quaude -p turns (agentic-workflow-complete's 90 s plus staging): quaude's /status takes ~25-48 s
  // here alone (naude ~10 s), and under the full suite's load it passed 60 s, came back EMPTY, and read as "quaude
  // printed nothing" (2026-11-21). A run that did not finish now says so instead of passing as an empty answer.
  return spawnCollect(cmd, [...argv(cli), '-p', '/status'], { cwd: dir, env }, { timeoutMs: 180000 })
    .then((r) => ({ status: r.status, signal: r.signal, timedOut: r.timedOut,
      out: r.error ? String(r.error) : (r.stdout + r.stderr).replace(STRIP, '') }));
}
const line = (o) => (o.match(/\/status[^\n]*/) || [''])[0].trim();

test('slash-command dispatch (/status in -p) is identical under naude and quaude', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!providerBin()) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const naude = await run(process.execPath, (cli) => [cli]);
  const quaude = await run(tjsPath(), (cli) => ['run', LOADER, cli]);
  for (const [side, r] of [['naude', naude], ['quaude', quaude]]) {
    assert.ok(!r.timedOut, `${side} -p /status did not finish (signal ${r.signal}); it printed:\n${r.out.slice(-400)}`);
  }
  const nl = line(naude.out), ql = line(quaude.out);
  assert.ok(nl.length > 0, `naude produced no /status line:\n${naude.out.slice(-400)}`);
  assert.strictEqual(ql, nl, `quaude slash-command output must match naude\n  naude:  ${nl}\n  quaude: ${ql}`);
});
