#!/usr/bin/env node
'use strict';
// tui-screen.cjs SECONDS [--send-hex HEX] [--then-hex HEX@DELAY] [--rows R --cols C] -- cmd [args...]
//
// JS port of tui_screen.py. Drives a TUI command under a real pseudo-terminal
// (node-pty) with a real VT100 emulator (@xterm/headless) on the other end, so
// capability-query-gated apps (Claude Code's Ink TUI probes DA/DSR/OSC/XTVERSION
// at startup and waits for answers) actually render. Prints the final rendered
// screen to stdout for the test to assert on. Exit 0 always.
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

// Probes xterm doesn't answer (xterm extensions / OSC colors): supply plausible
// replies so the TUI's startup negotiation completes. Ported from tui_screen.py.
const EXTRA_PROBES = [
  ['\x1b]11;?', 'osc11', '\x1b]11;rgb:0000/0000/0000\x07'],
  ['\x1b]10;?', 'osc10', '\x1b]10;rgb:ffff/ffff/ffff\x07'],
  ['\x1b[>0q',  'xtver', '\x1bP>|pyte\x1b\\'],
  ['\x1b[>c',   'da2',   '\x1b[>0;10;1c'],
  ['\x1b[>0c',  'da2',   '\x1b[>0;10;1c'],
];

// Note: --send-hex/--then-hex decode hex to a latin1 string then child.write()s
// it (re-encoded UTF-8). All current fixtures are ASCII (/doctor, CR), so this is
// exact; a byte >= 0x80 would need a Buffer write to stay faithful to the bytes.
function parseArgs(argv) {
  const sends = []; let rows = 40, cols = 100;
  while (argv.length >= 2 && ['--send-hex', '--then-hex', '--rows', '--cols'].includes(argv[1])) {
    const v = argv[2];
    if (argv[1] === '--send-hex') sends.push([1.5, Buffer.from(v, 'hex').toString('latin1')]);
    else if (argv[1] === '--then-hex') {
      const [hex, delay] = v.split('@');
      sends.push([parseFloat(delay), Buffer.from(hex, 'hex').toString('latin1')]);
    } else if (argv[1] === '--rows') rows = parseInt(v, 10);
    else if (argv[1] === '--cols') cols = parseInt(v, 10);
    argv = [argv[0]].concat(argv.slice(3));
  }
  sends.sort((a, b) => a[0] - b[0]);
  if (argv.length < 3 || argv[1] !== '--') {
    process.stderr.write('usage: tui-screen.cjs SECONDS [--send-hex HEX] [--then-hex HEX@DELAY] [--rows R --cols C] -- cmd ...\n');
    process.exit(2);
  }
  return { secs: parseFloat(argv[0]), cmd: argv.slice(2), sends, rows, cols };
}

async function main() {
  const { secs, cmd, sends, rows, cols } = parseArgs(process.argv.slice(2));
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

  const start = Date.now();
  await new Promise((res) => {
    const iv = setInterval(() => { if (exited || (Date.now() - start) / 1000 > secs) { clearInterval(iv); res(); } }, 100);
  });
  try { child.kill('SIGKILL'); } catch { /* */ }

  if (process.env.TUI_DEBUG) {
    process.stderr.write(`RAW bytes=${seen.length} answered=${[...answered].sort()}\n`);
    process.stderr.write(`RAW tail: ${JSON.stringify(seen.slice(-160))}\n`);
  }

  const buf = term.buffer.active; const out = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}
// Honor the "Exit 0 always" contract even if pty.spawn/setup throws: fail loud
// with a nonzero exit rather than crashing on an unhandled rejection.
main().catch((e) => {
  process.stderr.write('tui-screen: ' + ((e && e.stack) || e) + '\n');
  process.exit(2);
});
