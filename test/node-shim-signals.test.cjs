'use strict';
// process.kill + signal delivery characterization (quaude Ctrl-Z bug): the
// bundle's suspend path runs `process.on("SIGCONT", resume); process.kill(0,
// "SIGTSTP")` — with no process.kill the TypeError lands after the "has been
// suspended" message and the process never stops. Its background-task
// supervision also probes liveness with `process.kill(pid, 0)` all over.
// Three contracts, exercised against the real tjs binary:
//   1. process.kill(self, 'SIGSTOP') actually STOPS the process (ps state T)
//      and a later SIGCONT resumes it, firing the process.on('SIGCONT')
//      handler (delivery wired, not registry-only). SIGSTOP, not SIGTSTP:
//      the test child runs in an ORPHANED process group (no job-control
//      shell above it), where POSIX discards the tty stop signals
//      (SIGTSTP/SIGTTIN/SIGTTOU) — observed empirically: the child stayed
//      runnable. SIGSTOP stops unconditionally, exercising the same
//      kill(2)-delivery + SIGCONT-dispatch path our code owns; the real
//      SIGTSTP flow needs a job-control shell and is covered by the quaude
//      PTY end-to-end verification.
//   2. process.kill(pid, 0) is a liveness probe: self → ok, dead pid → ESRCH.
//   3. an externally sent signal reaches a process.on handler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

const writeProg = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-signals-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
};

// Spawn PROG under tjs+loader; collect stdout lines; return helpers.
function spawnLoader(prog, args = []) {
  const child = spawn(tjsPath(), ['run', LOADER, prog, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const waitFor = (pred, ms, what) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${what}; out=${JSON.stringify(out)} err=${JSON.stringify(err)}`)); }
    }, 50);
  });
  const state = () => {
    const r = spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : 'GONE';
  };
  return { child, exited, waitFor, state, getOut: () => out, getErr: () => err };
}

test('process.kill(self, SIGSTOP) stops the process; SIGCONT resumes and fires the handler', async (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = writeProg('stopcont.cjs', `
process.on('SIGCONT', () => { console.log('resumed'); process.exit(0); });
console.log('ready');
process.kill(process.pid, 'SIGSTOP');
setInterval(() => {}, 1000);            // keep the loop alive to dispatch SIGCONT
setTimeout(() => process.exit(3), 8000); // fail-safe: resume handler never fired
`);
  const s = spawnLoader(prog);
  try {
    await s.waitFor(() => s.getOut().includes('ready'), 5000, 'ready');
    await s.waitFor(() => s.state().startsWith('T'), 5000, `stopped state T (state=${s.state()})`);
    process.kill(s.child.pid, 'SIGCONT');
    const { code } = await Promise.race([
      s.exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`no exit after SIGCONT; out=${s.getOut()}`)), 5000)),
    ]);
    assert.strictEqual(code, 0, s.getErr());
    assert.match(s.getOut(), /resumed/);
  } finally {
    try { s.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('process.kill(pid, 0) is a liveness probe: self ok, dead pid ESRCH', async (t) => {
  if (skipUnlessTjs(t)) return;
  // A freshly dead pid from the host side (reuse within the test window is
  // vanishingly unlikely).
  const dead = spawnSync('true').pid ?? (() => { throw new Error('no pid'); })();
  const prog = writeProg('probe.cjs', `
const out = [];
process.kill(process.pid, 0); out.push('self:ok');
try { process.kill(Number(process.argv[2]), 0); out.push('dead:ok'); }
catch (e) { out.push('dead:' + e.code); }
console.log(out.join(' '));
`);
  const r = spawnSync(tjsPath(), ['run', LOADER, prog, String(dead)],
    { encoding: 'utf8', env: process.env, timeout: 8000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'self:ok dead:ESRCH');
});

test('externally sent SIGUSR2 reaches a process.on handler', async (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = writeProg('usr2.cjs', `
process.on('SIGUSR2', () => { console.log('got SIGUSR2'); process.exit(0); });
console.log('ready');
setInterval(() => {}, 1000);            // keep alive
setTimeout(() => process.exit(3), 6000); // fail-safe: delivery never came
`);
  const s = spawnLoader(prog);
  try {
    await s.waitFor(() => s.getOut().includes('ready'), 5000, 'ready');
    execFileSync('kill', ['-USR2', String(s.child.pid)]);
    const { code } = await Promise.race([
      s.exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`no exit; out=${s.getOut()}`)), 8000)),
    ]);
    assert.strictEqual(code, 0, `expected handler exit 0, got ${code}; out=${s.getOut()} err=${s.getErr()}`);
    assert.match(s.getOut(), /got SIGUSR2/);
  } finally {
    try { s.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});
