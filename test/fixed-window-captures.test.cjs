'use strict';
// No PTY capture in test/** reads the screen after a FIXED time window, unless an allowlist entry
// here says why.
//
// THE CLASS. `capture(sbx, { seconds: N, thenHex: ['HEX@DELAY'] })` and its cell-frame siblings
// read "what is on screen N seconds after spawn", with keystrokes at fixed delays: a guess about
// how fast the box is. A loaded box outruns the guess. The full suite at 91e96b5 took a BLANK frame
// in test/frame-diff.test.cjs (node had not painted inside its 1.2 s window) and failed two rows on
// it; alone they passed 3 in 3. The fix (46281f2) and every conversion after it take each frame
// once its output has been heard and has settled: test/e2e-pty.cjs's captureSession / captureBoot,
// a send step held `until` its answer is on screen.
//
// TWO LAYERS. The MECHANISM is test/e2e-pty.cjs's driveArgs, which every capture goes through: it
// refuses a `seconds` window without a written `fixedWindowBecause`, and a timed option inside a
// script (test/e2e-pty.test.cjs proves both). This guard is the TEXT layer over what the mechanism
// cannot see: a fixed window spelled outside the helpers (a shell script running tui-screen.cjs
// with a SECONDS argument, as test/refresh-doctor-golden.sh did), and every `fixedWindowBecause`
// reason, so a reason is a reviewed allowlist entry rather than a string anyone can type.
//
// WHAT COUNTS, per file (line comments stripped from JS, so prose about the old form is free):
//   `seconds:` with a non-zero value, in a file that require()s e2e-pty, frame-oracle or tui-screen
//     (a `seconds:` elsewhere is some other duration: tool-coverage-gates' lane records);
//   `thenHex:` / `sendHex:` and the CLI's `--then-hex` / `--send-hex` / `--seconds`;
//   `fixedWindowBecause:`;
//   tui-screen.cjs (or TUI_SCREEN) followed by a non-zero SECONDS argument.
// EXACT COUNT, BOTH DIRECTIONS: a file with more spellings than its entry allows is a finding (a
// new fixed window), and so is one with fewer, or none (a stale entry: the reason no longer
// describes the file, and the next fixed window there would ride it in unreviewed).
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripLineComments, discoverFilesByExt } = require('./source-scan.cjs');
const { test } = require('node:test');
const assert = require('node:assert');

const REPO = path.resolve(__dirname, '..');

// The files that DEFINE the fixed form, and so spell it by construction. Exact too: an entry
// whose file is gone is a finding.
const DEFINERS = {
  'test/tui-screen.cjs': 'the PTY driver itself: its CLI keeps SECONDS and the timed flags for a human at a terminal, '
    + 'and its --script mode is what replaced them in the suite',
  'test/e2e-pty.cjs': 'the capture helpers: they translate the timed options into the driver\'s flags, and driveArgs '
    + 'is the mechanism that refuses an unreasoned window',
  'test/fixed-window-captures.test.cjs': 'this guard: its patterns and its control spell the fixed form on purpose',
};

// Every other file that spells a fixed window: { count, why }. Nothing that drives a real TUI is
// here. Measured 2026-11-24 after the conversions (each spelling listed in the reason).
const ALLOWED = {
  'test/e2e-pty.test.cjs': { count: 10, why: 'unit tests of driveArgs, nothing spawned: the argument shape of a reasoned '
    + 'fixed window (seconds + fixedWindowBecause, and the TUI_SCREEN argv it yields), and the windows the mechanism must '
    + 'refuse (seconds 1.2 unreasoned, seconds 9 with a blank reason, thenHex in a script, seconds 5 in a script and '
    + 'the error naming it) beside the empty thenHex it lets through' },
  'test/tui-screen-script.test.cjs': { count: 5, why: 'unit tests of tui-screen.cjs parseArgs for the CLI\'s '
    + 'human-facing timed flags (--then-hex needs @DELAY, in the test name and two calls; --send-hex parses): nothing spawned' },
};

