'use strict';
// H2 — slash-command dispatch is identical under naude and quaude. A slash
// command is parsed and handled LOCALLY (no model call), so `-p '/status'`
// prints a deterministic client message ("/status isn't available in this
// environment"). Run it under both engines and assert the (ANSI-stripped)
// output matches — the slash parser/dispatch path is fidelity-clean.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('../node-shim-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function stage(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}
const STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r/g;
function run(cmd, argv) {
  const bin = providerBin();
  const { dir, cli } = stage(bin);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'slashcfg-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: 'sk-ant-mock', NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  return new Promise((resolve) => {
    const c = spawn(cmd, [...argv(cli), '-p', '/status'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let so = '', se = ''; c.stdout.on('data', (d) => so += d); c.stderr.on('data', (d) => se += d);
    const to = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.on('exit', (status) => { clearTimeout(to); resolve({ status, out: (so + se).replace(STRIP, '') }); });
    c.on('error', (e) => { clearTimeout(to); resolve({ status: null, out: String(e) }); });
  });
}
const line = (o) => (o.match(/\/status[^\n]*/) || [''])[0].trim();

test('slash-command dispatch (/status in -p) is identical under naude and quaude', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!providerBin()) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const naude = await run(process.execPath, (cli) => [cli]);
  const quaude = await run(tjsPath(), (cli) => ['run', LOADER, cli]);
  const nl = line(naude.out), ql = line(quaude.out);
  assert.ok(nl.length > 0, `naude produced no /status line:\n${naude.out.slice(-400)}`);
  assert.strictEqual(ql, nl, `quaude slash-command output must match naude\n  naude:  ${nl}\n  quaude: ${ql}`);
});
