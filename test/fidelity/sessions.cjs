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
const ESC = '\x1b';

// The scroll session's reply: 121 numbered lines, three and a half screens at 40 rows.
// Every third line carries a run of wide CJK (160 or 164 columns, starting at a column that
// varies with the line's letters), line 100 is one unbroken 300-character token, and the
// last line is what `mustShow` looks for.
function scrollReply() {
  const lines = [];
  for (let i = 1; i <= 120; i++) {
    const n = String(i).padStart(3, '0');
    let line = `line ${n} ` + 'abcdefghij'.slice(0, 1 + (i % 10));
    if (i % 3 === 0) line += ' ' + CP(0x4e2d, 0x6587).repeat(40 + (i % 2)) + ' wide';
    if (i === 100) line = `line ${n} ` + 'x'.repeat(300);
    lines.push(line);
  }
  lines.push('line 121 end.');
  return lines.join('\n');
}

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
  // A reply longer than the screen, scrolled back and forth: up half a page twice, one
  // mouse-wheel notch up, down half a page, then Ctrl+End (the TUI's scroll:bottom). Each
  // page moves the viewport 17 lines and the notch 3, so every frame repaints the rows under
  // it; while scrolled up the TUI pins the prompt to row 0 and overlays "Jump to bottom" on
  // the viewport's last row, at "page up 2" across a line of wide glyphs (after the wheel,
  // the hint's text changes to its click form), and the steps after it repaint what that
  // overlay covered.
  //
  // MEASURED (2.1.278, task 5), each shaping the session:
  // - Nothing streams. The canned mock answers a turn with ONE text_delta in one response
  //   body, and native paints the whole reply within ~155 ms of Enter, then nothing more.
  //   So there is no mid-stream frame: `wait` steps after `send` settled in 52 ms on frames
  //   identical to it. The session scrolls instead of waiting.
  // - Never to the top. A PageUp that reaches the top kept both builds painting past the
  //   15 s cap (a shorter reply); two half pages up from the bottom of 121 lines stay clear.
  // - 320 columns. The bundle's segmenter wrapper holds 256 cells and grows and retries
  //   when a line needs more, but the TUI wraps every line to the screen before segmenting
  //   it: at 100 columns the widest segment() call was 100 cells, over a 300-character
  //   token in a paragraph, a code block, inline code, a table cell and a URL (a quaude
  //   that logged every call). At 320 the prompt's rules are 320-cell lines, which force the
  //   grow-and-retry at the first paint (320 cells against 256, then against 512), and line
  //   100's token is segmented whole, in one 309-cell call.
  // - CLODE_TTY_MOUSE=1 on both sides, for the wheel step: quaude leaves mouse tracking
  //   off by default on purpose (test/fidelity/RECIPE.md, intentional divergence X1) and
  //   drops the wheel report, and this knob is X1's route back to parity. Native does not
  //   read it. Without it the step differs at "wheel up", quaude never settling.
  'scroll': {
    rows: 40, cols: 320,
    script: [
      { label: 'ask', send: hex('hi') },
      { label: 'send', send: hex('\r') },
      { label: 'page up', send: hex(ESC + '[5~') },
      { label: 'page up 2', send: hex(ESC + '[5~') },
      { label: 'wheel up', send: hex(ESC + '[<64;50;20M') },
      { label: 'page down', send: hex(ESC + '[6~') },
      { label: 'end', send: hex(ESC + '[1;5F') },
    ],
    mockText: scrollReply(),
    settings: { showTurnDuration: false }, env: { CLODE_TTY_MOUSE: '1' },
    mustShow: 'line 121 end.',
  },
  // The slash-command menu, opened, filtered, closed, and opened and closed again: the menu
  // fills the rows above the prompt (5 rows, then 4 once filtered), each close blanks
  // them, and the next open repaints them.
  //
  // MEASURED (2.1.278, task 5): the menu opens under the harness's mock-API-key profile,
  // no login needed. ESC closes it and KEEPS the typed text, so a `/` typed next appends
  // (`/he/`) and opens nothing: the `clear` step erases `/he` first. Every ESC here meets
  // an open menu: an ESC with none open shows "Esc again to clear", which clears itself
  // ~1 s later, inside reach of an 800 ms settle window. `mustShow` is the prompt as
  // native paints it: U+276F, then U+00A0 (a NO-BREAK space: `U+276F /` with a plain space
  // never matched native's screen), then the slash.
  'slash-menu': {
    rows: 40, cols: 100,
    script: [
      { label: 'open', send: hex('/') },
      { label: 'filter', send: hex('he') },
      { label: 'dismiss', send: hex(ESC) },
      { label: 'clear', send: hex(BS.repeat(3)) },
      { label: 'reopen', send: hex('/') },
      { label: 'dismiss again', send: hex(ESC) },
    ],
    mockText: 'PONG', settings: { showTurnDuration: false }, env: {},
    mustShow: CP(0x276f, 0xa0) + '/',
  },
};

module.exports = { SESSIONS };