const NAMES_HARNESS = /require\(\s*['"`][^'"`]*(?:e2e-pty|frame-oracle|tui-screen)/;
const PATTERNS = [
  /\bseconds\s*:\s*(?!0(?![.\d]))[\w.]/g,
  /\b(?:thenHex|sendHex)\s*:/g,
  /--(?:then-hex|send-hex|seconds)\b/g,
  /\bfixedWindowBecause\s*:/g,
  /(?:tui-screen\.cjs['"`]?|TUI_SCREEN)\s*,?\s*['"`]?(?!0(?![.\d]))\d/g,
];

// PURE: how many fixed-window spellings a source holds.
function countFixedWindows(rel, src) {
  const text = /\.(?:c|m)?js$/.test(rel) ? stripLineComments(src) : src;
  let n = 0;
  PATTERNS.forEach((re, i) => {
    if (i === 0 && !NAMES_HARNESS.test(text)) return;
    n += (text.match(re) || []).length;
  });
  return n;
}

// PURE. files: { rel: source }. Findings for any file over, under or missing its entry.
function scanFixedWindows({ files, allowed = ALLOWED, definers = DEFINERS }) {
  const findings = [];
  let examined = 0;
  for (const [rel, src] of Object.entries(files)) {
    examined++;
    if (definers[rel]) continue;
    const n = countFixedWindows(rel, src);
    const want = allowed[rel] ? allowed[rel].count : 0;
    if (n > want) {
      findings.push(`${rel}: ${n} fixed-window spelling(s), ${want} allowed: a capture read at a clock time is outrun on `
        + 'a loaded box (frame-diff took a BLANK frame at 91e96b5); take the frame once its output settled '
        + '(e2e-pty captureSession / captureBoot, a send step held `until` its answer), or add a reasoned entry');
    } else if (n < want) {
      findings.push(`${rel}: ${n} fixed-window spelling(s), but its allowlist entry says ${want}: the entry is stale; `
        + 'lower it, so the next fixed window there does not ride in under an old reason');
    }
  }
  for (const rel of [...Object.keys(allowed), ...Object.keys(definers)]) {
    if (!(rel in files)) findings.push(`${rel}: listed here, but no such file in test/**: remove the stale entry`);
  }
  return { findings, examined, note: `${examined} file(s) under test/**, ${Object.keys(allowed).length} allowlisted` };
}

function readTestTree() {
  const files = {};
  for (const f of discoverFilesByExt(path.join(REPO, 'test'), ['.cjs', '.mjs', '.js', '.sh', '.md'])) {
    files[path.relative(REPO, f).split('\\').join('/')] = fs.readFileSync(f, 'utf8');
  }
  return files;
}

// test/frame-diff.test.cjs as it was at 91e96b5, the line that took the blank frame.
const FRAME_DIFF_OLD_LINE = "const { captureFrame } = require('./e2e-pty.cjs');\n"
  + '    FRAMES[name] = captureFrame(SBX, { seconds: 1.2, rows: ROWS, cols: COLS, cmd: [process.execPath, script], env: DRIVER_ENV });\n';

guardTests(defineGuard({
  name: 'no-fixed-window-pty-captures',
  // the suite's own PTY files alone are more than this; a walk that found fewer saw nothing
  floor: 100,
  read: () => ({ files: readTestTree() }),
  scan: scanFixedWindows,
  control: () => ({ files: { ...readTestTree(), 'test/frame-diff.test.cjs': FRAME_DIFF_OLD_LINE } }),
}));

test('the control is frame-diff\'s old line, counted once, and the converted file counts none', () => {
  assert.strictEqual(countFixedWindows('test/frame-diff.test.cjs', FRAME_DIFF_OLD_LINE), 1);
  const now = fs.readFileSync(path.join(REPO, 'test', 'frame-diff.test.cjs'), 'utf8');
  assert.strictEqual(countFixedWindows('test/frame-diff.test.cjs', now), 0);
});

test('exact count both ways: one spelling too many, one too few, and an entry for a missing file are each a finding', () => {
  const allowed = { 'test/a.test.cjs': { count: 1, why: 'x' } };
  const one = "require('./e2e-pty.cjs'); capture(sbx, { seconds: 5, fixedWindowBecause: 'r' });";
  // `seconds: 5` and `fixedWindowBecause:` are two spellings; the entry allows one.
  assert.match(scanFixedWindows({ files: { 'test/a.test.cjs': one }, allowed, definers: {} }).findings.join('\n'),
    /test\/a\.test\.cjs: 2 fixed-window spelling\(s\), 1 allowed/);
  assert.match(scanFixedWindows({ files: { 'test/a.test.cjs': '' }, allowed, definers: {} }).findings.join('\n'),
    /test\/a\.test\.cjs: 0 fixed-window spelling\(s\), but its allowlist entry says 1: the entry is stale/);
  assert.match(scanFixedWindows({ files: {}, allowed, definers: {} }).findings.join('\n'),
    /test\/a\.test\.cjs: listed here, but no such file/);
  assert.deepStrictEqual(scanFixedWindows({ files: { 'test/a.test.cjs': "require('./e2e-pty.cjs'); x({ seconds: 5 });" },
    allowed, definers: {} }).findings, []);
});

test('what counts: the timed spellings count; a zero window, a session, prose and unrelated `seconds` do not', () => {
  const c = (src, rel = 'test/x.test.cjs') => countFixedWindows(rel, src);
  assert.strictEqual(c("require('./e2e-pty.cjs'); captureSession(sbx, { seconds: 0, script });"), 0);
  assert.strictEqual(c("require('./e2e-pty.cjs'); captureBoot(sbx, { cmd: [q] });"), 0);
  assert.strictEqual(c("require('./e2e-pty.cjs');\n// it used to read { seconds: 12, thenHex: ['0d@6'] }\n"), 0, 'a JS line comment is prose');
  assert.strictEqual(c("const LANES = [{ lane: 1, seconds: 9 }];"), 0, 'seconds: in a file that requires no PTY harness');
  assert.strictEqual(c("const why = 'a pty turn (test/e2e-pty.cjs)'; [{ seconds: 9 }];"), 0, 'naming the harness in a string is not using it');
  assert.strictEqual(c("require('./e2e-pty.cjs'); capture(sbx, { seconds: SECONDS, thenHex: H });"), 2);
  assert.strictEqual(c('node test/tui-screen.cjs 16 --then-hex 0d@6 -- x', 'test/r.sh'), 2);
  assert.strictEqual(c('node test/tui-screen.cjs 0 --script s.json -- x', 'test/r.sh'), 0);
  assert.strictEqual(c("driveArgs(sbx, o); [TUI_SCREEN, '12', '--cells']"), 1);
  assert.strictEqual(c('`seconds` after spawn, keys at `@<delay>`; a written `fixedWindowBecause`', 'test/D.md'), 0);
});
