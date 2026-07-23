'use strict';
// node:test PTY capture harness — the node-native successor to test_helper.bash's
// _tui_capture / _doctor_capture. Drives a TUI command under a real pseudo-terminal by
// spawning the existing test/tui-screen.cjs driver (node-pty + @xterm/headless) with the
// Spec 2a constructed-clean sandbox env, and returns the rendered screen as a string.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, NODE } = require('./e2e.cjs');

const TUI_SCREEN = path.join(REPO, 'test', 'tui-screen.cjs');

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
  // the "Not logged in" gate; note the interactive first turn additionally
  // blocks on a startup gate that needs real network, so a live mock turn in
  // the TUI is not reachable offline (see RECIPE G2). Opt-in for future
  // interactive-turn harnesses that run online.
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
function capture(sbx, opts) {
  const args = [String(opts.seconds)];
  if (opts.sendHex) args.push('--send-hex', opts.sendHex);
  for (const th of opts.thenHex || []) args.push('--then-hex', th);
  for (const rz of opts.resize || []) args.push('--resize', rz);
  if (opts.rows) args.push('--rows', String(opts.rows));
  if (opts.cols) args.push('--cols', String(opts.cols));
  args.push('--', ...opts.cmd);
  const env = { ...sbx.env, ...(opts.env || {}), TERM: 'xterm-256color' };
  for (const k of ['TMUX', 'TMUX_PANE', 'TERM_PROGRAM', 'NODE_PATH']) delete env[k];
  const r = spawnSync(NODE, [TUI_SCREEN, ...args], { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  return r.stdout || '';
}

module.exports = { seedClaudeProfile, capture, TUI_SCREEN };
