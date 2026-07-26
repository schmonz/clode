'use strict';
// PTY runner for TTY characterization. The plain runLoader (node-shim-helper)
// spawns with pipes, so a fixture there always sees isTerminal=false. To
// exercise the terminal path we must run under a real pseudo-terminal; node-pty
// (loaded from the per-platform harness tag dir, like tui-screen.cjs) provides it.
const path = require('node:path');
const { LOADER, tjsPath } = require('./node-shim-helper.cjs');

const REPO = path.resolve(__dirname, '..');
function loadPty() {
  try {
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    return require(path.join(harnessDir(REPO), 'node_modules', 'node-pty'));
  } catch {
    return require('node-pty');
  }
}

// readyMark: gate input on a fixture-emitted readiness marker instead of a fixed
// timer. A RAW-mode fixture must have called setRawMode(true) + attached its
// listener BEFORE the first byte arrives — otherwise the leading input is
// processed in COOKED mode (line-disciplined, echoed, or held for a newline that
// never comes) and the fixture never sees it. A fixed inputDelayMs is a guess a
// loaded child boot can outrun (a real, load-sensitive flake on NetBSD under the
// full suite); waiting for the marker removes the guess. Cooked-mode fixtures are
// race-free (the PTY buffers input until read) and can keep the plain delay.
// ms is the FAILURE deadline, not the happy-path duration: every fixture prints
// its @@TTY@@ line and exits, so onExit resolves early — a generous default only
// buys slack for slow boots (loaded boxes, qemu-emulated CI legs) and is free when
// the test passes. Keep it well above the worst realistic tjs+node boot.
function ptyRun({ cmd, args = [], cols = 80, rows = 24, input, inputDelayMs = 400, readyMark, ms = 12000, env }) {
  const pty = loadPty();
  return new Promise((resolve) => {
    const p = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, env: env || process.env });
    let out = '';
    let done = false;
    let wrote = false;
    const writeInput = () => { if (wrote || input == null) return; wrote = true; try { p.write(input); } catch { /* */ } };
    p.onData((d) => {
      out += d;
      if (readyMark && !wrote && out.includes(readyMark)) writeInput();
    });
    const finish = (code) => { if (done) return; done = true; try { p.kill(); } catch { /* */ } resolve({ out, code }); };
    p.onExit(({ exitCode }) => finish(exitCode));
    if (input != null && !readyMark) setTimeout(writeInput, inputDelayMs);
    setTimeout(() => finish(null), ms);
  });
}

function runLoaderPty(entry, opts = {}) {
  const tjs = tjsPath();
  if (!tjs) throw new Error('no tjs binary (gate with skipUnlessTjs first)');
  return ptyRun({ cmd: tjs, args: ['run', LOADER, entry], ...opts });
}

function runNodePty(entry, opts = {}) {
  return ptyRun({ cmd: process.execPath, args: [entry], ...opts });
}

// Pull a fixture's marked JSON line out of raw PTY output (which carries CRs and
// possible echo). Fixtures print `@@TTY@@{...json...}` on its own line.
function extractMark(out) {
  const m = out.match(/@@TTY@@(\{.*?\})/);
  return m ? JSON.parse(m[1]) : null;
}

module.exports = { ptyRun, runLoaderPty, runNodePty, extractMark, loadPty };
