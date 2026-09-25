'use strict';
// node:test PTY capture harness — the node-native successor to test_helper.bash's
// _tui_capture / _doctor_capture. Drives a TUI command under a real pseudo-terminal by
// spawning the existing test/tui-screen.cjs driver (node-pty + @xterm/headless) with the
// Spec 2a constructed-clean sandbox env, and returns the rendered screen as a string.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, NODE } = require('./e2e.cjs');
const { isApeFile, wantsTrampoline } = require('./node-shim-helper.cjs');

const TUI_SCREEN = path.join(REPO, 'test', 'tui-screen.cjs');

// A Cosmopolitan APE subject (e.g. a cosmo-built quaude) begins with the DOS
// 'MZ' magic and cannot be execve'd on a POSIX host — the kernel returns
// ENOEXEC, and only a shell's ENOEXEC fallback runs it. node's spawn/node-pty
// do NOT do that fallback, so any harness that spawns a built quaude directly
// (version checks, PTY capture) would fail on cosmo. Detect the MZ magic and run
// it the way clode-build's isApeFile path does: `/bin/sh -c '"$@"' sh <ape> …`.
// Non-APE binaries (native Claude, naude SEA, native-tjs quaude) are unchanged.
//
// POSIX ONLY, via the one shared decision (node-shim-helper.cjs's
// wantsTrampoline). 'MZ' is also the head of every Windows PE — node.exe
// included — so gating on the magic alone turned every win32 spawn into
// `/bin/sh …`, which ConPTY cannot find: all of test/frame-diff.test.cjs failed
// with node-pty's "File not found: " on windows-latest (CI run 36039332441,
// 2026-09-24). `platform` is injectable so test/e2e-pty.test.cjs can pin the
// win32 answer on every host.
function apeCmd(cmd, platform = process.platform) {
  if (!Array.isArray(cmd) || cmd.length === 0) return cmd;
  if (!wantsTrampoline(platform, isApeFile(cmd[0]))) return cmd;
  return ['/bin/sh', '-c', '"$@"', 'sh', ...cmd];
}

// Minimal synthetic ~/.claude.json: past onboarding + the capture cwd pre-trusted, so a
// fixed-duration no-keystroke capture never blocks on the theme-onboarding or the
// per-project trust prompt. Keyed by cwd (regenerated per run). If a future Claude Code
// changes these keys, this is the one place to adjust (see e2e-tui verification).
function seedClaudeProfile(home, opts = {}) {
  const profile = { hasCompletedOnboarding: true, theme: 'dark' };
  if (opts.trust !== false && opts.cwd) {
    profile.projects = { [opts.cwd]: {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    } };
  }
  // Pre-approve an ANTHROPIC_API_KEY so the interactive TUI treats it as logged
  // in (the bundle stores the last-20 chars of the approved key — `JQ(e) =
  // e.trim().slice(-20)`; `-p` auto-approves, the TUI does not). This clears
  // the "Not logged in" gate. A live mock turn in the TUI IS reachable offline
  // (measured 2026-09-25, native 2.1.278: HEAD /api/hello, then POST
  // /v1/messages, and the canned answer painted) — but only when the mock can
  // answer, i.e. NOT from the process that is blocked in a synchronous capture
  // below: an in-process mock never runs while spawnSync waits, so the turn
  // spins forever without a request ever being seen. Capture with
  // captureFrameAsync when the mock lives in this process.
  if (opts.apiKey) {
    profile.customApiKeyResponses = { approved: [String(opts.apiKey).trim().slice(-20)], rejected: [] };
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(profile));
}

// Drive opts.cmd under a PTY via tui-screen.cjs; return the rendered screen (stdout).
// tui-screen self-terminates after opts.seconds, so no external timeout is needed.
// opts: { seconds, cmd:[...], sendHex?, thenHex?:[...], resize?:['COLSxROWS@DELAY'], rows?, cols?, env? }. cmd[0] is
// the absolute program to run under the PTY (e.g. a built quaude, or a native binary).
function driveArgs(sbx, opts) {
  const args = [String(opts.seconds)];
  if (opts.cells) args.push('--cells');
  if (opts.sendHex) args.push('--send-hex', opts.sendHex);
  for (const th of opts.thenHex || []) args.push('--then-hex', th);
  for (const rz of opts.resize || []) args.push('--resize', rz);
  if (opts.rows) args.push('--rows', String(opts.rows));
  if (opts.cols) args.push('--cols', String(opts.cols));
  args.push('--', ...apeCmd(opts.cmd));
  const env = { ...sbx.env, ...(opts.env || {}), TERM: 'xterm-256color' };
  for (const k of ['TMUX', 'TMUX_PANE', 'TERM_PROGRAM', 'NODE_PATH']) delete env[k];
  return { args: [TUI_SCREEN, ...args], env };
}
function drive(sbx, opts) {
  const { args, env } = driveArgs(sbx, opts);
  const r = spawnSync(NODE, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, signal: r.signal, error: r.error };
}
// The same drive, leaving this process's event loop running while the TUI does, so a
// server in this process (the canned mock) can answer it. Resolves to drive()'s shape.
function driveAsync(sbx, opts) {
  const { args, env } = driveArgs(sbx, opts);
  return new Promise((resolve) => {
    let stdout = '', stderr = '', error;
    const c = spawn(NODE, args, { env });
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', (e) => { error = e; });
    c.on('close', (status, signal) => resolve({ stdout, stderr, status, signal, error }));
  });
}
function capture(sbx, opts) { return drive(sbx, opts).stdout; }

// Same drive, but stdout is a cell-level frame (see tui-screen.cjs dumpCells).
// Returns the parsed frame, or throws with the driver's output when the driver
// did not produce one — an unparseable capture must never masquerade as an
// empty screen that happens to compare equal.
//
// The error carries the driver's STDERR and exit status, not just its stdout:
// on windows-latest (ci run 35727111476) every capture died as "produced no
// frame (Unexpected end of JSON input); output was:" followed by NOTHING,
// because the reason was on stderr and capture() threw stderr away.
function captureFrame(sbx, opts) {
  return parseFrame(drive(sbx, { ...opts, cells: true }));
}
async function captureFrameAsync(sbx, opts) {
  return parseFrame(await driveAsync(sbx, { ...opts, cells: true }));
}
function parseFrame(r) {
  const out = r.stdout;
  let frame;
  try { frame = JSON.parse(out); } catch (e) {
    const how = r.error ? `spawn error ${r.error.message}` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    throw new Error(`tui-screen --cells produced no frame (${e.message}; driver ${how}); `
      + `stdout was:\n${out.slice(0, 400)}\nstderr was:\n${r.stderr.slice(0, 1200)}`);
  }
  if (!frame || frame.format !== 'clode-frame-v1') throw new Error(`unexpected frame format: ${out.slice(0, 200)}`);
  return frame;
}

module.exports = { seedClaudeProfile, capture, captureFrame, captureFrameAsync, apeCmd, TUI_SCREEN };
