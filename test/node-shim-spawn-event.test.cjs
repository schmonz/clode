'use strict';
// ChildProcess 'spawn' — found 2026-08-06 by driving a real stdio MCP server.
//
// node emits 'spawn' once a child is successfully spawned (before any
// stdout/stderr data and before 'exit'), and on a launch failure emits 'error'
// INSTEAD, never 'spawn'. This shim emitted neither: `['exit','close']` where
// node gives `['spawn','exit','close']`.
//
// That broke MCP over stdio COMPLETELY. The MCP SDK's StdioClientTransport
// .start() resolves its connect promise on exactly this event, so under quaude
// the transport never finished connecting: it wrote no bytes to the server, the
// server sat on an empty stdin and exited at EOF, and the client reported it as
// "still connecting" forever and then hung until killed. Every stdio MCP server
// was unusable — with NO error anywhere, while the upstream reference completed
// the same handshake and returned its tool result.
//
// Hermetic: these spawn /bin/echo and a nonexistent binary. No network, no API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-spawnev-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const ORDER = `
  const { spawn } = require('node:child_process');
  const c = spawn('/bin/echo', ['hi'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = [];
  for (const ev of ['spawn', 'exit', 'close', 'error']) c.on(ev, () => seen.push(ev));
  setTimeout(() => console.log(JSON.stringify({ seen, pidIsNumber: typeof c.pid === 'number' })), 800);
`;

test("spawn: a successful child emits 'spawn' before exit/close (matches node)", (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(ORDER);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  // Anchor the oracle so a broken fixture cannot make this vacuous.
  assert.deepStrictEqual(node.seen, ['spawn', 'exit', 'close']);
});

const FAILURE = `
  const { spawn } = require('node:child_process');
  const c = spawn('this-binary-does-not-exist-xyz', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = [];
  for (const ev of ['spawn', 'error', 'exit', 'close']) c.on(ev, () => seen.push(ev));
  setTimeout(() => console.log(JSON.stringify({ seen })), 800);
`;

test("spawn: a FAILED launch emits 'error' and never 'spawn' (matches node)", (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(FAILURE);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.ok(!node.seen.includes('spawn'), 'node must not emit spawn on a launch failure');
  // The half a naive "always emit spawn" fix would break: a transport that keys
  // "connected" off this event would treat a dead binary as a live server.
  assert.deepStrictEqual(node.seen, ['error', 'close']);
});

// The MCP SDK's actual shape: do NOT write until 'spawn' fires, then write and
// expect a reply. Pre-fix this deadlocked — the write never happened, the child
// hit EOF and exited, and the parent waited forever.
const SDK_SHAPE = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.argv[0] === undefined ? 'cat' : 'cat', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  let wrote = false;
  child.on('spawn', () => { wrote = true; child.stdin.write('PING-AFTER-SPAWN\\n'); child.stdin.end(); });
  child.on('close', () => console.log(JSON.stringify({ wrote, echoed: out.trim() })));
  setTimeout(() => { if (!wrote) console.log(JSON.stringify({ wrote: false, echoed: 'NEVER-SPAWNED' })); }, 3000);
`;

test("spawn: the MCP-transport pattern (write only after 'spawn') completes", (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(SDK_SHAPE);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const shim = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(shim, node);
  // Pre-fix the shim reported {wrote:false, echoed:'NEVER-SPAWNED'}.
  assert.deepStrictEqual(node, { wrote: true, echoed: 'PING-AFTER-SPAWN' });
});
