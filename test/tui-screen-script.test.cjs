'use strict';
// tui-screen.cjs --script: a frame per scripted step, captured when output settles.
//
// The multi-frame harness is the instrument every CellSegmenter phase-5 session gate
// judges quaude with, so this file tests the INSTRUMENT, two ways:
//
//   1. PURE. parseArgs() of the script flags, parseScript()'s refusals, and
//      settleVerdict() -- the one decision "is this step's frame ready?". The last
//      pins the defect the first draft of the settle loop had: it measured quiet from
//      the last output BEFORE the step, so right after a keystroke the previous frame's
//      quiet already counted and the "settled" frame was taken before the TUI echoed
//      the key (see the RED row below).
//
//   2. A FAKE TUI under a real pty (skipped when the PTY harness is absent): a node
//      child that paints on a delay, echoes each keystroke late, reports its size on a
//      resize, and never exits -- driven through e2e-pty.cjs's captureSession(), the
//      same call the gates make. No Claude Code build, no network, no credentials.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, parseScript, settleVerdict, SCRIPT_DEFAULTS, loadHarness } = require('./tui-screen.cjs');
const { captureSession } = require('./e2e-pty.cjs');
const { sandbox } = require('./e2e.cjs');
const { rowText } = require('./frame-diff.cjs');

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

// ---- 1. pure ---------------------------------------------------------------

test('parseArgs: the script flags parse, and --script implies --cells', () => {
  const o = parseArgs(['0', '--script', '/tmp/s.json', '--settle-ms', '300', '--max-settle-ms', '5000',
    '--boot-settle-ms', '2000', '--boot-max-ms', '9000', '--rows', '8', '--cols', '40', '--', 'prog', 'a']);
  assert.strictEqual(o.script, '/tmp/s.json');
  assert.strictEqual(o.settleMs, 300);
  assert.strictEqual(o.maxSettleMs, 5000);
  assert.strictEqual(o.bootSettleMs, 2000);
  assert.strictEqual(o.bootMaxMs, 9000);
  assert.strictEqual(o.cells, true, 'a script emits cell frames; there is no text form of a frame sequence');
  assert.deepStrictEqual([o.rows, o.cols], [8, 40]);
  assert.deepStrictEqual(o.cmd, ['prog', 'a']);
});

test('parseArgs: an unflagged script run takes the measured defaults', () => {
  const o = parseArgs(['0', '--script', '/tmp/s.json', '--', 'prog']);
  assert.deepStrictEqual(
    { settleMs: o.settleMs, maxSettleMs: o.maxSettleMs, bootSettleMs: o.bootSettleMs, bootMaxMs: o.bootMaxMs },
    SCRIPT_DEFAULTS);
  for (const [k, v] of Object.entries(SCRIPT_DEFAULTS)) assert.ok(Number.isInteger(v) && v > 0, `${k} = ${v}`);
  assert.ok(SCRIPT_DEFAULTS.maxSettleMs > SCRIPT_DEFAULTS.settleMs && SCRIPT_DEFAULTS.bootMaxMs > SCRIPT_DEFAULTS.bootSettleMs,
    'a cap below its own quiet window could never report a frame settled');
});

test('parseArgs: a limit that is not a positive integer is refused (NaN would never settle nor time out)', () => {
  for (const [flag, v] of [['--settle-ms', 'soon'], ['--max-settle-ms', '0'], ['--boot-settle-ms', '-5'], ['--boot-max-ms', '1.5']]) {
    assert.throws(() => parseArgs(['0', '--script', '/tmp/s.json', flag, v, '--', 'prog']),
      new RegExp(`${flag} must be a positive integer of milliseconds, not "${v.replace('.', '\\.')}"`));
  }
});

test('parseArgs: without --script nothing changes (single frame, text unless --cells)', () => {
  const o = parseArgs(['12', '--send-hex', '0d', '--resize', '60x30@4', '--', 'prog']);
  assert.strictEqual(o.script, null);
  assert.strictEqual(o.cells, false);
  assert.strictEqual(o.secs, 12);
  assert.deepStrictEqual(o.resizes, [[4, 60, 30]]);
  assert.strictEqual(o.sends.length, 1);
});

