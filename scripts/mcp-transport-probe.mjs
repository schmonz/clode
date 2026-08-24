// Drive a REAL binary's MCP transports against the mock servers and assert on
// the wire. Exits non-zero on failure, so CI can call it wherever a built quaude
// exists — the build smoke is the natural home, because an env-gated test that
// does not run in CI protects nothing.
//
//   node scripts/mcp-transport-probe.mjs <binary> [--transport sse|ws] [--verbose]
//
// WHY A SCRIPT AND NOT ONLY A TEST. test/mcp-transport.test.cjs pins the layers a
// bug can be caught at without a built binary (MessageEvent semantics, the ws
// request line). It cannot answer "does MCP actually work end to end in a fused
// quaude", because that needs a quaude. This does.
//
// ALWAYS RUN THE REFERENCE TOO. Point this at the upstream claude binary and
// compare. When MCP-over-ws was first driven, quaude connected and then sent
// nothing — which looks damning until the reference does exactly the same thing
// and hangs identically. Without that control it would have been filed as a
// quaude bug it is not. `--transport ws` is therefore reported as INCONCLUSIVE
// rather than FAIL unless a reference run is supplied to compare against.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'test/fixtures/mcp');

const argv = process.argv.slice(2);
const binary = argv.find((a) => !a.startsWith('--'));
const transport = (argv.find((a) => a.startsWith('--transport')) || '--transport=sse').split('=')[1] || 'sse';
const verbose = argv.includes('--verbose');

if (!binary || !fs.existsSync(binary)) {
  console.error('usage: mcp-transport-probe.mjs <binary> [--transport=sse|ws] [--verbose]');
  process.exit(2);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function startMock(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-'));
  const portFile = path.join(dir, 'port');
  const wire = path.join(dir, 'wire');
  fs.writeFileSync(wire, '');
  const child = spawn(process.execPath, [path.join(FIXTURES, script), portFile], {
    stdio: verbose ? 'inherit' : 'ignore',
    env: { ...process.env, MCP_MOCK_WIRE: wire },
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const p = fs.readFileSync(portFile, 'utf8').trim();
      if (p) return { port: Number(p), wire: () => fs.readFileSync(wire, 'utf8'),
        stop() { try { child.kill('SIGKILL'); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); } };
    } catch { /* not yet */ }
    sleep(25);
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  throw new Error(`mock ${script} never published a port`);
}

const CASES = {
  sse: {
    script: 'sse-server.cjs',
    config: (port) => ({ mcpServers: { probe: { type: 'sse', url: `http://127.0.0.1:${port}/sse` } } }),
    // The bug this exists to catch: the POST target was a stringified object.
    expect: /POST \/messages\?sessionId=probe/,
    reject: /\[object%20Object\]|\[object Object\]/,
    conclusive: true,
  },
  ws: {
    script: 'ws-server.cjs',
    config: (port) => ({ mcpServers: { probe: { type: 'ws', url: `ws://127.0.0.1:${port}/` } } }),
    expect: /UPGRADE /,
    reject: null,
    conclusive: false,   // see the header: the reference does not complete either
  },
};

const kase = CASES[transport];
if (!kase) { console.error(`unknown transport '${transport}'`); process.exit(2); }

const mock = startMock(kase.script);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-home-'));
const cfg = path.join(home, 'mcp.json');
fs.writeFileSync(cfg, JSON.stringify(kase.config(mock.port)));

let failed = false;
try {
  // No credentials and no network: the transport handshake happens during MCP
  // startup, well before any API turn, so a bogus key is enough to reach it.
  const r = spawnSync(binary, ['--mcp-config', cfg, '-p', 'say hi'], {
    encoding: 'utf8',
    timeout: 45000,
    env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: 'sk-probe-notreal' },
  });
  if (verbose && r.stderr) process.stderr.write(r.stderr.slice(0, 2000));

  // A PROBE THAT CANNOT SAY "the client never ran" is not a transport probe.
  // On the Windows legs this reported `(nothing arrived)` and blamed SSE, when
  // in fact spawnSync had failed outright and the quaude never started: the
  // giveaway was elapsed time -- 0.2s against 45s (the timeout) on the legs that
  // really do run the binary. The whole point of this file is to distinguish what
  // a client CLAIMS from what ARRIVED; it must equally distinguish "no client".
  if (r.error) {
    console.error(`FAIL: ${transport}: the binary never launched — ${r.error.message}`);
    console.error(`  binary: ${binary}`);
    console.error('  On Windows an EXTENSIONLESS path is the usual cause: node\'s libuv only tries\n'
      + '  <name>.com and <name>.exe unless UV_PROCESS_WINDOWS_FILE_PATH_EXACT_NAME is set,\n'
      + '  and node does not set it (txiki does, which is why clode\'s own smoke spawns it fine).');
    process.exit(1);
  }

  const wire = mock.wire();
  console.log(`--- ${transport} wire ---\n${wire.trim() || '(nothing arrived)'}`);

  if (kase.reject && kase.reject.test(wire)) {
    console.error(`FAIL: ${transport}: the wire shows a malformed target — ${wire.match(kase.reject)[0]}`);
    failed = true;
  } else if (!kase.expect.test(wire)) {
    const verdict = kase.conclusive ? 'FAIL' : 'INCONCLUSIVE';
    console.error(`${verdict}: ${transport}: expected ${kase.expect} on the wire.`);
    if (!kase.conclusive) {
      console.error('  Run the upstream claude binary against this same mock before '
        + 'concluding anything: it does not complete an MCP-over-ws exchange either.');
    }
    failed = kase.conclusive;
  } else {
    console.log(`PASS: ${transport}: reached the server at the expected target`);
  }
} finally {
  mock.stop();
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
