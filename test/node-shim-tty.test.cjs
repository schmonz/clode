'use strict';
// Characterization: node:tty + process stdio TTY behavior under tjs must match
// host node for the same fixture, run under a real PTY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, LOADER, tjsPath } = require('./node-shim-helper.cjs');
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

test('process.stdin isTTY + setRawMode toggles isRaw, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const before = process.stdin.isRaw === true;
    process.stdin.setRawMode(true);
    const during = process.stdin.isRaw === true;
    process.stdin.setRawMode(false);
    console.log('@@TTY@@' + JSON.stringify({ isTTY: process.stdin.isTTY === true, before, during }));
  `);
  const nodeOut = extractMark((await runNodePty(f, { ms: 3000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { ms: 3000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { isTTY: true, before: false, during: true });
});

test('process.stdin delivers raw keystrokes in order, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    let got = '';
    process.stdin.on('data', (d) => {
      got += d;
      if (got.length >= 3) {
        const hex = Buffer.from(got, 'utf8').toString('hex');
        console.log('@@TTY@@' + JSON.stringify({ hex }));
        process.exit(0);
      }
    });
    process.stdin.resume();
  `);
  const nodeOut = extractMark((await runNodePty(f, { input: 'xyz', inputDelayMs: 500, ms: 4000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { input: 'xyz', inputDelayMs: 500, ms: 4000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { hex: '78797a' }); // 'xyz'
});

// Characterization for the streaming-utf8-decode fix (Finding 1): the 4-byte
// emoji U+1F642 (bytes F0 9F 99 82) is written to the PTY as TWO separate
// writes ~500ms apart, so the shim's async pump necessarily delivers it as two
// chunks. Each write is a raw Buffer (bypassing node-pty's string encoding, see
// its CustomWriteStream.write: `typeof data === 'string' ? Buffer.from(data,
// encoding) : Buffer.from(data)`) so the exact split bytes reach the pty fd
// untouched. A persistent decoder must reassemble the sequence across the two
// pump reads instead of emitting U+FFFD for the dangling lead bytes.
test('a UTF-8 char split across two PTY writes reassembles via streaming decode, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    let got = '';
    process.stdin.on('data', (d) => {
      got += d;
      if (got.length > 0) {
        const hex = Buffer.from(got, 'utf8').toString('hex');
        console.log('@@TTY@@' + JSON.stringify({ got, hex }));
        process.exit(0);
      }
    });
  `);
  const { loadPty } = require('./node-shim-tty-helper.cjs');
  const { LOADER, tjsPath } = require('./node-shim-helper.cjs');
  const pty = loadPty();
  const emoji = Buffer.from('\u{1F642}', 'utf8'); // f0 9f 99 82 ('🙂')
  const run = (cmd, args) => new Promise((resolve) => {
    const p = pty.spawn(cmd, args, { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
    let out = '';
    let done = false;
    p.onData((d) => { out += d; });
    const finish = () => { if (done) return; done = true; try { p.kill(); } catch { /* */ } resolve(out); };
    p.onExit(finish);
    setTimeout(() => { try { p.write(emoji.subarray(0, 2)); } catch { /* */ } }, 300);
    setTimeout(() => { try { p.write(emoji.subarray(2, 4)); } catch { /* */ } }, 800);
    setTimeout(finish, 3000);
  });
  const nodeOut = extractMark(await run(process.execPath, [f]));
  const tjsOut = extractMark(await run(tjsPath(), ['run', LOADER, f]));
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { got: '\u{1F642}', hex: 'f09f9982' });
});

// Characterization for the _read()-starts-the-pump fix (Finding 2): touching
// process.stdin with ONLY an 'on(data)' listener — no resume(), no
// setRawMode(true) — must still start the async fd-0 pump. The shim's base
// Readable.on() calls this._read() on the first 'data' listener (stream.cjs),
// and ReadStream._read() now starts the pump; before the fix ReadStream passed
// a no-op read() to the base constructor and this trigger did nothing. Runs in
// cooked (non-raw) mode, so the input needs a trailing newline for the PTY
// line discipline to release it to the reading process.
test("process.stdin fires 'data' from on() alone, without resume()/setRawMode, matching host node", async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    process.stdin.on('data', (d) => {
      const hex = Buffer.from(d).toString('hex');
      console.log('@@TTY@@' + JSON.stringify({ hex }));
      process.exit(0);
    });
  `);
  const nodeOut = extractMark((await runNodePty(f, { input: 'ab\n', inputDelayMs: 500, ms: 4000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { input: 'ab\n', inputDelayMs: 500, ms: 4000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { hex: '61620a' }); // 'ab\n'
});

// Characterization/regression lock: merely READING tjs.stdout/tjs.stderr/
// tjs.stdin (as the old isatty(fd) implementation did) lazily constructs tjs's
// async libuv stream wrapper for that fd, which as a side effect flips the fd
// to O_NONBLOCK. That breaks writeSyncFd's blocking short-write loop: a
// process.stdout.write() bigger than the pipe's kernel buffer (~64KB) then
// throws EUNKNOWN / short-writes instead of blocking, silently losing bytes.
// This is exactly the -p path's shape: chalk/supports-color calls
// tty.isatty(1) at module load, then a later large stdout.write must still
// land in full. Runs under a real PIPE (runLoader), NOT a PTY — the bug only
// manifests on the non-terminal fast path. Must stay green: this test is RED
// on the pre-fix isatty() (reads tjs.stdout/tjs.stderr/tjs.stdin) and GREEN
// once isatty() decides via the side-effect-free fstat/S_IFCHR check instead.
test('a large process.stdout.write after isatty(1) still lands in full under a pipe (regression: isatty must not flip fd to O_NONBLOCK)', (t) => {
  if (skipUnlessTjs(t)) return;
  const N = 512 * 1024;
  const f = fixture(`
    const tty = require('node:tty');
    tty.isatty(1);
    tty.isatty(2);
    tty.isatty(0);
    const payload = 'A'.repeat(${N});
    process.stdout.write(payload);
    process.stdout.write('@@LEN@@' + payload.length + '\\n');
  `);
  const opts = { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 };
  const nodeR = spawnSync(process.execPath, [f], opts);
  const tjsR = spawnSync(tjsPath(), ['run', LOADER, f], opts);
  assert.strictEqual(nodeR.status, 0, `host node stderr: ${nodeR.stderr}`);
  assert.strictEqual(tjsR.status, 0, `tjs stderr: ${tjsR.stderr}`);
  assert.ok(!/EUNKNOWN/.test(tjsR.stderr), `tjs stderr contained EUNKNOWN: ${tjsR.stderr}`);
  const nodeAcount = (nodeR.stdout.match(/A/g) || []).length;
  const tjsAcount = (tjsR.stdout.match(/A/g) || []).length;
  assert.strictEqual(nodeAcount, N, 'host node baseline: full payload landed');
  assert.strictEqual(tjsAcount, N, 'tjs: full payload must land, not short-write/throw');
  assert.match(nodeR.stdout, new RegExp(`@@LEN@@${N}`));
  assert.match(tjsR.stdout, new RegExp(`@@LEN@@${N}`));
});

test('process.stdin paused mode: on(readable)+read() delivers bytes, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  // Ink drives stdin in PAUSED mode (an 'readable' listener + read() loop, not
  // flowing 'data') — see the bundle's suspendStdin/resumeStdin. The shim's base
  // Readable is flowing-only; tty.ReadStream adds a real paused-mode buffer.
  const f = fixture(`
    process.stdin.setRawMode(true);
    let got = '';
    process.stdin.on('readable', () => {
      let c;
      while ((c = process.stdin.read()) !== null) {
        got += Buffer.isBuffer(c) ? c.toString('latin1') : c;
        if (got.length >= 3) {
          console.log('@@TTY@@' + JSON.stringify({ hex: Buffer.from(got, 'latin1').toString('hex') }));
          process.exit(0);
        }
      }
    });
  `);
  const nodeOut = extractMark((await runNodePty(f, { input: 'xyz', inputDelayMs: 500, ms: 4000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { input: 'xyz', inputDelayMs: 500, ms: 4000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { hex: '78797a' }); // 'xyz'
});
