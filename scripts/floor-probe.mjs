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
//   node scripts/floor-probe.mjs <remote-binary> <run-target> \\
//        --ssh 'ssh -p 2230 user@localhost' [--mock-host 10.0.2.2]
//
// --ssh drives a binary on ANOTHER box; the probe itself still runs here. That
// is what makes node-less targets reachable — Tiger/PPC, NetBSD and Ubuntu VMs
// all have no node, so a probe that had to execute THERE could never run. The
// canned mock then binds 0.0.0.0 and the guest reaches it at --mock-host (for
// qemu user-mode networking the host is 10.0.2.2, verified reachable from all
// three guests).
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
// In --ssh mode BIN names a path on the TARGET box, so a local stat would be
// wrong (and would reject every remote run). It is checked over the wire below.
if (!process.argv.includes('--ssh') && !fs.existsSync(BIN)) {
  console.error(`floor-probe: no such binary: ${BIN}`); process.exit(2);
}

const flagOf = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
const SSH = flagOf('--ssh', null);              // e.g. "ssh -p 2230 user@localhost"
const MOCK_HOST = flagOf('--mock-host', SSH ? '10.0.2.2' : '127.0.0.1');
const SCALE = Number(process.env.CLODE_TIMEOUT_SCALE || 1);
// Single-quote for /bin/sh: the guests include Darwin 8 (2005), so nothing
// bash-only and nothing that assumes GNU coreutils flags.
const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
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
  const bindAddr = SSH ? '0.0.0.0' : '127.0.0.1';
  return new Promise((ok) => server.listen(0, bindAddr, () => ok({
    url: `http://${MOCK_HOST}:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  })));
}

// ---- remote execution -------------------------------------------------------
// Everything the checks need from the target box, expressed as /bin/sh so it
// works on Darwin 8 as well as NetBSD and Linux. The probe stays here; only
// these primitives cross the wire.
function sshRun(script) {
  return new Promise((resolve) => {
    const parts = SSH.split(/\s+/);
    let out = '', err = '';
    // The script goes over STDIN, never as an argv tail: on Windows the login
    // shell is cmd.exe, which re-parses quoting and mangled every script that
    // contained quotes or spaces. Piping means --ssh must name a shell that
    // READS stdin — `... host sh` on unix, `... host C:\PROGRA~1\Git\bin\bash.exe -s`
    // for Git Bash (the 8.3 path dodges the space in "Program Files").
    const c = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    try { c.stdin.write(script); c.stdin.end(); } catch { /* closed early */ }
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } }, TIMEOUT);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code, sig) => { clearTimeout(timer); resolve({ code, sig, out, err }); });
    c.on('error', (e) => { clearTimeout(timer); resolve({ code: null, sig: null, out, err: String(e) }); });
  });
}
const R = {
  async mkdirp(d) { await sshRun(`mkdir -p ${sq(d)}`); },
  async writeFile(f, body) {
    // base64 avoids every quoting hazard for JSON payloads. -d on GNU/NetBSD,
    // -D on Darwin 8's older base64; try both.
    const b64 = Buffer.from(body, 'utf8').toString('base64');
    await sshRun(`printf %s ${sq(b64)} | { base64 -d 2>/dev/null || base64 -D; } > ${sq(f)}`);
  },
  async readFile(f) { const r = await sshRun(`cat ${sq(f)} 2>/dev/null`); return r.out; },
  async size(f) { const r = await sshRun(`wc -c < ${sq(f)} 2>/dev/null || echo 0`); return Number(String(r.out).trim()) || 0; },
  async exists(f) { const r = await sshRun(`test -e ${sq(f)} && echo y || echo n`); return String(r.out).trim() === 'y'; },
  async rm(d) { await sshRun(`rm -rf ${sq(d)}`); },
};

function run(bin, args, { home, cwd, extraEnv }) {
  if (SSH) {
    // On Windows the bundle resolves its profile from USERPROFILE, NOT HOME. With
    // only HOME set, every "sandboxed" run silently used the operator's REAL
    // C:/Users/<them>/.claude — which also makes A1 pass for the wrong reason (the
    // bundle writes to the real profile while we check the untouched sandbox file).
    const winHome = _winNative || home;
    const baseEnv = _isWinGuest
      ? { HOME: home, USERPROFILE: winHome, HOMEDRIVE: winHome.slice(0, 2), HOMEPATH: winHome.slice(2),
          ANTHROPIC_API_KEY: 'sk-ant-floor-probe' }
      : { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-floor-probe' };
    const envStr = Object.entries({ ...baseEnv, ...extraEnv })
      .map(([k, v]) => `${k}=${sq(v)}`).join(' ');
    const argStr = args.map(sq).join(' ');
    // NODE_PATH is never exported here, so a pass still proves self-containment.
    return sshRun(`cd ${sq(cwd)} && ${envStr} ${sq(bin)} ${argStr} < /dev/null`);
  }
  return runLocal(bin, args, { home, cwd, extraEnv });
}

function runLocal(bin, args, { home, cwd, extraEnv }) {
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

async function sandbox() {
  if (SSH) {
    // A deterministic path under $HOME, not mktemp -d: Darwin 8's mktemp
    // predates the flags the modern one takes, and this has to work there too.
    const base = `floor-probe-${process.pid}-${Math.abs(Date.now() % 100000)}`;
    const r = await sshRun(`printf %s "$HOME"`);
    const guestHome = String(r.out).trim() || '/tmp';
    const dir = `${guestHome}/${base}`;
    const home = `${dir}/home`;
    const cwd0 = `${dir}/work`;
    await R.mkdirp(home); await R.mkdirp(cwd0);
    // Resolve the cwd the way the target itself will see it — the trust key must
    // match exactly (on darwin /var vs /private/var differ).
    const rp = await sshRun(`cd ${sq(cwd0)} && pwd -P`);
    const cwd = String(rp.out).trim() || cwd0;
    // On a Git-Bash/MSYS guest the SHELL path (/c/Users/...) is not what the
    // NATIVE target process sees: quaude.exe reads it as drive-relative and
    // writes to C:\c\Users\... instead. Tool inputs and the trust key must use
    // the Windows form; only our own shell checks use the /c form. (Found the
    // hard way: C1 "failed" while the file sat, correct, at the mangled path.)
    const un = String((await sshRun('uname -s')).out).trim();
    _isWinGuest = /^(MINGW|MSYS|CYGWIN)/i.test(un);
    let cwdNative = cwd;
    if (/^(MINGW|MSYS|CYGWIN)/i.test(un)) {
      const cp = await sshRun(`cygpath -w ${sq(cwd)} 2>/dev/null || echo ${sq(cwd)}`);
      cwdNative = String(cp.out).trim() || cwd;
      const hp = await sshRun(`cygpath -w ${sq(home)} 2>/dev/null || echo ${sq(home)}`);
      _winNative = String(hp.out).trim() || home;
    }
    const sentinel = `floor-probe-sentinel-${process.pid}`;
    await R.writeFile(`${home}/.claude.json`, JSON.stringify({
      _floorProbeSentinel: sentinel,
      hasCompletedOnboarding: true,
      projects: { [cwdNative]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }));
    return { dir, home, cwd, cwdNative, sentinel, remote: true,
      exists: (f) => R.exists(f), size: (f) => R.size(f), read: (f) => R.readFile(f),
      drop: () => R.rm(dir) };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-probe-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'work-')));
  const sentinel = `floor-probe-sentinel-${process.pid}`;
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    _floorProbeSentinel: sentinel,
    hasCompletedOnboarding: true,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  return { dir, home, cwd, cwdNative: cwd, sentinel, remote: false,
    exists: async (f) => fs.existsSync(f), size: async (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0),
    read: async (f) => fs.readFileSync(f, 'utf8'),
    drop: async () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

// Set by sandbox() once the guest kind is known; run() needs them.
let _isWinGuest = false, _winNative = null;

// ---- GUARD 1: prove the sandbox was actually USED ---------------------------
// Every row here is only meaningful if the target read OUR profile. On Windows it
// did not: the bundle resolves USERPROFILE, we set only HOME, and the runs
// silently used the operator's real ~/.claude — A1 then "passed" because the
// bundle wrote to the REAL profile while we checked our untouched sandbox copy.
// A green that survives its own sandbox being ignored is not evidence. So: stamp
// a unique sentinel into the sandbox config, and after a run REQUIRE that the
// target rewrote that file (the bundle always rewrites .claude.json on startup).
// If it did not, the run is VOID and reported as such — never as a pass.
async function sandboxWasUsed(sbx) {
  const cfg = `${sbx.home}/.claude.json`;
  const size = await sbx.size(cfg);
  if (!size) return { used: false, why: 'sandbox .claude.json is missing or empty after the run' };
  let txt = '';
  try { txt = await sbx.read(cfg); } catch { /* */ }
  if (txt.includes(sbx.sentinel) && txt.length < 400) {
    return { used: false, why: `the target never rewrote the sandbox profile (still the ${txt.length}-byte seed) — it almost certainly used a DIFFERENT profile dir` };
  }
  return { used: true };
}

const posted = (mock) => mock.requests.some((q) => q.method === 'POST' && /\/messages/.test(q.url));

// ---- the checks. Each maps to ONE RECIPE floor row. ------------------------
// GUARD 2: exercise the tmpdir-ownership guard every time. The bundle only
// checks /tmp/claude-<uid> when it EXISTS, so on a fresh box the check silently
// does not run — which is exactly how netbsd-arm64 scored 6/6 this morning on an
// engine that cannot satisfy it (no uid/gid from FSS.stat). Pre-creating the
// directory, owned by us, removes the luck: either the target reads ownership
// correctly or every row fails, consistently, on every run.
async function armTmpdirGuard(sbx) {
  if (_isWinGuest) return;                       // POSIX-only guard
  if (sbx.remote) { await sshRun('mkdir -p "/tmp/claude-$(id -u)" 2>/dev/null || true'); return; }
  try { fs.mkdirSync(path.join(os.tmpdir(), `claude-${process.getuid()}`), { recursive: true }); } catch { /* */ }
}

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
      const target = `${sbx.cwd}/floor-write.txt`;                       // for OUR checks
      const targetNative = `${sbx.cwdNative}${sbx.cwdNative.includes('\\') ? '\\' : '/'}floor-write.txt`;  // for the TOOL
      const mock = await startMock([
        { match: ID, text: 'written' },
        { tool: { name: 'Write', input: { file_path: targetNative, content: 'FLOOR-WRITE-OK\n' }, id: ID } },
      ]);
      try {
        const r = await run(BIN, ['-p', 'write it', '--permission-mode', 'bypassPermissions'],
          { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
        const exists = await sbx.exists(target);
        const size = exists ? await sbx.size(target) : 0;
        const ok = r.code === 0 && exists && size > 0 && /FLOOR-WRITE-OK/.test(await sbx.read(target));
        return { ok, how: ok ? `file written, ${size} bytes, content exact` : `exit=${r.code ?? r.sig} exists=${exists} size=${size}` };
      } finally { await mock.close(); }
    },
  },
  {
    row: 'A1',
    what: 'config survives relaunch (the 0-byte ~/.claude.json class)',
    async fn(sbx) {
      const cfg = `${sbx.home}/.claude.json`;
      const mock = await startMock([{ text: 'PONG' }]);
      try {
        for (const pass of [1, 2]) {
          const r = await run(BIN, ['-p', 'say PONG'], { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
          if (r.code !== 0) return { ok: false, how: `pass ${pass} exit=${r.code ?? r.sig}` };
          const size = await sbx.size(cfg);
          if (size === 0) return { ok: false, how: `after pass ${pass} the config is ${size} bytes (0-byte class)` };
          let parsed;
          try { parsed = JSON.parse(await sbx.read(cfg)); }
          catch (e) { return { ok: false, how: `after pass ${pass} the config does not parse: ${e.message}` }; }
          // NOT `theme`: a -p run legitimately rewrites this file and drops it —
          // the UPSTREAM binary does exactly the same (203 -> 30520 bytes, theme
          // undefined), so asserting theme would fail a healthy build. What must
          // survive is the settings the user established: onboarding state and
          // the per-project trust entry.
          if (parsed.hasCompletedOnboarding !== true) return { ok: false, how: `after pass ${pass} hasCompletedOnboarding is ${JSON.stringify(parsed.hasCompletedOnboarding)}` };
          // Key on the NATIVE form — the same one seeded into the config, which is
          // what the target process sees (they differ on a Git-Bash guest).
          if (!parsed.projects || !parsed.projects[sbx.cwdNative]) return { ok: false, how: `after pass ${pass} the project entry for ${sbx.cwdNative} is gone` };
        }
        return { ok: true, how: 'config non-zero, parses, onboarding + project trust survive a second launch' };
      } finally { await mock.close(); }
    },
  },
  {
    row: 'B4',
    what: 'agentic tool round-trips (Bash, Edit, Write, Grep) produce the correct client-observable',
    async fn(sbx) {
      // One chained conversation exercising all FOUR tools the row names. Each
      // rule fires on the tool_result id of the PREVIOUS step, so the mock walks
      // the agentic loop the way a real turn does. Read sits between Write and
      // Edit because the bundle requires a read before it will edit.
      const sep = sbx.cwdNative.includes('\\') ? '\\' : '/';
      const f = `${sbx.cwdNative}${sep}b4.txt`;
      const shell = `${sbx.cwd}/b4.txt`;                 // OUR view, for checks
      const ids = { w: 'toolu_b4_w', r: 'toolu_b4_r', e: 'toolu_b4_e', g: 'toolu_b4_g', b: 'toolu_b4_b' };
      const mock = await startMock([
        { match: ids.b, text: 'all four done' },
        { match: ids.g, tool: { name: 'Bash', input: { command: 'echo B4-BASH-OK' }, id: ids.b } },
        { match: ids.e, tool: { name: 'Grep', input: { pattern: 'B4-EDITED', path: sbx.cwdNative }, id: ids.g } },
        { match: ids.r, tool: { name: 'Edit', input: { file_path: f, old_string: 'B4-ORIGINAL', new_string: 'B4-EDITED' }, id: ids.e } },
        { match: ids.w, tool: { name: 'Read', input: { file_path: f }, id: ids.r } },
        { tool: { name: 'Write', input: { file_path: f, content: 'B4-ORIGINAL\n' }, id: ids.w } },
      ]);
      try {
        const r = await run(BIN, ['-p', 'do the tool chain', '--permission-mode', 'bypassPermissions'],
          { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });
        const body = mock.requests.map((q) => q.body || '').join('\n');
        const content = (await sbx.exists(shell)) ? await sbx.read(shell) : '';
        const wrote = /B4-/.test(content);                        // Write landed
        const edited = /B4-EDITED/.test(content);                 // Edit applied on disk
        const grepped = body.includes(ids.g) && /b4\.txt|B4-EDITED/.test(body);
        const bashed = body.includes('B4-BASH-OK');               // Bash output came back
        const ok = r.code === 0 && wrote && edited && grepped && bashed;
        return { ok, how: ok
          ? 'Write+Read+Edit+Grep+Bash all round-tripped; file reads B4-EDITED on disk'
          : `exit=${r.code ?? r.sig} wrote=${wrote} edited=${edited} grepped=${grepped} bashed=${bashed}` };
      } finally { await mock.close(); }
    },
  },
];

// D1 (/quit exits cleanly) is NOT probed here: it is interactive and needs a pty
// on the target. scripts/../remote-tui.cjs (ssh -tt) and a local node-pty driver
// cover it instead; this probe stays silent rather than claim a row it cannot
// actually demonstrate.

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
    const sbx = await sandbox();
    await armTmpdirGuard(sbx);
    let r;
    try {
      r = await c.fn(sbx);
      // GUARD 1 applied: a row is only evidence if the target used OUR profile.
      const u = await sandboxWasUsed(sbx);
      if (!u.used) r = { ok: false, void: true, how: `VOID — ${u.why}` };
    } catch (e) { r = { ok: false, how: `probe threw: ${e && e.message}` }; }
    finally { await sbx.drop(); }
    const verdict = r.ok ? 'pass' : (r.void ? 'void' : 'fail');
    results.push({ row: c.row, verdict, how: r.how, what: c.what });
    if (!AS_JSON) console.error(`  ${c.row} ${verdict.toUpperCase()} — ${r.how}`);
  }

  if (AS_JSON) { console.log(JSON.stringify({ runTarget: RUN_TARGET, date: today, results }, null, 2)); return; }

  // RESULTS.md's parser reads exactly these seven columns, in this order.
  console.log('\n# paste into test/fidelity/RESULTS.md (newest rows win per row+run-target)\n');
  for (const r of results) {
    console.log(`| ${today} | ${RUN_TARGET} | ${r.row} | ${ENGINE} | ${BUNDLE} | ${r.verdict} | floor-probe: ${r.how} |`);
  }
  // A VOID row is not a failure of the TARGET — it is a failure of this probe to
  // measure. It must never be pasted into the ledger, so exit nonzero and say so.
  const voided = results.filter((r) => r.verdict === 'void');
  if (voided.length) {
    console.error(`\nfloor-probe: ${voided.length} row(s) VOID — the harness could not measure. Do NOT file these rows.`);
  }
  const failed = results.filter((r) => r.verdict === 'fail' || r.verdict === 'void');
  console.error(`\nfloor-probe: ${results.length - failed.length}/${results.length} pass on ${RUN_TARGET}`);
  process.exit(failed.length ? 1 : 0);
})();
