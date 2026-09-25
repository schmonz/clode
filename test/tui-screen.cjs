#!/usr/bin/env node
'use strict';
// tui-screen.cjs SECONDS [--send-hex HEX] [--then-hex HEX@DELAY] [--rows R --cols C] -- cmd [args...]
// tui-screen.cjs 0 --script FILE [--settle-ms N] [--max-settle-ms M] [--boot-settle-ms Q]
//                [--boot-max-ms B] [--rows R --cols C] -- cmd [args...]
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
const fs = require('node:fs');
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
// --script: a frame per scripted step, each taken when the TUI's output has SETTLED.
// A fixed-duration capture answers "what is on screen at t=20s"; a session needs "what is
// on screen after this step", for every step, on two different builds whose speeds differ
// by seconds. So each frame is taken when output has gone quiet, never at a clock time.
//
// The defaults are MEASURED (CellSegmenter phase 5, task 3, 2026-09-25, darwin-arm64,
// native 2.1.278 and 2.1.251 and a quaude built from 2.1.278, alone and with 18 boots at
// once; the numbers are in that task's report):
//   settleMs 800       a step's quiet window, counted from the step's own output. Every
//                      type-edit keystroke was answered in ONE paint, 6-77 ms after it was
//                      sent, and no step had two writes more than 61 ms apart.
//   maxSettleMs 15000  a step's cap. A step still painting (or never answered) after it is
//                      reported unsettled -- a finding -- never captured and called settled.
//   bootSettleMs 12000 the boot frame's quiet window, longer than every self-timed element of
//                      the welcome screen: the Clawd entrance animation (a random one of four
//                      sequences of 60 ms frames; up to 1314 ms between two frames with 18
//                      boots at once) and the effort-level notification (timeoutMs 1e4 in the
//                      bundle), which cleared 9.68-9.96 s after the first paint in every run
//                      and 7.4-9.25 s after the animation's last frame. A shorter window takes
//                      the boot frame mid-animation or during that notification, and a later
//                      step then repaints it at a moment that depends on load. Both builds
//                      also went up to 1451 ms silent between their first bytes and their
//                      first paint: with an 800 ms boot window 3 of 8 concurrent native pairs
//                      took a BLANK boot frame and differed from their twins.
//   bootMaxMs 60000    the boot cap: boot took 22.5-23.4 s on native (first paint + the 10 s
//                      notification + the 12 s window); quaude's first paint came 13.5 s
//                      after spawn at worst, which puts its boot at about 35 s.
const SCRIPT_DEFAULTS = Object.freeze({ settleMs: 800, maxSettleMs: 15000, bootSettleMs: 12000, bootMaxMs: 60000 });

// One step's frame is ready when output has been quiet for quietMs -- counted from output
// that came AFTER the step (needOutput), because quiet from before the step is the previous
// frame's quiet: right after a keystroke it has already lasted a whole window, and a frame
// taken then shows the screen before the TUI painted the key. A `wait` step expects no
// output (it is how a script lets a self-timed element run out), so earlier quiet counts.
// `since` is when the step acted (boot: the spawn). Pure, so the rule is unit-tested.
function settleVerdict({ now, since, lastOut, quietMs, maxMs, needOutput }) {
  const heard = !needOutput || lastOut >= since;
  if (heard && now - lastOut >= quietMs) return 'settled';
  if (now - since >= maxMs) return 'timeout';
  return 'wait';
}

