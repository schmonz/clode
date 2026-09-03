'use strict';
// Interactive/PTY fidelity — the initial TUI render must match between native
// Claude Code and quaude. Captures both under a real pseudo-terminal (node-pty +
// @xterm/headless) and compares the ANSI-stripped meaningful text lines. This
// exercises the welcome-box + wide/unicode-char paint (the banner uses wide box-
// drawing glyphs) and the prompt, and asserts quaude shows no corruption.
// Builds a real quaude and spawns the bundle. On darwin that is opt-in
// (CLODE_LIVE_RENDER, matching the existing e2e-doctor-parity boundary)
// because it probes the macOS Keychain; elsewhere it runs by default — see
// live-render-helper.cjs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('../e2e.cjs');
const { capture, seedClaudeProfile, apeCmd } = require('../e2e-pty.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');
const { liveRenderSkipReason } = require('../live-render-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
function nativeClaude() {
  const r = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}
function version(cmd, env) {
  const w = apeCmd(cmd.concat('--version'));
  const r = spawnSync(w[0], w.slice(1), { encoding: 'utf8', env });
  return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
}
function cleanEnv(extra) { const e = { ...process.env, ...extra }; delete e.NODE_PATH; return e; }
const STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>P]|\x1b\][^\x1b]*/g;
// Meaningful text lines: ANSI-stripped, trimmed, containing a letter, deduped.
function textLines(screen) {
  const seen = new Set();
  for (const raw of screen.replace(STRIP, '').split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (l && /[A-Za-z]/.test(l)) seen.add(l);
  }
  return seen;
}

let SKIP = null, NATIVE = '', QUAUDE = '', SBX = null, DIR = null;
before(() => {
  const liveRenderSkip = liveRenderSkipReason();
  if (liveRenderSkip) { SKIP = liveRenderSkip; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary'; return; }
  const native = nativeClaude();
  if (!native) { SKIP = 'native claude not on PATH'; return; }
  const nver = version([native], cleanEnv({ DISABLE_AUTOUPDATER: '1' }));
  if (!nver) { SKIP = 'native claude did not run here'; return; }
  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-render-'));
  const quaude = path.join(DIR, 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8', timeout: 300000,
    env: { ...process.env, CLODE_CLAUDE_BIN: native, CLODE_CACHE: path.join(DIR, 'cache'), CLODE_TJS: tjsPath(), DYLD_INSERT_LIBRARIES: '' },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  if (nver !== version([quaude], cleanEnv())) { SKIP = 'version mismatch native vs quaude'; return; }
  const opts = { seconds: 10, rows: 40, cols: 100, env: { DISABLE_AUTOUPDATER: '1' } };
  NATIVE = capture(SBX, { ...opts, cmd: [native] });
  QUAUDE = capture(SBX, { ...opts, cmd: [quaude] });
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
  if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } }
});

test('quaude initial TUI paints (welcome + prompt) without corruption', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.ok(QUAUDE.length > 200, `quaude render too small:\n${QUAUDE.slice(0, 300)}`);
  const bad = /�|not implemented|not a function|TypeError|undefined is not|node-shim:/;
  assert.doesNotMatch(QUAUDE.replace(STRIP, ''), bad, 'quaude render shows a corruption/shim-error marker');
});

test('quaude initial TUI meaningful text lines match native Claude Code', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const nat = textLines(NATIVE), qua = textLines(QUAUDE);
  assert.ok(nat.size > 3, `native render captured too little (${nat.size} lines)`);
  // Every meaningful native line must also appear in quaude (fidelity of the paint).
  const missing = [...nat].filter((l) => !qua.has(l));
  assert.deepStrictEqual(missing, [], `quaude is missing native render lines:\n${missing.join('\n')}`);
});
