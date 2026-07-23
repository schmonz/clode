'use strict';
// H5 — MCP-over-WebSocket, end-to-end, validating the Phase-2 native WS transport
// inside the real bundle under quaude: a ws-configured MCP server, the bundle
// connects (`new WebSocket(url,{protocols:["mcp"]})` -> the shim's native-WS
// delegation), does the MCP handshake, the model calls the ws MCP tool, and the
// tool's result marshals back into the Anthropic tool_result.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');
const { startMockMcpWs } = require('./mock-mcp-ws.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function stageBundle(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpws-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}
function bootP(cli, dir, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(tjsPath(), ['run', LOADER, cli, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
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

test('MCP-over-WebSocket under tjs: connect + handshake + tool call over the native WS transport', async (t) => {
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