// A script is a JSON array of steps, each { label, send: HEX } | { label, resize: 'COLSxROWS' }
// | { label, wait: MS }. Labels name the frames the gates report, so they are unique and
// never 'boot' (frame 0's label). Refused loudly: a typo'd step that silently did nothing
// would still produce a frame, and two builds agreeing on a step that never happened is a
// pass that judged nothing.
function parseScript(steps) {
  if (!Array.isArray(steps)) throw new Error('a script must be a JSON array of steps');
  if (steps.length === 0) throw new Error('a script with no steps captures nothing but boot');
  const seen = new Set();
  return steps.map((st, i) => {
    if (!st || typeof st.label !== 'string' || st.label === '') throw new Error(`step ${i} needs a non-empty string label`);
    const { label } = st;
    if (label === 'boot') throw new Error(`step ${i}: "boot" is the boot frame's label`);
    if (seen.has(label)) throw new Error(`step ${i}: label "${label}" is used twice`);
    seen.add(label);
    for (const k of Object.keys(st)) {
      if (!['label', 'send', 'resize', 'wait'].includes(k)) throw new Error(`step "${label}": unknown key "${k}"`);
    }
    const acts = ['send', 'resize', 'wait'].filter((k) => st[k] !== undefined);
    if (acts.length !== 1) throw new Error(`step "${label}" needs exactly one of send, resize, wait`);
    if (acts[0] === 'send') {
      if (typeof st.send !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(st.send)) throw new Error(`step "${label}": send must be an even-length hex string`);
      return { label, send: st.send };
    }
    if (acts[0] === 'resize') {
      const m = typeof st.resize === 'string' && /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(st.resize);
      if (!m) throw new Error(`step "${label}": resize must be "COLSxROWS"`);
      return { label, resize: { cols: parseInt(m[1], 10), rows: parseInt(m[2], 10) } };
    }
    if (!Number.isInteger(st.wait) || st.wait <= 0) throw new Error(`step "${label}": wait must be a positive integer of milliseconds`);
    return { label, wait: st.wait };
  });
}

function parseArgs(argv) {
  const sends = []; const resizes = []; let rows = 40, cols = 100;
  let script = null; const limits = { ...SCRIPT_DEFAULTS };
  // --cells switches stdout from the ANSI-stripped text screen to a cell-level
  // frame (JSON; see dumpCells). It takes no value, so it is lifted out before
  // the value-flag loop below. Everything else is unchanged.
  let cells = false;
  {
    const cut = argv.indexOf('--');
    const at = argv.indexOf('--cells');
    if (at !== -1 && (cut === -1 || at < cut)) { cells = true; argv = argv.slice(0, at).concat(argv.slice(at + 1)); }
  }
  const LIMITS = { '--settle-ms': 'settleMs', '--max-settle-ms': 'maxSettleMs', '--boot-settle-ms': 'bootSettleMs', '--boot-max-ms': 'bootMaxMs' };
  const FLAGS = ['--send-hex', '--then-hex', '--rows', '--cols', '--resize', '--script', ...Object.keys(LIMITS)];
  while (argv.length >= 2 && FLAGS.includes(argv[1])) {
    const v = argv[2];
    if (argv[1] === '--script') script = v;
    else if (LIMITS[argv[1]]) {
      // Refused, not defaulted: a NaN limit makes every settle comparison false, so the
      // step would neither settle nor time out and the capture would never end.
      if (!/^[1-9][0-9]*$/.test(v || '')) throw new Error(`${argv[1]} must be a positive integer of milliseconds, not "${v}"`);
      limits[LIMITS[argv[1]]] = parseInt(v, 10);
    }
    else if (argv[1] === '--send-hex') sends.push([1.5, hexPayload(v)]);
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
    process.stderr.write('usage: tui-screen.cjs SECONDS [--cells] [--send-hex HEX] [--then-hex HEX@DELAY] [--resize COLSxROWS@DELAY] [--rows R --cols C] -- cmd ...\n'
      + '       tui-screen.cjs 0 --script FILE [--settle-ms N] [--max-settle-ms M] [--boot-settle-ms Q] [--boot-max-ms B] [--rows R --cols C] -- cmd ...\n');
    process.exit(2);
  }
  // A script's output is a sequence of CELL frames: there is no text form of it. SECONDS is
  // not consulted with --script; every wait is bounded by the settle caps instead.
  if (script !== null) cells = true;
  return { secs: parseFloat(argv[0]), cmd: argv.slice(2), sends, resizes, rows, cols, cells, script, ...limits };
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
  const opts = parseArgs(process.argv.slice(2));
  const { secs, cmd, sends, resizes, rows, cols, cells } = opts;
  // Read and check the script BEFORE anything is spawned: a bad script never starts a TUI.
  const steps = opts.script === null ? null : parseScript(JSON.parse(fs.readFileSync(opts.script, 'utf8')));
  const { pty, Terminal } = loadHarness();
  const term = new Terminal({ rows, cols, allowProposedApi: true });
  const spawnedAt = Date.now();
  const child = pty.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols, rows, env: process.env });

  term.onData((d) => { try { child.write(d); } catch { /* closing */ } });   // DA/DSR auto-replies

  // `lastOut` is when the child last wrote anything (-Infinity: never), which is all the
  // settle rule needs. Replies to its probes are OUR writes, not its output.
  const state = { lastOut: -Infinity, exited: false, exit: null, current: 'boot' };
  let seen = ''; const answered = new Set();
  child.onData((d) => {
    state.lastOut = Date.now();
    term.write(d); seen += d;
    for (const [needle, key, resp] of EXTRA_PROBES) {
      if (seen.includes(needle) && !answered.has(key)) { answered.add(key); try { child.write(resp); } catch { /* */ } }
    }
  });

  let exited = false;
  child.onExit((e) => {
    exited = true; state.exited = true;
    state.exit = { during: state.current, code: e ? e.exitCode : null, signal: (e && e.signal) || null };
  });

  if (steps) {
    const frames = await runScript({ steps, child, term, state, spawnedAt, opts });
    try { child.kill('SIGKILL'); } catch { /* */ }
    finish(JSON.stringify({ format: 'clode-frames-v1', exit: state.exit, frames }) + '\n');
    return;
  }
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

