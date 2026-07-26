'use strict';
// Ctrl-Z / SIGTSTP under a REAL PTY: the genuine job-control path node-shim-signals.test.cjs
// deliberately does NOT exercise (that file's own comment: its child runs in an
// orphaned process group with no controlling terminal, where POSIX discards
// SIGTSTP — so it substitutes SIGSTOP, which is delivery-equivalent for the
// process.kill(0,"SIGTSTP") + process.on('SIGCONT') wiring but is NOT the
// keystroke path). This test drives a real pseudo-terminal (node-pty, the same
// harness test/tui-screen.cjs uses), sends the actual Ctrl-Z byte (0x1a / VSUSP),
// and lets the PTY's own line discipline generate SIGTSTP — the exact mechanism a
// real terminal uses, no manual `kill -TSTP` substitution. Verifies: (1) the
// process ACTUALLY stops (ps state T) from that keystroke, matching a real Ctrl-Z;
// (2) a SIGCONT (what a shell's `fg` sends) resumes it and fires the bundle's
// process.on('SIGCONT') resume handler.
//
// Why the child runs under `/bin/sh -mc`, not tjs directly (characterized
// 2026-07-26 on NetBSD): node-pty's forkpty makes the spawned command a SESSION
// LEADER, and its process group is therefore ORPHANED (node-pty, the parent, is
// in a different session). POSIX requires the kernel to DISCARD job-control stop
// signals (SIGTSTP/SIGTTIN/SIGTTOU) sent to an orphaned process group — so on a
// strict kernel like NetBSD a Ctrl-Z keystroke to a bare tjs/sleep/cat child is
// silently dropped and it never stops. That is not a quaude/tjs defect and not a
// "sandbox lacks plumbing" limitation (both earlier theories were wrong); it is
// the same reason a login shell — never the bare command — owns the terminal
// session. So we reproduce a login shell: spawn `sh -m` (monitor/job-control
// mode), which forks the real command into its OWN foreground process group with
// the shell as a living parent in the same session. That group is NOT orphaned,
// so the line discipline's SIGTSTP is delivered — genuine keystroke job control,
// no privileged rig required.
//
// Two shell details matter. (1) The command is a LIST (`"$@"; …`), not a single
// word: ash exec-optimizes `sh -c '<one command>'` by replacing itself with the
// command, which would make the job the session leader again and re-orphan it — a
// second statement forces a real fork. (2) After the list's first statement the
// shell PARKS (`while :; do sleep 1; done`) instead of exiting. In monitor mode a
// foreground wait returns when the job merely STOPS (not only when it exits); if
// the shell exited there, the still-stopped job's group would become orphaned and
// the kernel would auto-SIGCONT it (a stopped orphaned group is sent SIGHUP+SIGCONT)
// — so the parked shell stays alive as the job's living, same-session parent, which
// is exactly what keeps the job cleanly stopped until a real SIGCONT (`fg`) resumes it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

function loadPty() {
  const REPO = path.resolve(__dirname, '..');
  try {
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    return require(path.join(harnessDir(REPO), 'node_modules', 'node-pty'));
  } catch {
    return require('node-pty');
  }
}

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlz-pty-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, body);
  return f;
}

function psState(pid) {
  const r = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'GONE';
}

// The job we care about is the shell's sole child (the tjs process), not the
// shell (child.pid) that node-pty tracks. Match on the pid/ppid columns only —
// NOT args: NetBSD ps truncates the (long) command line, so an argv needle at the
// tail gets cut off. Separate `-o` flags are required: in BSD ps a `-o col=`
// consumes the REST of that argument as the column header, so `-o pid=,ppid=`
// collapses to a single column. The monitor-mode shell has exactly one child
// while the job runs.
function jobPid(shellPid) {
  const r = spawnSync('ps', ['-axo', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m && Number(m[2]) === shellPid) return Number(m[1]);
  }
  return null;
}

function waitFor(pred, ms, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${typeof what === 'function' ? what() : what}`)); }
    }, 50);
  });
}

test('Ctrl-Z (real PTY keystroke) SIGTSTPs a tjs child; SIGCONT resumes and fires the handler', async (t) => {
  if (skipUnlessTjs(t)) return;
  // node-pty is a REQUIRED harness dep (run.mjs builds it, patching platforms
  // upstream omits) — a load failure here is a real failure, not a skip.
  const pty = loadPty();

  const prog = writeProg(`
process.on('SIGCONT', () => { console.log('RESUMED'); process.exit(0); });
console.log('READY');
setInterval(() => {}, 1000);
setTimeout(() => process.exit(3), 10000); // fail-safe: resume handler never fired
`);

  let out = '';
  // Run the tjs child under a job-control shell so its process group is not
  // orphaned, and PARK the shell after the job returns (see file header);
  // node-pty's child.pid tracks the shell, the tjs job is its child.
  const child = pty.spawn('/bin/sh', ['-mc', '"$@"; while :; do sleep 1; done', 'sh', tjsPath(), 'run', LOADER, prog], {
    name: 'xterm-256color', cols: 80, rows: 24, env: process.env,
  });
  child.onData((d) => { out += d; });

  let job = null;
  try {
    await waitFor(() => out.includes('READY'), 5000, `READY (got ${JSON.stringify(out)})`);
    await waitFor(() => (job = jobPid(child.pid)) !== null, 5000, 'the tjs job pid under the shell');
    // The real keystroke: the PTY line discipline turns this into SIGTSTP for
    // the foreground process group — not a manual kill -TSTP.
    child.write('\x1a');
    await waitFor(() => psState(job).startsWith('T'), 5000,
      () => `stopped state T after Ctrl-Z (state=${psState(job)}, out=${JSON.stringify(out)})`);
    // What a shell's `fg` does to resume a stopped job.
    process.kill(job, 'SIGCONT');
    await waitFor(() => out.includes('RESUMED'), 5000,
      () => `RESUMED after SIGCONT (job state=${psState(job)}, out=${JSON.stringify(out)})`);
    assert.match(out, /RESUMED/, 'the SIGCONT resume handler must have fired');
    // And the resumed job actually ran to exit — not left stopped or looping.
    await waitFor(() => { const s = psState(job); return s === 'GONE' || s.startsWith('Z'); }, 3000,
      () => `job exit after resume (state=${psState(job)})`);
  } finally {
    if (job) { try { process.kill(job, 'SIGKILL'); } catch { /* gone */ } }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});
