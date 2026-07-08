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

function ptyRun({ cmd, args = [], cols = 80, rows = 24, input, inputDelayMs = 400, ms = 4000 }) {
  const pty = loadPty();
  return new Promise((resolve) => {
    const p = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, env: process.env });
    let out = '';
    let done = false;
    p.onData((d) => { out += d; });
    const finish = (code) => { if (done) return; done = true; try { p.kill(); } catch { /* */ } resolve({ out, code }); };
    p.onExit(({ exitCode }) => finish(exitCode));
    if (input != null) setTimeout(() => { try { p.write(input); } catch { /* */ } }, inputDelayMs);
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
