'use strict';
// Interactive/PTY fidelity AT CELL LEVEL — quaude's initial TUI frame must be
// the SAME SCREEN as native Claude Code's, cell for cell: glyph, width, SGR and
// OSC-8 target.
//
// WHY A SECOND FILE BESIDE interactive-render-diff. That one compares
// ANSI-stripped text lines, and test/frame-diff.test.cjs proves it is blind to
// three of the four ways a screen model corrupts a frame (a moved wide-glyph
// spacer, an SGR-only change, an OSC-8-only change). This is the instrument that
// judged Bun.ant.CellSegmenter (709 differing cell-classes -> 0 on 2.1.278), and
// until now it ran only when a human remembered to run test/frame-oracle.cjs.
// A ratchet that needs remembering is not a ratchet.
//
// EXACT EQUALITY, NO TOLERANCE. Measured 2026-09-24 on darwin-arm64 at 100x40:
// native-vs-native is identical apart from ONE unwritten-vs-space cell that the
// renderer's own frame diff flips run to run; frame-diff.cjs now treats those
// as the same visible cell (proven both ways in frame-diff.test.cjs), and with
// that native-vs-native, 2.1.251-vs-native and 2.1.278-vs-native are all 0.
//
// WHAT IT IS A GUARD OVER, and its floor. `examined` is the number of visibly
// non-blank cells in the REFERENCE frame. Native paints 353 at 100x40; the floor
// is 200, so a reference that painted nothing (or half a banner) is BROKEN, not
// OK — otherwise a blank native against a blank quaude would compare IDENTICAL,
// which is exactly how quaude-from-2.1.278 painted nothing for a day while the
// build smoke said PONG.
//
// WHAT IT DOES NOT COVER, deliberately named: only the INITIAL frame, no typed
// input, no resize, no scroll (phase 5 of the CellSegmenter work), and nothing
// wide — the welcome screen contains no CJK and no emoji, so this gate says
// nothing yet about phase 3's widths.
//
// THE REFERENCE IS A RUNNABLE NATIVE CLAUDE, NOT THE BUILD PROVIDER.
// CLODE_NATIVE_CLAUDE, else `claude` on PATH (what CI's `npm i -g` installs), and
// it must report the same --version as the quaude or the gate SKIPS naming both.
// The provider is the wrong reference and this file proved it on its first Linux
// run (2026-09-24, node:24.21.0-bookworm mirroring linux-x64-pty): CI hands the
// suite `provider-min`, a stripped repack for BUILDING that is not even
// executable, and the gate went BROKEN — "examined 33, floor is 200" — because
// the reference frame was the one line `execvp(3) failed.: Permission denied`.
// That is the floor doing its job: an OK there would have been a lie.
//
// Same gating as interactive-render-diff: spawns the real bundle, so darwin is
// opt-in (CLODE_LIVE_RENDER=1, Keychain); every other platform runs it by
// default. CI runs it in the linux-x64-pty job against the pinned provider.
const { before } = require('node:test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { liveRenderSkipReason } = require('../live-render-helper.cjs');
const { skipReason: providerSkipReason } = require('../provider-resolve.cjs');
const { builtQuaude } = require('../built-binary.cjs');
const { apeCmd } = require('../e2e-pty.cjs');
const { captureFrames } = require('../frame-oracle.cjs');
const { diff, describe, corrupt, cloneFrame } = require('../frame-diff.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const ROWS = 40, COLS = 100;
// Long enough for the late-arriving status line: at 12s the "● high · /effort"
// row was sometimes still absent from one side (measured 2026-09-22), which
// read as 16 phantom glyph+sgr differences.
const SECONDS = 20;
const FLOOR = 200;

function harnessMissing() {
  const path = require('node:path');
  const REPO = path.resolve(__dirname, '..', '..');
  try {
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    require.resolve(path.join(harnessDir(REPO), 'node_modules', 'node-pty'));
    return null;
  } catch { /* fall through to bare resolution */ }
  try { require.resolve('node-pty'); return null; } catch { /* */ }
  return 'PTY harness (node-pty/@xterm/headless) is not installed for this platform tag';
}

function nativeClaude() {
  if (process.env.CLODE_NATIVE_CLAUDE) return process.env.CLODE_NATIVE_CLAUDE;
  const r = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}
function versionOf(bin) {
  const w = apeCmd([bin, '--version']);
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' }; delete env.NODE_PATH;
  const r = spawnSync(w[0], w.slice(1), { encoding: 'utf8', env, timeout: 60000 });
  return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
}

function nonBlank(frame) {
  let n = 0;
  for (const row of frame.cells) for (const c of row) if (c && c.c !== '' && c.c !== ' ') n++;
  return n;
}

let SKIP = null, FRAMES = null, WHAT = '';
before(async () => {
  SKIP = liveRenderSkipReason() || harnessMissing() || providerSkipReason(process.env) || null;
  if (SKIP) return;
  const ref = nativeClaude();
  if (!ref) { SKIP = 'no native claude (set CLODE_NATIVE_CLAUDE, or put `claude` on PATH)'; return; }
  const built = builtQuaude();
  if (built.skip) { SKIP = built.skip; return; }
  const rv = versionOf(ref), qv = versionOf(built.path);
  if (!rv || rv !== qv) {
    SKIP = `native and quaude are not the same version, so their frames are not comparable: `
      + `${ref} says ${JSON.stringify(rv)}, ${built.path} says ${JSON.stringify(qv)}`;
    return;
  }
  WHAT = `native ${ref} (${rv}) vs quaude ${built.path}, ${COLS}x${ROWS}, ${SECONDS}s`;
  FRAMES = await captureFrames({ ref, sub: built.path, seconds: SECONDS, rows: ROWS, cols: COLS });
  // A capture that produced no frame is a harness failure, and it must SAY so
  // rather than skip quietly: the whole point is that this runs.
  if (!FRAMES.ref || !FRAMES.sub) {
    throw new Error(`frame capture failed (${WHAT}): ref=${!!FRAMES.ref} sub=${!!FRAMES.sub}; see stderr`);
  }
});

// A synthetic control that is a real-shaped frame: FLOOR+50 painted cells, so
// the control clears the floor and its finding is the diff, not the floor.
function controlFrame() {
  const cells = [];
  let painted = 0;
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      const on = painted < FLOOR + 50 && x < 60;
      if (on) painted++;
      row.push({ c: on ? String.fromCharCode(0x41 + (x % 26)) : '', w: 1, f: '0:-1', b: '0:-1', a: 0, l: null });
    }
    cells.push(row);
  }
  return { format: 1, cols: COLS, rows: ROWS, links: true, cells };
}

guardTests(defineGuard({
  name: 'tui-initial-frame-cells',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { ref: FRAMES.ref, sub: FRAMES.sub, what: WHAT };
  },
  scan({ ref, sub, what }) {
    const d = diff(ref, sub, { maxDetail: 30 });
    const findings = [];
    // Refuse to claim link equality from a capture that could not see links.
    if (!d.linksJudged) findings.push('hyperlinks were NOT observable in one of the frames, so equality cannot be claimed');
    if (!d.equal) findings.push(describe(ref, sub, d));
    return { examined: nonBlank(ref), findings, note: what };
  },
  // The real regression, spelled as a frame: one glyph in the middle of painted
  // content differs. Using corrupt() — the same helper frame-diff.test.cjs
  // proves produces exactly one glyph difference against real pty captures.
  control() {
    const ref = controlFrame();
    return { ref, sub: corrupt(cloneFrame(ref), 'glyph', { y: 1, x: 10 }), what: 'synthetic control' };
  },
}));
