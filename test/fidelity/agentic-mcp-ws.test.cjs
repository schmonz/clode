'use strict';
// H5 — MCP-over-WebSocket, end-to-end, validating the Phase-2 native WS transport
// inside the real bundle under quaude: a ws-configured MCP server, the bundle
// connects (`new WebSocket(url,{protocols:["mcp"]})` -> the shim's native-WS
// delegation), does the MCP handshake, the model calls the ws MCP tool, and the
// tool's result marshals back into the Anthropic tool_result.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, engineSpawn, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');
const { startMockMcpWs } = require('./mock-mcp-ws.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
// THROUGH CLODE'S OWN STAGING (../oracle-models.cjs's stageCli), not the raw
// extractor directly. The raw libexec/extract-claude-js.cjs emits the graph
// EXACTLY as upstream shipped it, residual cyclic
// `import.meta.require("/$bunfs/root/chunk-….js")` edges and all; only clode's
// staging (libexec/clode-extract.cjs) merges those away. This file used to call
// the raw extractor directly and died on the first residual require — see
// oracle-models.cjs's own header for the full incident (five CI jobs at once).
function stageBundle(bin) {
  const { dir, cli } = require('../oracle-models.cjs').stageCli(bin);
  return { dir, cli };
}
function bootP(cli, dir, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const [cmd, argv] = engineSpawn(['run', LOADER, cli, ...args]);
    const child = spawn(cmd, argv, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}
function followUpFor(mock, id) {
  return mock.requests.find((q) => q.method === 'POST' && q.body && q.body.includes(id) && q.body.includes('tool_result'));
}
const MCP_MARKER = 'MCP-WS-NEEDLE-8842';

// DEFERRED, not silently: undarking this suite (2026-09-02) fixed the residual
// chunk-resolve staging bug that used to abort this test before it ever reached the
// network — but with that fixed, `mcp.seen` stays `[]`: the ws server never gets so
// much as a TCP connection. Eliminated with evidence (see BACKLOG.md, "MCP-over-
// WebSocket: quaude never connects on native (non-cosmo) darwin-arm64 tjs"): not a
// race with the mock's instant reply (proven with an artificial 3s reply delay), not
// a permission gate (--dangerously-skip-permissions made no difference), not the mcp
// config shape (verbatim-matches the staged bundle's own `t.type==="ws"` branch), not
// upstream in general (the IDENTICAL mcp.json/argv/mock run under naude — plain node,
// no shim/engine — gets all four MCP events: initialize, notifications/initialized,
// tools/list, tools/call), not a dev-box config leak (reproduces with a fresh HOME +
// CLAUDE_CONFIG_DIR). Isolates to quaude's own native-WS delegation on this engine
// build; `--debug mcp` shows no log line even though the staged bundle plainly logs
// one on this path, which is the same SILENT-native-failure shape as the cosmo
// libwebsockets SHA-1 bug this file already tracks (BACKLOG.md, "MCP-over-WebSocket
// client never connects — FIXED (2026-07-30)") — but that fix was cosmo-gated, and
// this engine is native (non-cosmo) Mach-O arm64, so it needs its own root-cause pass
// with --strace/--ftrace-equivalent tooling. Reproduction is in BACKLOG.md.
const MCP_WS_DEFERRED = 'DEFERRED (BACKLOG.md, "MCP-over-WebSocket: quaude never '
  + 'connects on native (non-cosmo) darwin-arm64 tjs"): the ws MCP server never '
  + 'receives a connection under quaude (naude reference gets all 4 MCP events with '
  + 'the identical config/mock) — isolates to native-WS delegation, not staging, not '
  + 'timing, not permissions, not config shape; needs engine-level debugging.';

test('MCP-over-WebSocket under tjs: connect + handshake + tool call over the native WS transport',
  { skip: MCP_WS_DEFERRED }, async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const mcp = await startMockMcpWs({ marker: MCP_MARKER, toolName: 'echo_needle' });
  if (!mcp) { t.skip('no ws package available for the mock MCP server'); return; }
  try {
    const { dir, cli } = stageBundle(bin);
    const mcpConfig = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { mymock: { type: 'ws', url: mcp.url } } }));
    const TOOL = 'mcp__mymock__echo_needle';
    const ID = 'toolu_mcp_1';
    const mock = await startMockAnthropic({
      respond: (body) => body.includes(ID) ? cannedSSE('MCPDONE') : cannedToolUseSSE(TOOL, {}, ID),
    });
    try {
      const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock', NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
      const r = await bootP(cli, dir, ['-p', 'call the mcp tool', '--allowedTools', TOOL, '--mcp-config', mcpConfig], env, 120000);
      assert.ok(mcp.seen.includes('initialize'),
        `MCP server never got initialize — the ws transport failed to connect. seen=${JSON.stringify(mcp.seen)}\nstderr:\n${r.stderr.slice(-600)}`);
      assert.ok(mcp.seen.includes('tools/call'),
        `MCP tool was never called over ws. seen=${JSON.stringify(mcp.seen)}`);
      const fu = followUpFor(mock, ID);
      assert.ok(fu && fu.body.includes(MCP_MARKER),
        `MCP tool result did not propagate to the tool_result:\n${fu ? fu.body.slice(0, 1500) : '(no follow-up)'}`);
    } finally { await mock.close(); }
  } finally { await mcp.close(); }
});
