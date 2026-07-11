'use strict';
// O_NONBLOCK characterization (quaude /quit wedge): the bundle's drainStdin
// (VSt) opens /dev/tty with O_RDONLY|O_NONBLOCK and readSync()s it until the
// EAGAIN throw says "drained". flagsToString used to DROP O_NONBLOCK when
// collapsing numeric flags onto FSS.open's string modes, so the open was
// blocking and readSync parked tjs's only thread in kernel read() forever —
// event loop dead, no timers (the bundle's exit failsafe never fired), no
// repaint, terminal stuck in raw mode. A FIFO reproduces the semantics
// hermetically (no tty needed): nonblocking read-end open succeeds with no
// writer; with a writer attached and no data, readSync must throw EAGAIN
// promptly rather than block. Differential vs host node pins the shape.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs');
const fifo = process.argv[2];
const C = fs.constants;
const out = [];
// Read end first: O_RDONLY|O_NONBLOCK opens immediately with no writer
// (a blocking open would park here until a writer appears — the wedge).
const rfd = fs.openSync(fifo, C.O_RDONLY | C.O_NONBLOCK);
out.push(typeof rfd === 'number' && rfd >= 0);
const wfd = fs.openSync(fifo, C.O_WRONLY | C.O_NONBLOCK);
const buf = Buffer.alloc(16);
// Writer attached, no data: node throws EAGAIN here; never blocks.
try { out.push('read:' + fs.readSync(rfd, buf, 0, 16, null)); }
catch (e) { out.push('code:' + e.code); }
// Same fd still reads real data once some arrives.
fs.writeSync(wfd, 'ping');
const n = fs.readSync(rfd, buf, 0, 16, null);
out.push(buf.subarray(0, n).toString());
fs.closeSync(rfd); fs.closeSync(wfd);
console.log(JSON.stringify(out));
`;

test('openSync honors O_NONBLOCK: empty-FIFO readSync throws EAGAIN vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-nonblock-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const mkfifo = (p) => assert.strictEqual(spawnSync('mkfifo', [p]).status, 0, `mkfifo ${p} failed`);
  const nodeFifo = path.join(base, 'node.fifo');
  const tjsFifo = path.join(base, 'tjs.fifo');
  mkfifo(nodeFifo);
  mkfifo(tjsFifo);
  const nodeOut = execFileSync(process.execPath, [f, nodeFifo], { encoding: 'utf8', timeout: 8000 }).trim();
  assert.match(nodeOut, /EAGAIN/, `host node oracle: ${nodeOut}`);
  // Timeout-bounded: the pre-fix shim hangs at openSync (blocking FIFO open,
  // no writer ever) — that must surface as a failed run, not a stuck suite.
  const r = runLoader(f, [tjsFifo], { timeout: 8000 });
  assert.strictEqual(r.status, 0, `tjs run failed (status=${r.status} — a null status means it hung and was killed):\n${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
