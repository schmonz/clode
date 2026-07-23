'use strict';
// Interactive/PTY fidelity (G2) — a full human turn against the REAL API must
// render the streamed model response in the TUI. This is the one interactive row
// a mock cannot reach: the interactive first turn validates credentials with
// claude.ai before it will fire, so a fake key spins forever without ever
// dialing ANTHROPIC_BASE_URL (see RECIPE G2). So this test does the real thing —
// it drives native Claude Code and a built quaude under a pseudo-terminal using
// the developer's OWN logged-in credentials, types a prompt whose answer is NOT
// present in the prompt text ("6 times 7" -> "42", so the echoed input can't be
// mistaken for the response), and asserts quaude renders the response like
// native does.
//
// Because it uses real credentials and spends real tokens (one trivial turn per
// engine), it is opt-in twice over: CLODE_LIVE_RENDER=1 (the existing
// spawns-the-bundle/Keychain gate) AND CLODE_LIVE_ONLINE=1. It runs against the
// REAL HOME on purpose — a sandbox HOME makes the bundle decide "Not logged in"
// before it ever consults the Keychain — so it appends to the normal session
// history like any other turn. If native cannot complete the turn (logged out,
// offline, model non-compliant) BOTH tests skip rather than fail: that is an
// environment signal, not a quaude divergence.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('../e2e.cjs');
const { capture } = require('../e2e-pty.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
// The answer must not appear in the prompt, so a rendered match cannot be the
// echoed input line.
const PROMPT = 'Reply with only the numeric result of 6 times 7, nothing else.';
const ANSWER = /\b42\b/;
const ECHO = /6 times 7|Reply with/;

function nativeClaude() {
  const r = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}
function version(cmd, env) {
  const r = spawnSync(cmd[0], cmd.slice(1).concat('--version'), { encoding: 'utf8', env });
  return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
}
function cleanEnv(extra) { const e = { ...process.env, ...extra }; delete e.NODE_PATH; return e; }
const STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>P]|\x1b\][^\x1b]*/g;
function lines(screen) { return screen.replace(STRIP, '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')); }
// The model's answer rendered as output — on a line that is not the input echo.
function renderedAnswer(screen) { return lines(screen).some((l) => ANSWER.test(l) && !ECHO.test(l)); }

// Drive one real turn under a PTY against the real HOME (real credentials).
function liveTurn(cmd) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_CHILD_SESSION;   // else the child disables transcript saving
  const hex = Buffer.from(PROMPT, 'utf8').toString('hex');
  return capture({ env, home: os.homedir() }, {
    seconds: 40, rows: 40, cols: 100,
    thenHex: [`${hex}@5`, '0d@8'],
    env: { DISABLE_AUTOUPDATER: '1' }, cmd,
  });
}

let SKIP = null, NATIVE = '', QUAUDE = '', DIR = null;
before(() => {
  if (process.env.CLODE_LIVE_RENDER !== '1') { SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1)'; return; }
  if (process.env.CLODE_LIVE_ONLINE !== '1') { SKIP = 'live ONLINE opt-in only (set CLODE_LIVE_ONLINE=1; uses your real credentials and spends real tokens)'; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary'; return; }
  const native = nativeClaude();
  if (!native) { SKIP = 'native claude not on PATH'; return; }
  const nver = version([native], cleanEnv({ DISABLE_AUTOUPDATER: '1' }));
  if (!nver) { SKIP = 'native claude did not run here'; return; }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-liveturn-'));
  const quaude = path.join(DIR, 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8', timeout: 400000,
    env: { ...process.env, CLODE_CLAUDE_BIN: native, CLODE_CACHE: path.join(DIR, 'cache'), CLODE_TJS: tjsPath(), DYLD_INSERT_LIBRARIES: '' },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  if (nver !== version([quaude], cleanEnv())) { SKIP = 'version mismatch native vs quaude'; return; }
  NATIVE = liveTurn([native]);
  // Native is the environment probe: logged out / offline / non-compliant model
  // means we cannot judge quaude, so skip both rather than fail.
  if (!renderedAnswer(NATIVE)) {
    SKIP = `native could not complete a live turn (logged out, offline, or model non-compliant) — cannot judge quaude:\n${lines(NATIVE).filter((l) => l.trim()).slice(-8).join('\n')}`;
    return;
  }
  QUAUDE = liveTurn([quaude]);
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

test('native renders a live streamed response (harness + credentials sanity)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.ok(renderedAnswer(NATIVE), 'native did not render the response');
  assert.doesNotMatch(NATIVE.replace(STRIP, ''), /Not logged in/, 'native was not logged in');
});

test('quaude renders the live streamed model response in the TUI (a real human turn)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const q = QUAUDE.replace(STRIP, '');
  assert.doesNotMatch(q, /Not logged in/, 'quaude could not authenticate (Keychain credentials not reachable)');
  assert.doesNotMatch(q, /�|not implemented|not a function|TypeError|undefined is not|node-shim:/, 'quaude render shows a corruption/shim-error marker');
  assert.ok(renderedAnswer(QUAUDE),
    `quaude did not render the streamed response like native did:\n${lines(QUAUDE).filter((l) => l.trim()).slice(-10).join('\n')}`);
});
