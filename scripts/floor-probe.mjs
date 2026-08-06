#!/usr/bin/env node
// Floor probe — drive a BUILT quaude/naude on THIS box and emit RESULTS.md rows.
//
// Why this exists: of the six FLOOR_ROWS (A1,B1,B4,C1,D1,G7) only G7 is produced
// mechanically today, by clode build's own smokeTarget. Every other row's cited
// evidence is a node:test file, so it can only ever run where node runs — which
// is why A1 and D1 are missing on ALL 47 run-targets and no run-target is tier-1
// eligible. This probe drives the FUSED BINARY instead (the same thing
// smokeTarget does to earn G7), so the same evidence becomes reachable on any box
// that can execute the artifact.
//
//   node scripts/floor-probe.mjs <binary> <run-target> [--json]
//
// It prints rows in test/fidelity/RESULTS.md's table shape. It does NOT edit the
// ledger: floorCoverage() reads committed rows, and a probe that could write its
// own passing evidence would be marking its own homework. Paste what it prints.
//
// HERMETIC and OFFLINE: a fresh HOME + workspace per check and a local canned
// mock. No credentials, no network, no API.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [, , BIN, RUN_TARGET, ...rest] = process.argv;
const AS_JSON = rest.includes('--json');
if (!BIN || !RUN_TARGET) {
  console.error('usage: floor-probe.mjs <binary> <run-target> [--json]');
  process.exit(2);
}
if (!fs.existsSync(BIN)) { console.error(`floor-probe: no such binary: ${BIN}`); process.exit(2); }

const SCALE = Number(process.env.CLODE_TIMEOUT_SCALE || 1);
const TIMEOUT = 180000 * SCALE;

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function textSSE(text) {
  return ev('message_start', { type: 'message_start', message: { id: 'msg_floor', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } })
    + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    + ev('message_stop', { type: 'message_stop' });
}
function toolUseSSE(name, input, id) {
  return ev('message_start', { type: 'message_start', message: { id: 'msg_floor_tool', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } })
    + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
    + ev('message_stop', { type: 'message_stop' });
}

// `rules` are tried in order; the first whose `match` appears in the request body
// wins (a rule with no `match` always matches — put it last).
function startMock(rules) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === 'POST' && /\/messages$/.test(req.url.split('?')[0])) {
        const rule = rules.find((r) => !r.match || body.includes(r.match)) || { text: 'PONG' };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.end(rule.tool ? toolUseSSE(rule.tool.name, rule.tool.input, rule.tool.id) : textSSE(rule.text ?? 'PONG'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  })));
}

function run(bin, args, { home, cwd, extraEnv }) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-floor-probe', ...extraEnv };
    // Stripped so a pass PROVES the artifact is self-contained — the same reason
    // clode build's smoke strips it.
    delete env.NODE_PATH;
    let out = '', err = '';
    const c = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } }, TIMEOUT);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code, sig) => { clearTimeout(timer); resolve({ code, sig, out, err }); });
    c.on('error', (e) => { clearTimeout(timer); resolve({ code: null, sig: null, out, err: String(e) }); });
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-probe-'));
  const home = path.join(dir, 'home');
  const work = fs.realpathSync.native ? undefined : undefined;
  fs.mkdirSync(home, { recursive: true });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'work-')));
  // Pre-trust the workspace and mark onboarding done, or an interactive-ish path
  // stalls on a dialog. Key on the RESOLVED path: /var vs /private/var differ.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  return { dir, home, cwd, drop: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

const posted = (mock) => mock.requests.some((q) => q.method === 'POST' && /\/messages/.test(q.url));

