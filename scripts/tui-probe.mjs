#!/usr/bin/env node
// TUI probe — drive a built quaude interactively under a REAL pty and report
// RECIPE row D1 (/quit exits cleanly).
//
// Companion to scripts/floor-probe.mjs, which covers A1/B1/B4/C1/G7 by driving
// `-p`. D1 cannot be reached that way: "/quit exits cleanly" is a property of the
// interactive TUI, and the bug it guards (the O_NONBLOCK sync-open wedge) only
// shows up with a controlling terminal. This lived as a scratch file for a while
// and was lost to temp reaping, which made D1 needlessly expensive to re-establish
// — hence it is committed.
//
//   node scripts/tui-probe.mjs --bin <path>                       # this box
//   node scripts/tui-probe.mjs --bin <remote-path> \
//        --ssh 'ssh -tt -p 2230 user@host sh' --mock-host 10.0.2.2
//
// HERMETIC and OFFLINE: a canned mock served from HERE. No credentials anywhere;
// the target only ever sees a dummy key.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const A = process.argv.slice(2);
const flag = (n, d) => { const i = A.indexOf(n); return i >= 0 ? A[i + 1] : d; };
const BIN = flag('--bin');
const SSHCMD = flag('--ssh', null);
const LABEL = flag('--label', SSHCMD ? 'remote' : 'local');
const BUNDLE = flag('--bundle', 'unknown');
const MOCK_HOST = flag('--mock-host', SSHCMD ? '10.0.2.2' : '127.0.0.1');
const WIN = A.includes('--windows');
if (!BIN) { console.error('usage: tui-probe.mjs --bin <path> [--ssh "ssh -tt host sh"] [--mock-host IP] [--windows]'); process.exit(64); }

const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
const sse = (text) =>
  ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
  + ev('message_stop', { type: 'message_stop' });

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEEDLE = 'TUIPONG';

function startMock() {
  const requests = [];
  const srv = http.createServer((q, r) => {
    const c = []; q.on('data', (d) => c.push(d));
    q.on('end', () => {
      requests.push({ method: q.method, url: q.url });
      if (q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])) {
        r.writeHead(200, { 'content-type': 'text/event-stream' }); r.end(sse(NEEDLE));
      } else { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{}'); }
    });
  });
  return new Promise((ok) => srv.listen(0, SSHCMD ? '0.0.0.0' : '127.0.0.1', () => ok({
    port: srv.address().port, requests, close: () => new Promise((z) => srv.close(z)),
  })));
}

