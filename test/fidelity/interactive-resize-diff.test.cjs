'use strict';
// Interactive/PTY fidelity (D6) — a SIGWINCH resize must reflow the TUI. Starts
// both native Claude Code and a built quaude wide (100 cols), resizes the PTY
// down to 60 cols mid-run (node-pty's resize() delivers SIGWINCH to the child),
// and asserts quaude's frame reflows to the new width exactly like native — the
// bundle's Ink reflow depends on the shim delivering SIGWINCH AND an updated
// process.stdout.columns. A broken signal/columns path would leave stale wide
// lines (>65 cols) or corrupt the frame. Gated behind CLODE_LIVE_RENDER (builds
// a real quaude, spawns the bundle, touches Keychain), matching the other PTY
// differential tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('../e2e.cjs');
const { capture, seedClaudeProfile } = require('../e2e-pty.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
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
// The rendered line widths (ANSI-stripped, trailing space trimmed), non-empty.
function lineWidths(screen) {
  return screen.replace(STRIP, '').split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, '').length).filter((n) => n > 0);
}
const NARROW = 60;

let SKIP = null, NATIVE = '', QUAUDE = '', SBX = null, DIR = null;
before(() => {
  if (process.env.CLODE_LIVE_RENDER !== '1') { SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1; spawns the bundle, touches Keychain)'; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary'; return; }
  const native = nativeClaude();
  if (!native) { SKIP = 'native claude not on PATH'; return; }
  const nver = version([native], cleanEnv({ DISABLE_AUTOUPDATER: '1' }));
  if (!nver) { SKIP = 'native claude did not run here'; return; }
  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-resize-'));
  const quaude = path.join(DIR, 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8', timeout: 300000,
    env: { ...process.env, CLODE_CLAUDE_BIN: native, CLODE_CACHE: path.join(DIR, 'cache'), CLODE_TJS: tjsPath(), DYLD_INSERT_LIBRARIES: '' },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  if (nver !== version([quaude], cleanEnv())) { SKIP = 'version mismatch native vs quaude'; return; }
  // Start wide (100), resize down to 60 cols at 5s; capture past the reflow.
  const opts = { seconds: 9, rows: 40, cols: 100, resize: [`${NARROW}x40@5`], env: { DISABLE_AUTOUPDATER: '1' } };
  NATIVE = capture(SBX, { ...opts, cmd: [native] });
  QUAUDE = capture(SBX, { ...opts, cmd: [quaude] });
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
  if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } }
});

test('native reflows to the narrower width on SIGWINCH (harness sanity)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const w = lineWidths(NATIVE);
  assert.ok(w.length > 3, `native render captured too little:\n${NATIVE.slice(-400)}`);
  // The frame reflowed: nothing wider than the new terminal (a small slack for
  // rounding), and the max line reaches the new width (the rule spans it).
  assert.ok(Math.max(...w) <= NARROW + 2, `native did not reflow: max width ${Math.max(...w)} > ${NARROW}`);
  assert.ok(Math.max(...w) >= NARROW - 4, `native reflow suspiciously narrow: ${Math.max(...w)}`);
});

test('quaude reflows to the same width as native on SIGWINCH (no stale wide frame)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const q = QUAUDE.replace(STRIP, '');
  assert.doesNotMatch(q, /�|not implemented|not a function|TypeError|undefined is not|node-shim:/, 'quaude render shows a corruption/shim-error marker');
  const qw = lineWidths(QUAUDE);
  assert.ok(qw.length > 3, `quaude render captured too little:\n${QUAUDE.slice(-400)}`);
  // SIGWINCH delivered + columns updated: no line stayed at the original 100-col
  // width (a broken signal/columns path leaves the wide frame).
  const staleWide = qw.filter((n) => n > NARROW + 5);
  assert.deepStrictEqual(staleWide, [], `quaude left stale wide lines after resize (SIGWINCH/columns not honored): ${staleWide.join(',')}\n${QUAUDE.slice(-500)}`);
  // And it reflows to the same max width as native (fidelity of the reflow).
  assert.strictEqual(Math.max(...qw), Math.max(...lineWidths(NATIVE)),
    `quaude reflow width != native\n  native: ${Math.max(...lineWidths(NATIVE))}\n  quaude: ${Math.max(...qw)}`);
});