// ---- the checks. Each maps to ONE RECIPE floor row. ------------------------
const CHECKS = [
  {
    row: 'G7',
    what: 'one agentic -p turn completes end to end and returns a non-empty answer',
    async fn(sbx) {
      const mock = await startMock([{ text: 'PONG' }]);
      try {
        const r = await run(BIN, ['-p', 'say PONG'], { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
        const ok = r.code === 0 && /PONG/.test(r.out) && posted(mock);
        return { ok, how: ok ? 'exit 0, PONG, POST landed' : `exit=${r.code ?? r.sig} posted=${posted(mock)} stdout=${JSON.stringify(r.out.slice(0, 120))}` };
      } finally { await mock.close(); }
    },
  },
  {
    row: 'B1',
    what: 'Bash tool runs a command and returns output',
    async fn(sbx) {
      const ID = 'toolu_floor_bash';
      const MARK = 'FLOOR-BASH-OK';
      const mock = await startMock([
        { match: ID, text: 'done' },                                   // the follow-up carrying tool_result
        { tool: { name: 'Bash', input: { command: `echo ${MARK}` }, id: ID } },
      ]);
      try {
        const r = await run(BIN, ['-p', 'run it', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash'],
          { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
        // The proof is the tool_result echoed back to the model, not the prose:
        // the bundle sends the command's OUTPUT in the follow-up request.
        const echoed = mock.requests.some((q) => (q.body || '').includes(MARK));
        const ok = r.code === 0 && echoed;
        return { ok, how: ok ? `exit 0, tool_result carried ${MARK}` : `exit=${r.code ?? r.sig} echoed=${echoed} stderr=${JSON.stringify(r.err.slice(-160))}` };
      } finally { await mock.close(); }
    },
  },
  {
    row: 'C1',
    what: 'write a small file (the 0-byte config class) — non-zero on disk',
    async fn(sbx) {
      const ID = 'toolu_floor_write';
      const target = path.join(sbx.cwd, 'floor-write.txt');
      const mock = await startMock([
        { match: ID, text: 'written' },
        { tool: { name: 'Write', input: { file_path: target, content: 'FLOOR-WRITE-OK\n' }, id: ID } },
      ]);
      try {
        const r = await run(BIN, ['-p', 'write it', '--permission-mode', 'bypassPermissions'],
          { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
        const exists = fs.existsSync(target);
        const size = exists ? fs.statSync(target).size : 0;
        const ok = r.code === 0 && exists && size > 0 && /FLOOR-WRITE-OK/.test(fs.readFileSync(target, 'utf8'));
        return { ok, how: ok ? `file written, ${size} bytes, content exact` : `exit=${r.code ?? r.sig} exists=${exists} size=${size}` };
      } finally { await mock.close(); }
    },
  },
  {
    row: 'A1',
    what: 'config survives relaunch (the 0-byte ~/.claude.json class)',
    async fn(sbx) {
      const cfg = path.join(sbx.home, '.claude.json');
      const mock = await startMock([{ text: 'PONG' }]);
      try {
        for (const pass of [1, 2]) {
          const r = await run(BIN, ['-p', 'say PONG'], { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
          if (r.code !== 0) return { ok: false, how: `pass ${pass} exit=${r.code ?? r.sig}` };
          const size = fs.existsSync(cfg) ? fs.statSync(cfg).size : 0;
          if (size === 0) return { ok: false, how: `after pass ${pass} the config is ${size} bytes (0-byte class)` };
          let parsed;
          try { parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')); }
          catch (e) { return { ok: false, how: `after pass ${pass} the config does not parse: ${e.message}` }; }
          // NOT `theme`: a -p run legitimately rewrites this file and drops it —
          // the UPSTREAM binary does exactly the same (203 -> 30520 bytes, theme
          // undefined), so asserting theme would fail a healthy build. What must
          // survive is the settings the user established: onboarding state and
          // the per-project trust entry.
          if (parsed.hasCompletedOnboarding !== true) return { ok: false, how: `after pass ${pass} hasCompletedOnboarding is ${JSON.stringify(parsed.hasCompletedOnboarding)}` };
          if (!parsed.projects || !parsed.projects[sbx.cwd]) return { ok: false, how: `after pass ${pass} the project entry for the cwd is gone` };
        }
        return { ok: true, how: 'config non-zero, parses, onboarding + project trust survive a second launch' };
      } finally { await mock.close(); }
    },
  },
];

// B4 (Bash, Edit, Write, Grep round-trips) and D1 (/quit exits cleanly) are NOT
// probed here, deliberately. B4 needs all four tools driven, not a subset — a
// partial pass would be a false claim on the row as written. D1 is interactive
// and needs a pty on the target, which is the `--quaude-floor` self-probe idea.
// Silence is the honest answer for both; the ledger keeps showing them missing.

const today = new Date().toISOString().slice(0, 10);
// The ledger records WHICH artifact was driven; a row that cannot say is not
// evidence. --engine/--bundle override for a naude or a non-default bundle.
const flag = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
const ENGINE = flag('--engine', 'quaude');
const BUNDLE = flag('--bundle', (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'deps', 'claude', 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
})());

(async () => {
  const results = [];
  for (const c of CHECKS) {
    const sbx = sandbox();
    let r;
    try { r = await c.fn(sbx); }
    catch (e) { r = { ok: false, how: `probe threw: ${e && e.message}` }; }
    finally { sbx.drop(); }
    results.push({ row: c.row, verdict: r.ok ? 'pass' : 'fail', how: r.how, what: c.what });
    if (!AS_JSON) console.error(`  ${c.row} ${r.ok ? 'pass' : 'FAIL'} — ${r.how}`);
  }

  if (AS_JSON) { console.log(JSON.stringify({ runTarget: RUN_TARGET, date: today, results }, null, 2)); return; }

  // RESULTS.md's parser reads exactly these seven columns, in this order.
  console.log('\n# paste into test/fidelity/RESULTS.md (newest rows win per row+run-target)\n');
  for (const r of results) {
    console.log(`| ${today} | ${RUN_TARGET} | ${r.row} | ${ENGINE} | ${BUNDLE} | ${r.verdict} | floor-probe: ${r.how} |`);
  }
  const failed = results.filter((r) => r.verdict === 'fail');
  console.error(`\nfloor-probe: ${results.length - failed.length}/${results.length} pass on ${RUN_TARGET}`);
  process.exit(failed.length ? 1 : 0);
})();
