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
// engine), it always needs CLODE_LIVE_ONLINE=1 — that opt-in is about the
// network, not the platform, so it stays required everywhere on its own
// merits. It ALSO needs the render gate (CLODE_LIVE_RENDER, darwin-only —
// see live-render-helper.cjs) since spawning the real bundle probes the
// macOS Keychain there. It runs against the
// REAL HOME on purpose — a sandbox HOME makes the bundle decide "Not logged in"
// before it ever consults the Keychain — so it appends to the normal session
// history like any other turn. If native cannot complete the turn (logged out,
// offline, model non-compliant) BOTH tests skip rather than fail: that is an
// environment signal, not a quaude divergence.
//
// HONESTY FIX (phase 5, task 12, 2026-09-04): the code did not match the
// paragraph above. NO_REFERENCE_SKIP is the precise subset of NATIVE_SKIP that
// means "no confirmed logged-in reference to compare against" (native didn't
// run, its version didn't match quaude's, or it could not complete the live
// turn) — as opposed to "no native binary exists on this platform at all",
// which is NOT a precondition failure: NetBSD/BSD/etc. have no native Claude
// Code by design, and quaude's own turn is still judged standalone there (see
// the comment above the second test). Only NO_REFERENCE_SKIP now also skips
// the quaude test — so a red there still means quaude diverged from a
// confirmed-good reference, never "nobody was logged in here".
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('../e2e.cjs');
const { capture, apeCmd } = require('../e2e-pty.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');
const { liveRenderSkipReason } = require('../live-render-helper.cjs');

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
  const w = apeCmd(cmd.concat('--version'));
  const r = spawnSync(w[0], w.slice(1), { encoding: 'utf8', env });
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

// SKIP gates BOTH tests (no creds/tjs/build). NATIVE_SKIP gates only the native
// comparison, which needs a runnable native Claude Code — absent by design on the
// platforms that are quaude's whole reason to exist (NetBSD, the BSDs, …). There,
// the quaude turn still runs and is judged on its OWN merits: it renders 42, is
// logged in, and shows no shim-error markers. Its answer check (renderedAnswer) is
// native-independent, so no comparison reference is needed. NO_REFERENCE_SKIP is
// the strict subset of NATIVE_SKIP that means a reference COULD have been
// established (native is on PATH) but wasn't (didn't run / version drift /
// couldn't complete a live turn) — that subset gates the quaude test too, so a
// missing login reads as a skip everywhere, never as a hard failure.
let SKIP = null, NATIVE_SKIP = null, NO_REFERENCE_SKIP = null, NATIVE = '', QUAUDE = '', DIR = null;
before(() => {
  if (process.env.CLODE_LIVE_ONLINE !== '1') { SKIP = 'live ONLINE opt-in only (set CLODE_LIVE_ONLINE=1; uses your real credentials and spends real tokens)'; return; }
  const liveRenderSkip = liveRenderSkipReason();
  if (liveRenderSkip) { SKIP = liveRenderSkip; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary'; return; }
  const native = nativeClaude();
  // Build from a runnable native claude if present, else the configured provider
  // binary (CLODE_CLAUDE_BIN) — the extractor carves the bundle from it either way.
  const provider = native || process.env.CLODE_CLAUDE_BIN;
  if (!provider) { SKIP = 'no native claude on PATH and no CLODE_CLAUDE_BIN provider to build from'; return; }
  let nver = null;
  if (native) {
    nver = version([native], cleanEnv({ DISABLE_AUTOUPDATER: '1' }));
    // NO_REFERENCE_SKIP too: native exists but did not even run, so there is no
    // confirmed-good reference to judge quaude's login state against.
    if (!nver) { NATIVE_SKIP = 'native claude did not run here'; NO_REFERENCE_SKIP = NATIVE_SKIP; }
  } else {
    // NOT a NO_REFERENCE_SKIP: no native binary exists on this platform BY
    // DESIGN (NetBSD, the BSDs, ... — quaude's whole reason to exist), so the
    // quaude test below still runs and is judged on its own merits.
    NATIVE_SKIP = 'no runnable native Claude Code on this platform (expected off Linux/macOS — quaude is the point)';
  }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-liveturn-'));
  const quaude = path.join(DIR, 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8', timeout: 400000,
    env: { ...process.env, CLODE_CLAUDE_BIN: provider, CLODE_CACHE: path.join(DIR, 'cache'), CLODE_TJS: tjsPath(), DYLD_INSERT_LIBRARIES: '' },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  if (native && nver && !NATIVE_SKIP) {
    if (nver !== version([quaude], cleanEnv())) { NATIVE_SKIP = 'version mismatch native vs quaude'; NO_REFERENCE_SKIP = NATIVE_SKIP; }
    else {
      NATIVE = liveTurn([native]);
      // Native is the comparison probe; logged out/offline means only the
      // comparison is unjudgeable — the quaude turn still stands on its own.
      // But it is ALSO a NO_REFERENCE_SKIP: without a confirmed logged-in
      // reference, a red on quaude's own login check below cannot be told
      // apart from "nobody is logged in here" — the exact ambiguity this
      // fix exists to remove (BACKLOG.md, "Two defects found while wiring
      // the Linux PTY CI job").
      if (!renderedAnswer(NATIVE)) { NATIVE_SKIP = `native could not complete a live turn (logged out/offline/model non-compliant):\n${lines(NATIVE).filter((l) => l.trim()).slice(-6).join('\n')}`; NO_REFERENCE_SKIP = NATIVE_SKIP; }
    }
  }
  QUAUDE = liveTurn([quaude]);
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

test('native renders a live streamed response (harness + credentials sanity)', (t) => {
  if (SKIP || NATIVE_SKIP) { t.skip(SKIP || NATIVE_SKIP); return; }
  assert.ok(renderedAnswer(NATIVE), 'native did not render the response');
  assert.doesNotMatch(NATIVE.replace(STRIP, ''), /Not logged in/, 'native was not logged in');
});

test('quaude renders the live streamed model response in the TUI (a real human turn)', (t) => {
  if (SKIP || NO_REFERENCE_SKIP) { t.skip(SKIP || NO_REFERENCE_SKIP); return; }
  const q = QUAUDE.replace(STRIP, '');
  assert.doesNotMatch(q, /Not logged in/, 'quaude could not authenticate (credentials not reachable)');
  assert.doesNotMatch(q, /�|not implemented|not a function|TypeError|undefined is not|node-shim:/, 'quaude render shows a corruption/shim-error marker');
  assert.ok(renderedAnswer(QUAUDE),
    `quaude did not render the streamed response (expected the model to answer 42):\n${lines(QUAUDE).filter((l) => l.trim()).slice(-10).join('\n')}`);
});
