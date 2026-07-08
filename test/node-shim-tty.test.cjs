'use strict';
// Characterization: node:tty + process stdio TTY behavior under tjs must match
// host node for the same fixture, run under a real PTY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { runLoaderPty, runNodePty, extractMark } = require('./node-shim-tty-helper.cjs');

function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tty-'));
  const f = path.join(dir, 'fx.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('isatty(0/1/2) is true under a PTY, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const tty = require('node:tty');
    console.log('@@TTY@@' + JSON.stringify({
      i0: tty.isatty(0), i1: tty.isatty(1), i2: tty.isatty(2), i9: tty.isatty(9),
    }));
  `);
  const nodeOut = extractMark((await runNodePty(f, { ms: 3000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { ms: 3000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { i0: true, i1: true, i2: true, i9: false });
});

test('process.stdout columns/rows/isTTY under an 80x24 PTY match host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    console.log('@@TTY@@' + JSON.stringify({
      isTTY: process.stdout.isTTY === true,
      cols: process.stdout.columns, rows: process.stdout.rows,
      win: (process.stdout.getWindowSize ? process.stdout.getWindowSize() : null),
      colors: (process.stdout.hasColors ? process.stdout.hasColors() : null),
    }));
  `);
  const nodeOut = extractMark((await runNodePty(f, { cols: 80, rows: 24, ms: 3000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { cols: 80, rows: 24, ms: 3000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.strictEqual(tjsOut.cols, 80);
  assert.strictEqual(tjsOut.rows, 24);
});

test('process.stdout emits resize with updated columns on SIGWINCH', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    process.stdout.on('resize', () => {
      console.log('@@TTY@@' + JSON.stringify({ cols: process.stdout.columns }));
    });
    setTimeout(() => {}, 3000); // stay alive for the resize
  `);
  const { loadPty } = require('./node-shim-tty-helper.cjs');
  const pty = loadPty();
  const run = (cmd, args) => new Promise((resolve) => {
    const p = pty.spawn(cmd, args, { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
    let out = ''; p.onData((d) => { out += d; });
    setTimeout(() => { try { p.resize(100, 30); } catch { /* */ } }, 700);
    setTimeout(() => { try { p.kill(); } catch { /* */ } resolve(out); }, 2500);
  });
  const { LOADER, tjsPath } = require('./node-shim-helper.cjs');
  const nodeOut = await run(process.execPath, [f]);
  const tjsOut = await run(tjsPath(), ['run', LOADER, f]);
  assert.match(nodeOut, /@@TTY@@\{"cols":100\}/);
  assert.match(tjsOut, /@@TTY@@\{"cols":100\}/);
});
