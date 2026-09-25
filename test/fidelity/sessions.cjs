'use strict';
// The ONE statement of every CellSegmenter phase-5 session script: the determinism guard
// (session-determinism.test.cjs), native-vs-quaude (interactive-session-diff) and
// reset-invisibility all run exactly these, so a script fixed for one is fixed for all.
//
// A session is a script for tui-screen.cjs --script: frame 0 is boot (taken once the
// welcome screen is at rest -- see SCRIPT_DEFAULTS.bootSettleMs there for the entrance
// animation and the 10 s effort notification it waits out), then one frame per step,
// each taken when that step's output has settled. Every non-ASCII string is built from
// CODE POINTS: an editor normalises a typed `e U+0301` into U+00E9, which is not a
// combining mark, and this repo's tools can turn a typed backslash-u escape into the
// literal (invisible) character.
//
// Each entry: { script, mockText, settings, env, rows, cols, mustShow }. `mustShow` is
// text the REFERENCE must paint in its LAST frame, or the session judged nothing it exists
// for (a TUI that ignored the keystrokes paints two identical, useless sequences).
const CP = (...c) => String.fromCodePoint(...c);
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const BS = '\x7f';

const SESSIONS = {
  // Type, erase and retype in the prompt: wide CJK, an emoji with a skin tone and base +
  // combining marks, each erased by backspace so the next frame repaints cells the previous
  // one filled. No Enter: no turn. (Paint's own damage does not decide these repaints,
  // measured in task 4: see interactive-session-diff.test.cjs.)
  //
  // THE MARKS, MEASURED (2.1.278, task 3): the prompt NFC-normalises what is typed, so
  // `e U+0301` is painted as the one precomposed code point U+00E9 -- a narrow single-code-
  // point cell, not a combining cluster -- and a `mustShow` spelled `e U+0301` never matched
  // native's own screen. `q U+0301` has no precomposed form, survives NFC, and is painted as
  // one cell holding both code points. So the step types both: the composition native
  // performs, and a real base + mark cluster on screen.
  'type-edit': {
    rows: 40, cols: 100,
    script: [
      { label: 'type ascii+wide', send: hex('abc' + CP(0x4e2d, 0x6587)) },
      { label: 'backspace x3', send: hex(BS + BS + BS) },
      { label: 'retype emoji', send: hex('xy' + CP(0x1f44d, 0x1f3fd)) },
      { label: 'backspace all', send: hex(BS.repeat(8)) },
      { label: 'retype marks', send: hex('e' + CP(0x301) + 'q' + CP(0x301) + ' ok') },
    ],
    mockText: 'PONG', settings: { showTurnDuration: false }, env: {},
    mustShow: CP(0xe9) + 'q' + CP(0x301) + ' ok',
  },
  // A turn, then the terminal resized under it: narrower, wider, then back. The reply is
  // long enough to wrap at every width the steps visit (4 rows at 60 columns, 2 at 100 and
  // at 120, each broken at a different word), and ends in wide CJK and an emoji, which each
  // reflow moves to another row and column. Shrinking first rewrites every row at fewer
  // columns; growing then leaves the columns past the old width to be repainted; the last
  // step returns to the boot geometry, where a layout stuck at a stale width shows (a
  // quaude that never saw SIGWINCH as 'resize' first differs there, measured in task 4).
  // showTurnDuration off: the line after a turn carries the wall-clock time otherwise.
  'resize': {
    rows: 40, cols: 100,
    script: [
      { label: 'ask', send: hex('hi') },
      { label: 'send', send: hex('\r') },
      { label: 'shrink 60x30', resize: '60x30' },
      { label: 'grow 120x40', resize: '120x40' },
      { label: 'back 100x40', resize: '100x40' },
    ],
    mockText: 'A reply long enough to wrap differently at every width the resize steps visit: '
      + 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau '
      + CP(0x4e2d, 0x6587) + ' ' + CP(0x1f44d) + ' end.',
    settings: { showTurnDuration: false }, env: {},
    mustShow: 'end.',
  },
};

module.exports = { SESSIONS };
