#!/usr/bin/env node
'use strict';
// tui-screen.cjs SECONDS [--send-hex HEX] [--then-hex HEX@DELAY] [--rows R --cols C] -- cmd [args...]
//
// JS port of tui_screen.py. Drives a TUI command under a real pseudo-terminal
// (node-pty) with a real VT100 emulator (@xterm/headless) on the other end, so
// capability-query-gated apps (Claude Code's Ink TUI probes DA/DSR/OSC/XTVERSION
// at startup and waits for answers) actually render. Prints the final rendered
// screen to stdout for the test to assert on. Exit 0 always.
// Load the PTY harness (node-pty + @xterm/headless) from the per-platform tag dir
// EXPLICITLY, not via NODE_PATH. Callers like test_tui.bats' _tui_capture scrub
// NODE_PATH so the world prefix alone decides the child's `ws` visibility; that must
// not also starve this driver of its harness. Fall back to bare require (normal
// resolution / an explicit NODE_PATH) when the tag dir isn't present.
const path = require('node:path');
function loadHarness() {
  try {
    const REPO = path.resolve(__dirname, '..');
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    const nm = path.join(harnessDir(REPO), 'node_modules');
    return { pty: require(path.join(nm, 'node-pty')), Terminal: require(path.join(nm, '@xterm/headless')).Terminal };
  } catch {
    return { pty: require('node-pty'), Terminal: require('@xterm/headless').Terminal };
  }
}
// Loaded inside main(), not at require time, so a test can require this file for
// hexPayload() alone on a box with no PTY harness.

// Probes xterm doesn't answer (xterm extensions / OSC colors): supply plausible
// replies so the TUI's startup negotiation completes. Ported from tui_screen.py.
const EXTRA_PROBES = [
  ['\x1b]11;?', 'osc11', '\x1b]11;rgb:0000/0000/0000\x07'],
  ['\x1b]10;?', 'osc10', '\x1b]10;rgb:ffff/ffff/ffff\x07'],
  ['\x1b[>0q',  'xtver', '\x1bP>|pyte\x1b\\'],
  ['\x1b[>c',   'da2',   '\x1b[>0;10;1c'],
  ['\x1b[>0c',  'da2',   '\x1b[>0;10;1c'],
];

// --send-hex/--then-hex carry BYTES, and the child must receive exactly those bytes.
// They used to be decoded as latin1 and child.write() re-encoded the string as UTF-8, so any
// byte >= 0x80 arrived doubled (U+00E4 for 0xE4 -> C3 A4): exact for the ASCII fixtures
// (/doctor, CR), mojibake for the first non-ASCII one (the wide-glyph frame scene, 2026-09-25).
// A payload that is valid UTF-8 is written as the string it decodes to (node-pty encodes it
// back to the same bytes); anything else is written as the Buffer itself.
function hexPayload(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
}
function parseArgs(argv) {
  const sends = []; const resizes = []; let rows = 40, cols = 100;
  // --cells switches stdout from the ANSI-stripped text screen to a cell-level
  // frame (JSON; see dumpCells). It takes no value, so it is lifted out before
  // the value-flag loop below. Everything else is unchanged.
  let cells = false;
  {
    const cut = argv.indexOf('--');
    const at = argv.indexOf('--cells');
    if (at !== -1 && (cut === -1 || at < cut)) { cells = true; argv = argv.slice(0, at).concat(argv.slice(at + 1)); }
  }
  const FLAGS = ['--send-hex', '--then-hex', '--rows', '--cols', '--resize'];
  while (argv.length >= 2 && FLAGS.includes(argv[1])) {
    const v = argv[2];
    if (argv[1] === '--send-hex') sends.push([1.5, hexPayload(v)]);
    else if (argv[1] === '--then-hex') {
      const [hex, delay] = v.split('@');
      sends.push([parseFloat(delay), hexPayload(hex)]);
    } else if (argv[1] === '--rows') rows = parseInt(v, 10);
    else if (argv[1] === '--cols') cols = parseInt(v, 10);
    else if (argv[1] === '--resize') {
      // COLSxROWS@DELAY — at DELAY seconds, resize the PTY (delivers SIGWINCH to
      // the child) and the emulator, so a resize-reflow can be asserted.
      const [dim, delay] = v.split('@');
      const [c, r] = dim.split('x').map((n) => parseInt(n, 10));
      resizes.push([parseFloat(delay), c, r]);
    }
    argv = [argv[0]].concat(argv.slice(3));
  }
  sends.sort((a, b) => a[0] - b[0]);
  if (argv.length < 3 || argv[1] !== '--') {
    process.stderr.write('usage: tui-screen.cjs SECONDS [--cells] [--send-hex HEX] [--then-hex HEX@DELAY] [--resize COLSxROWS@DELAY] [--rows R --cols C] -- cmd ...\n');
    process.exit(2);
  }
  return { secs: parseFloat(argv[0]), cmd: argv.slice(2), sends, resizes, rows, cols, cells };
}

