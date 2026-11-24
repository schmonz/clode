'use strict';
// Ctrl-Z against a REAL quaude TUI: the regression guard for the crash-on-suspend
// bug (6300aa3/[[quaude-tty-quit-ctrlz-diagnosis]] — the suspend path printed a
// message then DIED on a swallowed TypeError). Drives a built quaude's Ink TUI
// under a PTY, sends the raw Ctrl-Z byte (0x1a) the way a terminal in raw mode
// delivers it — quaude's own handler reads it and self-suspends via
// process.kill(0,"SIGTSTP"); on resume its process.on('SIGCONT') repaints — then
// types a marker and asserts the TUI is STILL ALIVE and RESPONSIVE (welcome box
// repainted + the marker landed in the input). This replaces node-shim-ctrlz-pty:
// that test drove the COOKED-mode line-discipline SIGTSTP (a path quaude never uses
// — it runs raw with ISIG off) and its `sh -m` orphan-avoidance held on NetBSD but
// not darwin, where the kernel discards SIGTSTP to the orphaned pgroup (host node
// failed identically — not a clode/tjs defect). This test needs neither the actual
// kernel-stop nor cooked mode, so it is deterministic across platforms.
//
// The SIGTSTP/SIGCONT wiring itself stays covered by node-shim-signals.test.cjs.
// Build + real TUI: tjs + a provider, always. On darwin ALSO opt-in
// (CLODE_LIVE_RENDER=1) because spawning the real bundle probes the macOS
// Keychain; elsewhere it runs by default — see live-render-helper.cjs.
// POSIX only (Ctrl-Z/SIGTSTP is a POSIX terminal concept).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { sandbox, REPO } = require('./e2e.cjs');
const { seedClaudeProfile, captureSession, frameText } = require('./e2e-pty.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const { liveRenderSkipReason } = require('./live-render-helper.cjs');
const { builtQuaude } = require('./built-binary.cjs');

const MARKER = 'ctrlz-survivor-73';

let SKIP = null, SCREEN = '', FRAMES = [], SBX = null;
before(async () => {
  if (process.platform === 'win32') { SKIP = 'POSIX only (Ctrl-Z/SIGTSTP is a POSIX terminal concept)'; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  const liveRenderSkip = liveRenderSkipReason();
  if (liveRenderSkip) { SKIP = liveRenderSkip; return; }

  // CLODE_QUAUDE if pointed at one (fast, and how CI/a slow box hands one over),
  // else builtQuaude() builds one hermetically ONCE for this process.
  const built = builtQuaude();
  if (built.skip) { SKIP = built.skip; return; }
  const quaude = built.path;

  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  // Ctrl-Z (0x1a) once the TUI is up, SIGCONT as a shell's `fg` delivers it, then the
  // marker; capture the final screen. Survival + responsiveness = the marker in the PROMPT.
  //
  // WHAT THIS USED TO DO, AND WHY IT STOPPED WORKING (2026-09-26). The marker went as a
  // --then-hex with no delay, which tui-screen scheduled at NaN, i.e. at spawn, so it was
  // typeahead read before the Ctrl-Z at 1.5 s, and nothing ever sent SIGCONT. Upstream
  // re-enters raw mode only on SIGCONT (2.1.251 and 2.1.283 alike); the PTY child is its own
  // session leader, so the kernel discards its self-SIGTSTP and nothing continues it. On
  // 2.1.283 the linux-x64-pty mirror caught the typeahead echoed over the banner
  // ("ctrlz-surviClaude Code...") and never in the prompt. Native 2.1.283 and quaude paint
  // the same under both the old flow and this one (darwin, measured): suspended, "Run `fg`",
  // then, on SIGCONT, the repainted TUI with the marker in the prompt.
  //
  // EACH STEP WAITS FOR ITS ANSWER, NOT FOR A CLOCK (2026-11-24). The flow above ran at fixed
  // times (Ctrl-Z at 6 s, SIGCONT at 7.5 s, marker at 9 s, screen at 14 s), a guess a loaded
  // box outruns: frame-diff.test.cjs took a BLANK frame that way in a full-suite run at 91e96b5.
  // Now a session: Ctrl-Z once boot has settled, its frame held until the suspend message is on
  // screen; SIGCONT, its frame taken once the repaint it causes has settled; the marker, held
  // until it is on screen. The screen judged is the last frame, as before.
  const s = await captureSession(SBX, {
    cmd: [quaude],
    script: [
      { label: 'ctrl-z', send: '1a', until: 'is suspended' },
      { label: 'fg', signal: 'SIGCONT' },
      { label: 'marker', send: Buffer.from(MARKER).toString('hex'), until: MARKER },
    ],
  });
  FRAMES = s.frames;
  SCREEN = s.frames.length ? frameText(s.frames[s.frames.length - 1].frame) : '';
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
});

test('quaude survives Ctrl-Z: the TUI stays alive and responsive after suspend', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // Every step happened and was answered: a frame per step, each settled (an unsettled one is a
  // step the TUI never answered, or one it died during).
  assert.deepStrictEqual(FRAMES.map((f) => [f.label, f.settled]),
    [['boot', true], ['ctrl-z', true], ['fg', true], ['marker', true]], `a step went unanswered:\n${SCREEN}`);
  // Did NOT crash on Ctrl-Z: the welcome box is still (re)painted...
  assert.match(SCREEN, /Claude Code/, `TUI did not survive Ctrl-Z (no welcome box):\n${SCREEN}`);
  // ...it did suspend, the way upstream says it does (2.1.330's words: "Claude Code is suspended. Run `fg` to bring it
  // back."; through 2.1.283 they were "Claude Code has been suspended", and this row read the old words as no suspend
  // at all, while the screen showed the suspend, the SIGCONT repaint and the marker in the prompt)...
  assert.match(SCREEN, /Claude Code is suspended\. Run `fg` to bring it back\./, `Ctrl-Z did not suspend:\n${SCREEN}`);
  // ...and input works after the resume: the marker typed after SIGCONT is in the PROMPT,
  // not merely echoed somewhere by a terminal left in cooked mode.
  // The prompt glyph U+276F is followed by U+00A0, not a space (sessions.cjs's slash-menu
  // mustShow spells the same pair); \s matches either.
  assert.match(SCREEN, new RegExp(`${String.fromCodePoint(0x276F)}\\s${MARKER}`),
    `input unresponsive after Ctrl-Z and SIGCONT (marker not in the prompt):\n${SCREEN}`);
});
