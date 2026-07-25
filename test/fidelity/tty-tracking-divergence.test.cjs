'use strict';
// Known intentional divergence (RECIPE.md "Intentional divergences", row X1):
// quaude defaults mouse (\e[?1000/1001/1002/1003h) and focus (\e[?1004h)
// tracking OFF — Claude Code enables them, but the per-event redraw flood
// freezes the UI on constrained hardware (proven on Tiger). This is the ONE
// place quaude deliberately differs from upstream in the TTY stream, so the
// fidelity harness must PIN it rather than discover it:
//   1. the strip is SURGICAL — only the named modes are removed; every other
//      DECSET mode in the same or a neighbouring sequence passes untouched, and
//   2. the knob RESTORES parity — with CLODE_TTY_MOUSE=1/CLODE_TTY_FOCUS=1 the
//      byte stream is identical to what host node (the reference) emits.
// Anything beyond (1) would be an unaccounted divergence; a break in (2) would
// mean the escape hatch no longer reproduces upstream behavior. Runs under a
// real PTY so the tty.WriteStream / ReadStream filters actually engage.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessTjs } = require('../node-shim-helper.cjs');
const { runLoaderPty, runNodePty, extractMark } = require('../node-shim-tty-helper.cjs');

function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tty-div-'));
  const f = path.join(dir, 'fx.cjs');
  fs.writeFileSync(f, body);
  return f;
}
// process.env minus the two knobs, so a dev shell that happens to export them
// can't poison the default (suppressing) runs.
const OFF = (() => { const e = { ...process.env }; delete e.CLODE_TTY_MOUSE; delete e.CLODE_TTY_FOCUS; return e; })();
const ON = { ...OFF, CLODE_TTY_MOUSE: '1', CLODE_TTY_FOCUS: '1' };

// --- OUTPUT side: mode-ENABLE stripping on process.stdout -------------------
// Four writes exercise: pure-mouse, pure-focus, a MIXED mouse+bracketed-paste
// sequence (proves per-mode surgery within one \e[?..h), and an unrelated
// alt-screen mode (proves untouched).
const OUT_FIXTURE = `
  process.stdout.write('@@S@@');
  process.stdout.write('\\x1b[?1000;1002;1003h'); // pure mouse -> gone by default
  process.stdout.write('\\x1b[?1004h');           // focus -> gone by default
  process.stdout.write('\\x1b[?1003;2004h');      // mixed -> only \\x1b[?2004h survives
  process.stdout.write('\\x1b[?1049h');           // alt-screen -> always untouched
  process.stdout.write('@@E@@\\n');
`;

test('OUTPUT: default strips ONLY mouse/focus enables, leaves every other mode', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(OUT_FIXTURE);
  const { out } = await runLoaderPty(f, { ms: 4000, env: OFF });
  assert.ok(out.includes('@@S@@') && out.includes('@@E@@'), `writes did not flush:\n${JSON.stringify(out)}`);
  // divergence: the tracking enables are gone...
  assert.ok(!out.includes('\x1b[?1000'), 'mouse enable (1000/1002/1003) must be stripped');
  assert.ok(!out.includes('\x1b[?1004h'), 'focus enable (1004) must be stripped');
  assert.ok(!out.includes('1003'), 'mouse mode 1003 must not survive even inside a mixed sequence');
  // ...but the strip is surgical: paste survives the mixed seq, alt-screen untouched.
  assert.ok(out.includes('\x1b[?2004h'), 'bracketed-paste (2004) must survive the mixed sequence');
  assert.ok(out.includes('\x1b[?1049h'), 'alt-screen (1049) must pass through untouched');
});

test('OUTPUT: knob (CLODE_TTY_MOUSE/FOCUS=1) restores byte-exact parity with host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(OUT_FIXTURE);
  const bundle = (s) => s.slice(s.indexOf('@@S@@') + 5, s.indexOf('@@E@@'));
  const node = bundle((await runNodePty(f, { ms: 4000, env: OFF })).out);   // reference: no filter
  const knob = bundle((await runLoaderPty(f, { ms: 4000, env: ON })).out);  // quaude, opted back in
  // Every DECSET enable the reference emits is present, verbatim, under the knob.
  assert.ok(node.includes('\x1b[?1000;1002;1003h'), 'sanity: host node emits mouse enables unchanged');
  assert.strictEqual(knob, node, 'with the knob set, quaude stdout must equal host node byte-for-byte');
});

// --- INPUT side: flood-event dropping on process.stdin ----------------------
// A single burst carries an SGR mouse-motion event, a focus-in, a real key, a
// focus-out, and a final real key. The fixture ends on 'y' (0x79).
const IN_FIXTURE = `
  process.stdin.setRawMode(true);
  let got = Buffer.alloc(0);
  process.stdin.on('data', (d) => {
    got = Buffer.concat([got, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
    if (got.includes(0x79)) { // 'y' terminator
      console.log('@@TTY@@' + JSON.stringify({ hex: got.toString('hex') }));
      process.exit(0);
    }
  });
  process.stdin.resume();
`;
const BURST = '\x1b[<35;10;10M\x1b[Ix\x1b[Oy'; // mouse-move, focus-in, 'x', focus-out, 'y'

test('INPUT: default drops mouse/focus events, delivers only the real keys', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(IN_FIXTURE);
  const got = extractMark((await runLoaderPty(f, { input: BURST, inputDelayMs: 500, ms: 5000, env: OFF })).out);
  assert.deepStrictEqual(got, { hex: '7879' }, "only 'x','y' should survive; mouse/focus events dropped");
});

test('INPUT: knob (CLODE_TTY_MOUSE/FOCUS=1) delivers the full burst, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(IN_FIXTURE);
  const node = extractMark((await runNodePty(f, { input: BURST, inputDelayMs: 500, ms: 5000, env: OFF })).out);
  const knob = extractMark((await runLoaderPty(f, { input: BURST, inputDelayMs: 500, ms: 5000, env: ON })).out);
  assert.ok(node && node.hex.includes('1b5b3c'), 'sanity: host node delivers the SGR mouse event');
  assert.deepStrictEqual(knob, node, 'with the knob set, quaude stdin bytes must equal host node');
});
