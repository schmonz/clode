// Drive a REAL binary's MCP transports against the mock servers and assert on
// the wire. Exits non-zero on failure, so CI can call it wherever a built quaude
// exists — the build smoke is the natural home, because an env-gated test that
// does not run in CI protects nothing.
//
//   node scripts/mcp-transport-probe.mjs <binary> [--transport sse|ws] [--verbose]
//
// WHY A SCRIPT AND NOT ONLY A TEST. test/mcp-transport.test.cjs pins the layers a
// bug can be caught at without a built binary (MessageEvent semantics, the ws
// request line). It cannot answer "does MCP actually work end to end in a blobulated
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { probeEnv } = createRequire(import.meta.url)('./lib/probe-env.cjs');

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
  const events = path.join(dir, 'events');
  fs.writeFileSync(wire, '');
  fs.writeFileSync(events, '');
  const child = spawn(process.execPath, [path.join(FIXTURES, script), portFile], {
    stdio: verbose ? 'inherit' : 'ignore',
    env: { ...process.env, MCP_MOCK_WIRE: wire, MCP_MOCK_EVENTS: events },
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const p = fs.readFileSync(portFile, 'utf8').trim();
      if (p) return { port: Number(p), wire: () => fs.readFileSync(wire, 'utf8'), events: () => fs.readFileSync(events, 'utf8'),
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

// The client's env: scripts/lib/probe-env.cjs (minimal, and why its spellings matter).

// THE CLIENT RUNS UNTIL THE WIRE ANSWERS, NOT FOR A FIXED 45 SECONDS. CI 45040226669 (windows-amd64) and
// 44980741750 (windows-arm64), each one leg of two at roughly one run in three: "(nothing arrived)" after exactly 45s.
// The client's own debug stamps showed why: the kill came at 16:12:31.2 (= spawn + 45.0s, so spawn at 16:11:46.2),
// and the client resolved its MCP configs at 16:12:25.9 ("awaited at +6585ms" of its own clock, which therefore
// started at 16:12:19.3, 33s after spawn) and began its MCP start-up round at 16:12:26.5, 40.3s after spawn, five
// seconds before the kill. Nothing had connected yet; on a faster run the same client connects inside the budget. A fixed budget measured from
// spawn judged the runner's boot time, not SSE. Now: the client runs until the wire shows the expected exchange (then
// it is stopped and the verdict is PASS), or until DEADLINE_MS; and EVERY run prints when, after spawn, the client's
// first stderr arrived and the server saw the TCP connect, the GET and the POST (test/fixtures/mcp/events.cjs), so a
// slow boot is visible on green runs too and a FAIL names the stage that never came.
const DEADLINE_MS = 150000;
const SETTLE_MS = 500;   // after the expected line, so a malformed target sent right behind it is still seen

function runClient(env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stderr = '', firstErr = null, done = false, timedOut = false, stoppedOnPass = false;
    const child = spawn(binary, ['--mcp-config', cfg, '-p', 'say hi', '--debug', '--debug-to-stderr'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { if (firstErr === null) firstErr = Date.now(); stderr += c; if (stderr.length > 400000) stderr = stderr.slice(-200000); });
    const finish = (status, signal, error) => {
      if (done) return; done = true; clearInterval(poll); clearTimeout(kill);
      resolve({ t0, status, signal, error, stderr, firstErr, timedOut, stoppedOnPass, end: Date.now() });
    };
    let passAt = null;
    const poll = setInterval(() => {
      if (passAt === null && kase.expect.test(mock.wire())) passAt = Date.now();
      if (passAt !== null && Date.now() - passAt >= SETTLE_MS) { stoppedOnPass = true; try { child.kill(); } catch { /* */ } }
    }, 100);
    const kill = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* */ } }, DEADLINE_MS); // spawn-watchdog: timedOut is printed ("stopped at the deadline")
    child.on('error', (e) => finish(null, null, e));
    // 'exit', not 'close': a grandchild still holding the client's stderr must not stretch the verdict past the
    // client's own end (stderr already read is kept; the rest is dropped).
    child.on('exit', (status, signal) => { finish(status, signal, null); try { child.stderr.destroy(); } catch { /* */ } });
  });
}

// The server's events, each as seconds after the client's spawn.
function eventsSince(t0) {
  const lines = mock.events().split('\n').filter(Boolean).map((l) => {
    const sp = l.indexOf(' ');
    const at = Number(l.slice(0, sp));
    const d = (at - t0) / 1000;
    return `  ${d < 0 ? "-" : "+"}${Math.abs(d).toFixed(1)}s ${l.slice(sp + 1)}`;
  });
  if (!lines.some((l) => / connect #/.test(l))) lines.push('  (no TCP connection reached the server)');
  return lines.join('\n');
}

let failed = false;
try {
  // No credentials and no network: the transport handshake happens during MCP
  // startup, well before any API turn, so a bogus key is enough to reach it.
  const r = await runClient(probeEnv(home));
  if (verbose && r.stderr) process.stderr.write(r.stderr.slice(0, 2000));

  // A PROBE THAT CANNOT SAY "the client never ran" is not a transport probe.
  // On the Windows legs this reported `(nothing arrived)` and blamed SSE, when
  // in fact the spawn had failed outright and the quaude never started: the
  // giveaway was elapsed time -- 0.2s against the full budget on the legs that
  // really do run the binary. The whole point of this file is to distinguish what
  // a client CLAIMS from what ARRIVED; it must equally distinguish "no client".
  // Stopping the client is the NORMAL end (on PASS, or at the deadline); only a
  // real spawn failure (ENOENT/EACCES/…) means no child ever existed.
  if (r.error) {
    console.error(`FAIL: ${transport}: the binary never launched — ${r.error.message}`);
    console.error(`  binary: ${binary}`);
    console.error('  On Windows an EXTENSIONLESS path is the usual cause: node\'s libuv only tries\n'
      + '  <name>.com and <name>.exe unless UV_PROCESS_WINDOWS_FILE_PATH_EXACT_NAME is set,\n'
      + '  and node does not set it (txiki does, which is why clode\'s own smoke spawns it fine).');
    process.exit(1);
  }

  const wire = mock.wire();
  const ran = ((r.end - r.t0) / 1000).toFixed(1);
  console.log(`--- ${transport} wire ---\n${wire.trim() || '(nothing arrived)'}`);
  console.log(`--- ${transport} timeline (after the client's spawn) ---\n`
    + `  +${r.firstErr === null ? '?' : ((r.firstErr - r.t0) / 1000).toFixed(1)}s the client's first stderr\n`
    + `${eventsSince(r.t0)}\n`
    + `  +${ran}s the client ${r.stoppedOnPass ? 'stopped by the probe (expected exchange seen)' : r.timedOut ? `stopped at the ${DEADLINE_MS / 1000}s deadline` : `exited on its own: status ${r.status} signal ${r.signal}`}`);

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
    // A FAIL must carry what the client said, or the next step is a blind rerun (CI 44980741750,
    // windows-arm64: "(nothing arrived)" after the full budget, with no way to tell a hang from a crash
    // from a slow start). The exit, the time it ran and the tail of its stderr, on every FAIL.
    if (failed) {
      console.error(`  client: status ${r.status} signal ${r.signal} ${r.timedOut ? 'deadline' : 'exited'} after ${ran}s`);
      console.error(`  client stderr tail:\n${String(r.stderr || '').slice(-3000) || '(empty)'}`);
    }
  } else {
    console.log(`PASS: ${transport}: reached the server at the expected target`);
  }
} finally {
  mock.stop();
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