test('parseScript: send, resize and wait steps normalise; bad scripts are refused by name', () => {
  const steps = parseScript([
    { label: 'type', send: hex('hi') },
    { label: 'shrink', resize: '60x30' },
    { label: 'pause', wait: 250 },
  ]);
  assert.deepStrictEqual(steps, [
    { label: 'type', send: hex('hi') },
    { label: 'shrink', resize: { cols: 60, rows: 30 } },
    { label: 'pause', wait: 250 },
  ]);
  const refuse = (s, re) => assert.throws(() => parseScript(s), re);
  refuse({}, /must be a JSON array/);
  refuse([], /no steps/);
  refuse([{ send: '0d' }], /step 0 needs a non-empty string label/);
  refuse([{ label: 'boot', send: '0d' }], /"boot" is the boot frame's label/);
  refuse([{ label: 'a', send: '0d' }, { label: 'a', send: '0d' }], /label "a" is used twice/);
  refuse([{ label: 'a', send: '0d', wait: 5 }], /exactly one of send, resize, wait/);
  refuse([{ label: 'a' }], /exactly one of send, resize, wait/);
  refuse([{ label: 'a', send: '0d', note: 'x' }], /unknown key "note"/);
  refuse([{ label: 'a', send: 'xyz' }], /send must be an even-length hex string/);
  refuse([{ label: 'a', send: '' }], /send must be an even-length hex string/);
  refuse([{ label: 'a', resize: '60by30' }], /resize must be "COLSxROWS"/);
  refuse([{ label: 'a', resize: '0x30' }], /resize must be "COLSxROWS"/);
  refuse([{ label: 'a', wait: -1 }], /wait must be a positive integer/);
});

// The step began at t=1000 (the keystroke). Everything is relative to that.
const at = (o) => settleVerdict({ since: 1000, quietMs: 800, maxMs: 15000, needOutput: true, ...o });

test('settleVerdict: quiet from BEFORE the step does not settle it (the echo has not arrived)', () => {
  // RED against the first draft, which returned settled whenever now - lastOut >= quiet:
  // here the last output was 5 s before the keystroke, so it "settled" 50 ms after sending,
  // before the TUI had painted the key. The frame said "after the step"; it was not.
  assert.strictEqual(at({ now: 1050, lastOut: -4000 }), 'wait');
  assert.strictEqual(at({ now: 1700, lastOut: -4000 }), 'wait', 'still nothing heard since the step');
});

test('settleVerdict: output after the step, then quiet for the window, settles', () => {
  assert.strictEqual(at({ now: 1500, lastOut: 1400 }), 'wait', 'heard, but only 100 ms quiet');
  assert.strictEqual(at({ now: 2200, lastOut: 1400 }), 'settled');
  assert.strictEqual(at({ now: 1800, lastOut: 1000 }), 'settled', 'output in the step\'s own millisecond counts');
});

test('settleVerdict: the cap turns a step that never goes quiet (or never answers) into a timeout', () => {
  assert.strictEqual(at({ now: 16000, lastOut: 15990 }), 'timeout', 'still painting at the cap');
  assert.strictEqual(at({ now: 16000, lastOut: -4000 }), 'timeout', 'never answered at all');
});

test('settleVerdict: a wait step expects no output, so earlier quiet counts', () => {
  assert.strictEqual(at({ needOutput: false, now: 1050, lastOut: -4000 }), 'settled');
  assert.strictEqual(at({ needOutput: false, now: 1050, lastOut: 900 }), 'wait', 'something painted 150 ms ago');
});

// ---- 2. a fake TUI under a real pty ------------------------------------------

function harnessSkip() {
  try { loadHarness(); return null; } catch (e) { return `PTY harness (node-pty/@xterm/headless) is not loadable: ${e.message}`; }
}

// The driver loads node-pty from the per-platform harness dir under $TMPDIR, and the
// e2e sandbox passes nothing from process.env through, so the driver's own scratch
// locators are threaded back in by name (frame-diff.test.cjs does the same).
const DRIVER_ENV = {};
for (const k of ['TMPDIR', 'CLODE_BUILD_SCRATCH']) if (process.env[k]) DRIVER_ENV[k] = process.env[k];

// Paints READY as it starts; echoes every input chunk 300 ms LATE (six of the settle
// loop's 50 ms polls, so a frame taken before the echo is a real risk the test can see);
// reports its size on every resize; stays alive until killed. The windows below are wider
// than the fake needs on POSIX because windows-latest runs this under ConPTY, which paints
// on its own at spawn: the boot window must outlast node's own startup after that.
const FAKE_TUI = `
const ESC = String.fromCharCode(27);
const out = (s) => process.stdout.write(s);
out(ESC + '[2J' + ESC + '[H' + 'READY');
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on('data', (d) => setTimeout(() => out(ESC + '[2;1H' + ESC + '[K' + 'got ' + d.toString('utf8')), 300));
process.stdout.on('resize', () => out(ESC + '[3;1H' + ESC + '[K' + 'size ' + process.stdout.columns + 'x' + process.stdout.rows));
setInterval(() => {}, 1000);
`;
// Never quiet: a counter every 100 ms, forever.
const CHATTY_TUI = `
let n = 0;
setInterval(() => process.stdout.write(String.fromCharCode(27) + '[H' + 'tick ' + (n++)), 100);
`;
// Exits on its first keystroke.
const QUITTER_TUI = `
process.stdout.write('READY');
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on('data', () => process.exit(7));
setInterval(() => {}, 1000);
`;

let SKIP = null, SBX = null, DIR = null;
before(() => {
  SKIP = harnessSkip();
  if (SKIP) return;
  SBX = sandbox();
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-screen-script-'));
});
after(() => { for (const d of [DIR, SBX && SBX.dir]) if (d) fs.rmSync(d, { recursive: true, force: true }); });

function child(name, src) {
  const f = path.join(DIR, `${name}.cjs`);
  fs.writeFileSync(f, src);
  return [process.execPath, f];
}
const shows = (frame, text) => { for (let y = 0; y < frame.rows; y++) if (rowText(frame, y).includes(text)) return true; return false; };

test('a scripted session: one frame per step, each taken only after that step\'s output settled', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const s = await captureSession(SBX, {
    cmd: child('fake', FAKE_TUI), env: DRIVER_ENV, rows: 8, cols: 40,
    settleMs: 1000, maxSettleMs: 10000, bootSettleMs: 1500, bootMaxMs: 10000,
    script: [
      { label: 'type', send: hex('hi') },
      { label: 'shrink', resize: '30x6' },
      { label: 'pause', wait: 200 },
    ],
  });
  assert.deepStrictEqual(s.frames.map((f) => f.label), ['boot', 'type', 'shrink', 'pause']);
  for (const f of s.frames) {
    assert.strictEqual(f.settled, true, `${f.label} did not settle (${f.ms} ms)`);
    assert.strictEqual(f.frame.format, 'clode-frame-v1');
    assert.ok(Number.isInteger(f.ms) && f.ms >= 0, `${f.label}.ms = ${f.ms}`);
  }
  const [boot, type, shrink, pause] = s.frames.map((f) => f.frame);
  assert.ok(shows(boot, 'READY'), 'the boot frame waited for the first paint');
  assert.ok(!shows(boot, 'got'), 'nothing was typed before the boot frame');
  assert.ok(shows(type, 'got hi'), 'the step frame waited for the 300 ms-late echo');
  assert.ok(s.frames[1].ms >= 300 + 1000, `the type frame came ${s.frames[1].ms} ms after the keystroke: before the echo plus a quiet window`);
  assert.deepStrictEqual([shrink.cols, shrink.rows], [30, 6], 'the emulator was resized with the pty');
  assert.ok(shows(shrink, 'size 30x6'), 'the child saw the resize and painted after it');
  assert.deepStrictEqual(pause.cells, shrink.cells, 'a wait with nothing happening repaints nothing');
  assert.strictEqual(s.exit, null, 'the child was alive until the harness killed it');
});