// The scripted session: frame 0 when boot has settled, then one frame per step after
// that step settles (see settleVerdict). A child that exits ends the script: its last
// frame is marked unsettled and no frame is invented for a step it never saw.
async function runScript({ steps, child, term, state, spawnedAt, opts }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async (since, quietMs, maxMs, needOutput) => {
    for (;;) {
      await sleep(50);
      const now = Date.now();
      if (state.exited) return { settled: false, ms: now - since };
      const v = settleVerdict({ now, since, lastOut: state.lastOut, quietMs, maxMs, needOutput });
      if (v !== 'wait') return { settled: v === 'settled', ms: now - since };
    }
  };
  const frames = [];
  const snap = async (label, s) => {
    // xterm parses writes asynchronously: an empty write's callback runs once everything
    // written before it is on the screen, so the frame can never miss the last paint.
    await new Promise((r) => term.write('', r));
    frames.push({ label, settled: s.settled, ms: s.ms, frame: dumpCells(term) });
    if (process.env.TUI_DEBUG) process.stderr.write(`frame ${JSON.stringify(label)} settled=${s.settled} ms=${s.ms}\n`);
  };
  await snap('boot', await settle(spawnedAt, opts.bootSettleMs, opts.bootMaxMs, true));
  for (const st of steps) {
    if (state.exited) break;
    state.current = st.label;
    let since = Date.now();
    if (st.send !== undefined) {
      try { child.write(hexPayload(st.send)); } catch { /* exited; the settle below says so */ }
    } else if (st.resize) {
      try { child.resize(st.resize.cols, st.resize.rows); term.resize(st.resize.cols, st.resize.rows); } catch { /* exited */ }
    } else {
      await sleep(st.wait);
      since = Date.now();
    }
    await snap(st.label, await settle(since, opts.settleMs, opts.maxSettleMs, st.wait === undefined));
  }
  return frames;
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
module.exports = { hexPayload, parseArgs, parseScript, settleVerdict, SCRIPT_DEFAULTS, loadHarness };

// Honor the "Exit 0 always" contract even if pty.spawn/setup throws: fail loud
// with a nonzero exit rather than crashing on an unhandled rejection.
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('tui-screen: ' + ((e && e.stack) || e) + '\n');
    process.exit(2);
  });
}