// Cell-level frame capture. The text screen above answers "what words are on
// screen"; it cannot answer "is this wide char's spacer in the right place",
// "is this styled the same" or "is this the same hyperlink" — the three things
// a cell segmenter can get wrong while the text stays identical. So --cells
// emits every cell's glyph, its emulator-assigned width, its SGR attributes and
// its OSC-8 target.
//
// Widths are the EMULATOR's: xterm gives the first half of a double-width
// grapheme width 2 and its trailing half width 0 (an empty-string cell). That is
// the outside-observable shadow of the screen model's narrow/wide/spacer words.
//
// OSC-8 has no public accessor in @xterm/headless 5.5, so it is read through two
// internals: the buffer line's per-column `_extendedAttrs[x].urlId`, and the
// core's `_oscLinkService.getLinkData(id).uri`. Both are feature-detected, and
// when either is missing the frame records `links:false` so a comparison REFUSES
// to claim it checked hyperlinks rather than silently passing.
function dumpCells(term) {
  const buf = term.buffer.active;
  let osc = null;
  try { osc = term._core && term._core._oscLinkService; } catch { osc = null; }
  let links = !!(osc && typeof osc.getLinkData === 'function');
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(y);
    const row = [];
    if (!line) { rows.push(row); continue; }
    let ext = null;
    try { ext = line._line && line._line._extendedAttrs; } catch { ext = null; }
    if (!ext) links = false;
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) { row.push({ c: '', w: 1, f: 'd:0', b: 'd:0', a: 0, l: null }); continue; }
      const a = (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0) | (cell.isDim() ? 4 : 0)
        | (cell.isUnderline() ? 8 : 0) | (cell.isBlink() ? 16 : 0) | (cell.isInverse() ? 32 : 0)
        | (cell.isInvisible() ? 64 : 0) | (cell.isStrikethrough() ? 128 : 0) | (cell.isOverline() ? 256 : 0);
      let l = null;
      if (links) {
        try {
          const id = ext[x] && ext[x].urlId;
          if (id) l = (osc.getLinkData(id) || {}).uri || null;
        } catch { l = null; }
      }
      row.push({
        c: cell.getChars(),
        w: cell.getWidth(),
        f: cell.getFgColorMode() + ':' + cell.getFgColor(),
        b: cell.getBgColorMode() + ':' + cell.getBgColor(),
        a,
        l,
      });
    }
    rows.push(row);
  }
  return { format: 'clode-frame-v1', cols: term.cols, rows: term.rows, links, cells: rows };
}

async function main() {
  const { secs, cmd, sends, resizes, rows, cols, cells } = parseArgs(process.argv.slice(2));
  const { pty, Terminal } = loadHarness();
  const term = new Terminal({ rows, cols, allowProposedApi: true });
  const child = pty.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols, rows, env: process.env });

  term.onData((d) => { try { child.write(d); } catch { /* closing */ } });   // DA/DSR auto-replies

  let seen = ''; const answered = new Set();
  child.onData((d) => {
    term.write(d); seen += d;
    for (const [needle, key, resp] of EXTRA_PROBES) {
      if (seen.includes(needle) && !answered.has(key)) { answered.add(key); try { child.write(resp); } catch { /* */ } }
    }
  });

  let exited = false;
  child.onExit(() => { exited = true; });
  for (const [delay, bytes] of sends) setTimeout(() => { try { child.write(bytes); } catch { /* */ } }, delay * 1000);
  for (const [delay, c, r] of resizes) setTimeout(() => {
    try { child.resize(c, r); term.resize(c, r); } catch { /* closing */ }
  }, delay * 1000);

  const start = Date.now();
  await new Promise((res) => {
    const iv = setInterval(() => { if (exited || (Date.now() - start) / 1000 > secs) { clearInterval(iv); res(); } }, 100);
  });
  try { child.kill('SIGKILL'); } catch { /* */ }

  if (process.env.TUI_DEBUG) {
    process.stderr.write(`RAW bytes=${seen.length} answered=${[...answered].sort()}\n`);
    process.stderr.write(`RAW tail: ${JSON.stringify(seen.slice(-160))}\n`);
  }

  if (cells) { finish(JSON.stringify(dumpCells(term)) + '\n'); return; }

  const buf = term.buffer.active; const out = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  finish(out.join('\n') + '\n');
}

// Write the result, THEN exit — never the other way round. stdout to a pipe is
// asynchronous, so `write(); process.exit(0)` silently truncates at the pipe
// buffer (64 KiB). A --cells frame is far bigger than that, and a truncated
// frame is the worst possible failure for a differential harness: it looks like
// a real capture that happens to differ. The exit waits for the flush callback,
// with a timer so a wedged pipe still terminates rather than hanging the test.
function finish(text) {
  let done = false;
  const bye = (code) => { if (!done) { done = true; process.exit(code); } };
  const timer = setTimeout(() => bye(3), 10000);
  timer.unref();
  process.stdout.write(text, () => bye(0));
}
module.exports = { hexPayload };

// Honor the "Exit 0 always" contract even if pty.spawn/setup throws: fail loud
// with a nonzero exit rather than crashing on an unhandled rejection.
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('tui-screen: ' + ((e && e.stack) || e) + '\n');
    process.exit(2);
  });
}
