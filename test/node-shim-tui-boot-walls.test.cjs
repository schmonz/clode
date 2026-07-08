'use strict';
// Characterization for the node-shim gaps found while booting the real Ink TUI
// under tjs (phase 3, M1). Each was a hard wall: the bundle called an API that
// was missing/threw, aborting startup before first paint. All compared to host
// node where the value is platform-shared.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tuiwall-'));
  const f = path.join(dir, 'fx.cjs');
  fs.writeFileSync(f, body);
  return f;
}

// --- Wall 1: the legacy `constants` module (was an unimplemented wallProxy that
// threw on `constants.hasOwnProperty(...)`, the first thing the bundle does). ---
test("require('constants') is a real flat object matching host node", (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const c = require('constants');
    console.log(JSON.stringify({
      SIGWINCH: c.SIGWINCH, O_RDONLY: c.O_RDONLY, S_IFMT: c.S_IFMT, E2BIG: c.E2BIG,
      hasOwn: c.hasOwnProperty('O_RDONLY'), missing: c.hasOwnProperty('NOPE'),
    }));
  `);
  const nodeOut = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  const v = JSON.parse(r.stdout);
  assert.strictEqual(v.hasOwn, true);
  assert.strictEqual(v.missing, false);
  assert.strictEqual(typeof v.SIGWINCH, 'number');
});

// --- Wall 2: fs.utimes was undefined ("not a function"). The bundle's temp-dir
// mtime-precision probe calls fs.utimes(path, atime, mtime, cb). ---
test('fs.utimes sets a file mtime (Date + numeric-seconds), matching a stat read', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const fs = require('fs');
    const os = require('os'); const path = require('path');
    const p = path.join(os.tmpdir(), 'utw-' + process.pid + '.tmp');
    fs.writeFileSync(p, 'x');
    const when = new Date(Math.floor(Date.now() / 1000) * 1000); // whole second
    fs.utimes(p, when, when, (err) => {
      if (err) { console.log('ERR ' + err.message); return; }
      const st = fs.statSync(p);
      console.log(JSON.stringify({
        threw: false,
        mtimeIsDate: st.mtime instanceof Date,
        // second-resolution match (this build reads whole-second mtime)
        sameSecond: Math.floor(st.mtime.getTime() / 1000) === Math.floor(when.getTime() / 1000),
      }));
      fs.unlinkSync(p);
    });
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout.trim());
  assert.strictEqual(v.threw, false);
  assert.strictEqual(v.mtimeIsDate, true);
  assert.strictEqual(v.sameSecond, true);
});

// --- Wall 3: fs.Stats exposed only size/mode/mtimeMs — no .mtime Date, so the
// probe's `stat().mtime.getTime()` threw "cannot read property getTime of
// undefined". Stats now carries the Date accessors + the common numeric fields. ---
test('fs.Stats exposes Date accessors and the standard numeric fields', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const fs = require('fs');
    const st = fs.statSync(require('os').tmpdir());
    console.log(JSON.stringify({
      mtime: st.mtime instanceof Date, atime: st.atime instanceof Date,
      ctime: st.ctime instanceof Date, birthtime: st.birthtime instanceof Date,
      mtimeMsNum: typeof st.mtimeMs === 'number',
      nlink: st.nlink, blksize: st.blksize,
      dir: st.isDirectory(), file: st.isFile(),
      hasNumericFields: ['dev','ino','uid','gid','rdev','blocks'].every(k => typeof st[k] === 'number'),
    }));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout.trim());
  assert.strictEqual(v.mtime, true);
  assert.strictEqual(v.atime, true);
  assert.strictEqual(v.ctime, true);
  assert.strictEqual(v.birthtime, true);
  assert.strictEqual(v.mtimeMsNum, true);
  assert.strictEqual(v.dir, true);
  assert.strictEqual(v.file, false);
  assert.strictEqual(v.hasNumericFields, true);
});

// --- Wall 4: tty.WriteStream lacked cursorTo/clearLine/moveCursor/clearScreenDown
// (the readline methods node puts on tty.WriteStream). Ink calls them during
// rendering; absent, they'd be "not a function". Assert they emit the right ANSI
// (write to fd 1, captured through the runLoader pipe). ---
test('tty.WriteStream cursor/erase methods emit the expected ANSI escapes', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const { WriteStream } = require('node:tty');
    const w = new WriteStream(1);           // fd 1 is a pipe here → escapes land on stdout
    let cbs = 0;
    w.cursorTo(4, () => cbs++);             // column only → ESC[5G
    w.cursorTo(2, 3);                        // x,y → ESC[4;3H
    w.moveCursor(-1, 2);                     // ESC[1D ESC[2B
    w.clearLine(0, () => cbs++);            // whole line → ESC[2K
    w.clearLine(-1);                         // left → ESC[1K
    w.clearLine(1);                          // right → ESC[0K
    w.clearScreenDown();                     // ESC[0J
    process.stdout.write('|CBS=' + cbs);
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.includes('\x1b[5G'), 'cursorTo(4) → ESC[5G');
  assert.ok(out.includes('\x1b[4;3H'), 'cursorTo(2,3) → ESC[4;3H');
  assert.ok(out.includes('\x1b[1D') && out.includes('\x1b[2B'), 'moveCursor(-1,2)');
  assert.ok(out.includes('\x1b[2K'), 'clearLine(0) → ESC[2K');
  assert.ok(out.includes('\x1b[1K'), 'clearLine(-1) → ESC[1K');
  assert.ok(out.includes('\x1b[0K'), 'clearLine(1) → ESC[0K');
  assert.ok(out.includes('\x1b[0J'), 'clearScreenDown → ESC[0J');
  assert.ok(out.includes('|CBS=2'), 'both callbacks fired');
});
