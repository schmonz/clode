'use strict';
// node:test PTY capture harness — the node-native successor to test_helper.bash's
// _tui_capture / _doctor_capture. Drives a TUI command under a real pseudo-terminal by
// spawning the existing test/tui-screen.cjs driver (node-pty + @xterm/headless) with the
// Spec 2a constructed-clean sandbox env, and returns the rendered screen as a string.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO, NODE } = require('./e2e.cjs');
const { isApeFile, wantsTrampoline } = require('./node-shim-helper.cjs');
const { updaterOff } = require('./updater-off.cjs');

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
  // captureSession (asynchronous) when the mock lives in this process.
  if (opts.apiKey) {
    profile.customApiKeyResponses = { approved: [String(opts.apiKey).trim().slice(-20)], rejected: [] };
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(profile));
}

// Drive opts.cmd under a PTY via tui-screen.cjs; return the rendered screen (stdout).
// tui-screen self-terminates after opts.seconds, so no external timeout is needed.
// opts: { seconds, fixedWindowBecause, cmd:[...], sendHex?, thenHex?:['HEX@DELAY'], signal?:['NAME@DELAY'],
// resize?:['COLSxROWS@DELAY'], rows?, cols?, env?, autoUpdaterBecause? }. cmd[0] is
// the absolute program to run under the PTY (e.g. a built quaude, or a native binary).
// A scripted session (captureSession) passes scriptFile and the settle limits instead.
//
// A FIXED WINDOW NEEDS A WRITTEN REASON. A capture taken `seconds` after spawn, with keystrokes
// at fixed delays, is a guess about how fast the box is, and a loaded box outruns it: the full
// suite at 91e96b5 took a BLANK frame in test/frame-diff.test.cjs (node had not painted inside its
// 1.2 s window) and two rows failed on it. A session (captureSession) takes each frame once its
// output has been heard and has settled, and waits on `until` text for a reply. So a fixed
// window is refused unless opts.fixedWindowBecause says why the clock itself is what is tested;
// test/fixed-window-captures.test.cjs holds every such reason in test/** to an allowlist.
// The timed options belong to the fixed form only: a script run ignores them, so they are
// refused there rather than silently doing nothing.
const TIMED = ['sendHex', 'thenHex', 'signal', 'resize'];
function refuseUnreasonedWindow(opts) {
  if (opts.scriptFile) {
    const timed = TIMED.filter((k) => opts[k] != null && !(Array.isArray(opts[k]) && opts[k].length === 0));
    if (Number(opts.seconds) > 0 || timed.length) {
      throw new Error(`a scripted session takes no fixed window (${[Number(opts.seconds) > 0 ? `seconds: ${opts.seconds}` : null, ...timed].filter(Boolean).join(', ')}): `
        + 'every step waits for its own output to settle; spell a timed keystroke as a send step');
    }
    return;
  }
  if (typeof opts.fixedWindowBecause !== 'string' || opts.fixedWindowBecause.trim() === '') {
    throw new Error(`a fixed ${opts.seconds}s capture window needs opts.fixedWindowBecause: a fixed window is outrun on a `
      + 'loaded box (frame-diff took a blank frame at 91e96b5); use captureSession/captureBoot, which take a frame once '
      + 'its output was heard and settled, unless the clock is the thing under test');
  }
}
function driveArgs(sbx, opts) {
  refuseUnreasonedWindow(opts);
  const args = [String(opts.seconds)];
  if (opts.cells) args.push('--cells');
  if (opts.scriptFile) args.push('--script', opts.scriptFile);
  for (const [k, flag] of [['settleMs', '--settle-ms'], ['maxSettleMs', '--max-settle-ms'],
    ['bootSettleMs', '--boot-settle-ms'], ['bootMaxMs', '--boot-max-ms']]) {
    if (opts[k] != null) args.push(flag, String(opts[k]));
  }
  if (opts.sendHex) args.push('--send-hex', opts.sendHex);
  for (const th of opts.thenHex || []) args.push('--then-hex', th);
  for (const sg of opts.signal || []) args.push('--signal', sg);
  for (const rz of opts.resize || []) args.push('--resize', rz);
  if (opts.rows) args.push('--rows', String(opts.rows));
  if (opts.cols) args.push('--cols', String(opts.cols));
  args.push('--', ...apeCmd(opts.cmd));
  // DISABLE_AUTOUPDATER unless opts.autoUpdaterBecause says why not (test/updater-off.cjs); tui-screen refuses an env with neither.
  const env = updaterOff({ ...sbx.env, ...(opts.env || {}), TERM: 'xterm-256color' }, opts.autoUpdaterBecause);
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
// Exit 4 is the driver saying the TUI it drove OUTLIVED its stop (tui-screen.cjs stopChild): a leaked process, which on
// Windows holds the binary and its directory (windows-amd64-tui, CI 44460009323). Every capture below throws on it, so
// every PTY gate inherits the check; the screen it took is real, so it is in the message.
const DRIVER_LEAKED = 4;
function refuseLeak(r) {
  if (r.status === DRIVER_LEAKED) {
    throw new Error(`tui-screen: the driven process outlived the driver (exit 4): ${r.stderr.trim().slice(-600)}`);
  }
  return r;
}
function capture(sbx, opts) { return refuseLeak(drive(sbx, opts)).stdout; }

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
  refuseLeak(r);
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

// A SCRIPTED SESSION: a frame per step, each taken when the TUI's output settles (see
// tui-screen.cjs --script). opts: { script, settleMs?, maxSettleMs?, bootSettleMs?,
// bootMaxMs?, rows?, cols?, cmd, env? }; unset limits take tui-screen's measured defaults.
// Resolves to { format, exit, frames: [{ label, settled, ms, frame }] }. ASYNC, like
// captureFrameAsync and for the same reason: the canned mock that answers the TUI lives in
// this process, and a synchronous capture would freeze it for the whole session.
async function captureSession(sbx, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-session-'));
  try {
    const scriptFile = path.join(dir, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(opts.script));
    return parseSession(await driveAsync(sbx, { ...opts, seconds: 0, scriptFile, script: undefined }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// THE BOOT FRAME, SETTLED: a one-step session's frame 0, taken once the TUI's output has been
// heard and has then been quiet for bootSettleMs (tui-screen's measured default when unset: long
// enough to wait out the welcome screen's self-timed elements). Replaces a fixed-window capture of
// "what is on screen at t=N s". Resolves to { label, settled, ms, frame, text }; the caller asserts
// `settled`, because a boot that never painted (or never went quiet) by bootMaxMs is a finding.
async function captureBoot(sbx, opts) {
  const s = await captureSession(sbx, { ...opts, script: [{ label: 'after', wait: 1 }] });
  const boot = s.frames[0];
  return { ...boot, text: frameText(boot.frame) };
}

// A cell frame as the text screen capture() used to print: each row's glyphs (a wide glyph's
// spacer dropped, an unwritten cell a space), trailing space trimmed, rows joined by newlines.
function frameText(frame) {
  const { rowText } = require('./frame-diff.cjs');
  const rows = [];
  for (let y = 0; y < frame.rows; y++) rows.push(rowText(frame, y));
  return rows.join('\n') + '\n';
}

// The session form of parseFrame: a driver result that is not a whole frame sequence
// throws, with the driver's stderr and exit status, rather than reading as a session.
function parseSession(r) {
  refuseLeak(r);
  const out = r.stdout;
  let s;
  try { s = JSON.parse(out); } catch (e) {
    const how = r.error ? `spawn error ${r.error.message}` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    throw new Error(`tui-screen --script produced no frame sequence (${e.message}; driver ${how}); `
      + `stdout was:\n${out.slice(0, 400)}\nstderr was:\n${r.stderr.slice(0, 1200)}`);
  }
  if (!s || s.format !== 'clode-frames-v1' || !Array.isArray(s.frames)) {
    throw new Error(`unexpected frame-sequence format: ${out.slice(0, 200)}`);
  }
  return s;
}

module.exports = { seedClaudeProfile, capture, captureFrame, captureFrameAsync, captureSession, captureBoot, frameText,
  parseSession, drive, driveArgs, apeCmd, refuseLeak, TUI_SCREEN };