test('a step that never goes quiet is reported unsettled at its cap, never as settled', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const s = await captureSession(SBX, {
    cmd: child('chatty', CHATTY_TUI), env: DRIVER_ENV, rows: 4, cols: 20,
    settleMs: 400, maxSettleMs: 1200, bootSettleMs: 400, bootMaxMs: 1200,
    script: [{ label: 'poke', send: hex('a') }],
  });
  assert.deepStrictEqual(s.frames.map((f) => [f.label, f.settled]), [['boot', false], ['poke', false]]);
  for (const f of s.frames) assert.ok(f.ms >= 1200, `${f.label} gave up after ${f.ms} ms, before its cap`);
});

test('a child that exits mid-script ends the session and says during which step', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const s = await captureSession(SBX, {
    cmd: child('quitter', QUITTER_TUI), env: DRIVER_ENV, rows: 4, cols: 20,
    settleMs: 300, maxSettleMs: 3000, bootSettleMs: 300, bootMaxMs: 3000,
    script: [{ label: 'poke', send: hex('a') }, { label: 'never', send: hex('b') }],
  });
  assert.deepStrictEqual(s.frames.map((f) => f.label), ['boot', 'poke'], 'no frame is invented for a step a dead child never saw');
  assert.strictEqual(s.frames[1].settled, false, 'a frame the child died during is not a settled frame');
  assert.deepStrictEqual({ during: s.exit.during, code: s.exit.code }, { during: 'poke', code: 7 });
});