// The profile the TUI needs to reach its prompt. customApiKeyResponses is NOT
// optional: without the key pre-approved (last 20 chars, as the bundle stores it)
// the TUI stops on "Do you want to use this API key?" and swallows every
// keystroke — which reads exactly like a hang.
const profile = (cwdKey) => JSON.stringify({
  hasCompletedOnboarding: true,
  customApiKeyResponses: { approved: ['sk-ant-tui'], rejected: [] },
  projects: { [cwdKey]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
});

function sshPipe(parts, script) {
  return new Promise((res) => {
    let o = '';
    const c = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    try { c.stdin.write(script); c.stdin.end(); } catch { /* */ }
    c.stdout.on('data', (d) => { o += d; });
    c.on('exit', () => res(o)); c.on('error', () => res(o));
  });
}

(async () => {
  const mock = await startMock();
  const url = `http://${MOCK_HOST}:${mock.port}`;
  let screen = '', exited = null, child, cleanup = async () => {};

  if (SSHCMD) {
    const parts = SSHCMD.split(/\s+/);
    const setup = parts.filter((p) => p !== '-tt');
    const base = `tui-probe-${process.pid}`;
    const out = await sshPipe(setup, `
      H="$HOME/${base}/home"; W="$HOME/${base}/work"; mkdir -p "$H" "$W"
      CWD=$(cd "$W" && pwd -P)
      ${WIN ? 'CWDN=$(cygpath -w "$CWD" 2>/dev/null || echo "$CWD"); HN=$(cygpath -w "$H" 2>/dev/null || echo "$H")' : 'CWDN="$CWD"; HN="$H"'}
      echo "READY $H $CWD $CWDN $HN"
    `);
    const m = /READY (\S+) (\S+) (\S+) (\S+)/.exec(out);
    if (!m) { console.log(JSON.stringify({ error: 'setup failed', out: out.slice(0, 200) })); await mock.close(); process.exit(1); }
    const [, home, cwd, cwdNative, homeNative] = m;
    const b64 = Buffer.from(profile(cwdNative), 'utf8').toString('base64');
    // base64, not shell-quoted JSON: a Windows path in JSON meets too many
    // quoting layers and silently produces an unparseable profile, which the
    // bundle ignores (both the trust AND api-key dialogs then appear).
    await sshPipe(setup, `printf %s ${sq(b64)} | { base64 -d 2>/dev/null || base64 -D; } > ${sq(`${home}/.claude.json`)}\n`);
    // On Windows the bundle reads USERPROFILE, not HOME: set only HOME and the
    // run silently uses the operator's REAL profile.
    const envs = WIN
      ? `HOME=${sq(home)} USERPROFILE=${sq(homeNative)} HOMEDRIVE=${sq(homeNative.slice(0, 2))} HOMEPATH=${sq(homeNative.slice(2))}`
      : `HOME=${sq(home)}`;
    const runSh = `${home}/../run.sh`;
    // Run BY PATH: an argv tail is re-parsed by cmd.exe on Windows, and stdin is
    // needed for keystrokes so `bash -s` cannot carry the script either.
    await sshPipe(setup, `cat > ${sq(runSh)} <<'__EOF__'\ncd ${sq(cwd)} && ${envs} ANTHROPIC_BASE_URL=${sq(url)} ANTHROPIC_API_KEY='sk-ant-tui' TERM=xterm-256color exec ${sq(BIN)}\n__EOF__\nchmod +x ${sq(runSh)}\n`);
    const runParts = parts.filter((p, i) => !(p === '-s' && i === parts.length - 1));
    child = spawn(runParts[0], [...runParts.slice(1), runSh], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { screen += d; });
    child.stderr.on('data', (d) => { screen += d; });
    child.on('exit', (code) => { exited = { code, at: Date.now() }; });
    cleanup = async () => { await sshPipe(setup, `rm -rf ${sq(`${home}/..`)}\n`); };
  } else {
    const require_ = createRequire(import.meta.url);
    const { harnessDir } = require_(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'platform-tag.cjs'));
    const pty = require_(path.join(harnessDir(path.join(path.dirname(new URL(import.meta.url).pathname), '..')), 'node_modules', 'node-pty'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-probe-'));
    const home = path.join(dir, 'home'); fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'work-')));
    fs.writeFileSync(path.join(home, '.claude.json'), profile(cwd));
    child = pty.spawn(BIN, [], { name: 'xterm-256color', cols: 100, rows: 30, cwd,
      env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-tui', TERM: 'xterm-256color' } });
    child.onData((d) => { screen += d; });
    child.onExit((e) => { exited = { code: e.exitCode, at: Date.now() }; });
    child.stdin = { write: (s) => child.write(s) };
    cleanup = async () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };
  }

  const write = (s) => (child.stdin ? child.stdin.write(s) : child.write(s));
  await sleep(SSHCMD ? 22000 : 12000);
  const bootLen = screen.length;
  write(`reply with only the word ${NEEDLE}`);
  await sleep(1200);
  write('\r');
  await sleep(SSHCMD ? 30000 : 20000);
  const afterTurn = screen;

  const quitAt = Date.now();
  write('/quit'); await sleep(900); write('\r');
  const deadline = Date.now() + 30000;
  while (!exited && Date.now() < deadline) await sleep(400);
  if (!exited) { try { child.kill ? child.kill('SIGKILL') : child.kill(); } catch { /* */ } }

  const clean = (s) => s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  const flat = clean(afterTurn);
  const today = new Date().toISOString().slice(0, 10);
  const ok = !!exited && exited.code === 0 && /TUIPONG/.test(flat);
  const how = ok
    ? `TUI booted, turn answered ${NEEDLE} against the canned mock, /quit exited CLEANLY code 0 in ${exited.at - quitAt}ms`
    : `boot=${/Claude Code|❯/.test(clean(afterTurn.slice(0, bootLen)))} turn=${/TUIPONG/.test(flat)} exited=${!!exited} code=${exited ? exited.code : 'n/a'}`;

  console.error(`  D1 ${ok ? 'PASS' : 'FAIL'} — ${how}`);
  console.log(`| ${today} | ${LABEL} | D1 | quaude | ${BUNDLE} | ${ok ? 'pass' : 'fail'} | tui-probe${SSHCMD ? ' over ssh -tt' : ' (node-pty)'}: ${how} |`);

  await cleanup(); await mock.close();
  process.exit(ok ? 0 : 1);
})();
