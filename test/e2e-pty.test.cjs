'use strict';
// Unit tests for the PTY harness's pure helpers (test/e2e-pty.cjs).
//
// The apeCmd rows pin its /bin/sh trampoline SELECTION, platform-independently — the
// same bug, and the same cure, as node-shim-helper.test.cjs's regression pin for CI
// run 30675029624.
//
// apeCmd() used to wrap ANY file whose first two bytes are 'MZ' as
// `/bin/sh -c '"$@"' sh <file> ...`, with no platform check. On Windows every PE
// starts with 'MZ' (node.exe included), so drive() turned [process.execPath, script]
// into a /bin/sh spawn; node-pty/ConPTY found no `/bin/sh` on PATH and reported
// "File not found: " (an empty name — node-pty 1.1.0 path_util returns "" on no
// match). Every test/frame-diff.test.cjs test failed that way on windows-latest
// (CI run 36039332441, 2026-09-24, at 54de06b). The decision is now the one shared
// wantsTrampoline(platform, isApe): the trampoline is a POSIX ENOEXEC workaround and
// Windows loads an MZ file natively.
//
// The platform is injected so the win32 row runs on every host — a Windows-only
// test could not have caught this on the darwin box where it was written.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sandbox } = require('./e2e.cjs');
const { seedClaudeProfile, apeCmd } = require('./e2e-pty.cjs');

test('seedClaudeProfile writes a cwd-keyed trusted profile', (t) => {
  const sbx = sandbox(t);
  seedClaudeProfile(sbx.home, { cwd: '/some/project' });
  const j = JSON.parse(fs.readFileSync(path.join(sbx.home, '.claude.json'), 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.ok(j.projects['/some/project'], 'the cwd is present in projects');
  assert.strictEqual(j.projects['/some/project'].hasTrustDialogAccepted, true);
});

function mzFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pty-ape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'subject.exe');
  // 'MZ' then the bytes a real win32 claude.exe starts with (4d5a 7800 ...), padded.
  fs.writeFileSync(f, Buffer.from([0x4d, 0x5a, 0x78, 0x00, 0, 0, 0, 0]));
  return f;
}

test('apeCmd: an MZ file on win32 is spawned directly, never through /bin/sh (CI run 36039332441)', (t) => {
  const f = mzFile(t);
  const cmd = [f, '--version'];
  assert.deepStrictEqual(apeCmd(cmd, 'win32'), cmd);
});

test('apeCmd: an MZ file on POSIX still gets the ENOEXEC trampoline (a cosmo APE)', (t) => {
  const f = mzFile(t);
  for (const platform of ['linux', 'darwin']) {
    assert.deepStrictEqual(apeCmd([f, 'a', 'b'], platform),
      ['/bin/sh', '-c', '"$@"', 'sh', f, 'a', 'b'], `platform=${platform}`);
  }
});

test('apeCmd: this host\'s own node is spawned unchanged (Mach-O/ELF on POSIX, a PE on win32)', () => {
  const cmd = [process.execPath, 's'];
  assert.deepStrictEqual(apeCmd(cmd), cmd);
});

test('apeCmd: non-arrays and empty commands pass through untouched', () => {
  assert.strictEqual(apeCmd(undefined, 'linux'), undefined);
  assert.deepStrictEqual(apeCmd([], 'linux'), []);
});

// captureSession's two pure halves: the driver arguments a script turns into, and the
// refusal to read anything but a whole frame sequence out of the driver's stdout.
const { driveArgs, parseSession, TUI_SCREEN } = require('./e2e-pty.cjs');

test('driveArgs: a script run passes the script file and every settle limit to the driver', (t) => {
  const sbx = sandbox(t);
  const { args } = driveArgs(sbx, { seconds: 0, scriptFile: '/tmp/steps.json', settleMs: 300, maxSettleMs: 5000,
    bootSettleMs: 2000, bootMaxMs: 9000, rows: 8, cols: 40, cmd: [process.execPath, 'x.cjs'] });
  assert.deepStrictEqual(args, [TUI_SCREEN, '0', '--script', '/tmp/steps.json', '--settle-ms', '300',
    '--max-settle-ms', '5000', '--boot-settle-ms', '2000', '--boot-max-ms', '9000',
    '--rows', '8', '--cols', '40', '--', process.execPath, 'x.cjs']);
  const plain = driveArgs(sbx, { seconds: 12, fixedWindowBecause: 'unit test of the argument shape; nothing is spawned',
    cells: true, cmd: [process.execPath] }).args;
  assert.deepStrictEqual(plain, [TUI_SCREEN, '12', '--cells', '--', process.execPath], 'a reasoned single-frame drive is unchanged');
});

// THE MECHANISM under test/fixed-window-captures.test.cjs: every capture goes through driveArgs,
// so a fixed window with no written reason is refused before anything is spawned. The first
// refusal is frame-diff.test.cjs's old line, which took a BLANK frame under load at 91e96b5.
test('driveArgs: a fixed window without fixedWindowBecause is refused, and so is a timed option in a script', (t) => {
  const sbx = sandbox(t);
  assert.throws(() => driveArgs(sbx, { seconds: 1.2, rows: 12, cols: 60, cmd: [process.execPath, 'x.cjs'] }),
    /a fixed 1\.2s capture window needs opts\.fixedWindowBecause/);
  assert.throws(() => driveArgs(sbx, { seconds: 9, fixedWindowBecause: '  ', cmd: [process.execPath] }),
    /needs opts\.fixedWindowBecause/, 'a blank reason is no reason');
  assert.throws(() => driveArgs(sbx, { seconds: 0, scriptFile: '/tmp/s.json', thenHex: ['0d@6'], cmd: [process.execPath] }),
    /a scripted session takes no fixed window \(thenHex\)/);
  assert.throws(() => driveArgs(sbx, { seconds: 5, scriptFile: '/tmp/s.json', cmd: [process.execPath] }),
    /a scripted session takes no fixed window \(seconds: 5\)/);
  assert.doesNotThrow(() => driveArgs(sbx, { seconds: 0, scriptFile: '/tmp/s.json', thenHex: [], cmd: [process.execPath] }));
});

test('frameText: a cell frame reads as the text screen, a wide glyph once, trailing space trimmed', () => {
  const { frameText } = require('./e2e-pty.cjs');
  const cell = (c, w = 1) => ({ c, w, f: '0:-1', b: '0:-1', a: 0, l: null });
  const wide = String.fromCodePoint(0x4e2d);
  const frame = { format: 'clode-frame-v1', cols: 4, rows: 2, links: true,
    cells: [[cell('a'), cell(''), cell('b'), cell(' ')], [cell(wide, 2), cell('', 0), cell(''), cell('')]] };
  assert.strictEqual(frameText(frame), `a b\n${wide}\n`);
});

test('parseSession: anything but a whole frame sequence throws, carrying the driver\'s stderr', () => {
  const r = (stdout, extra = {}) => ({ stdout, stderr: 'tui-screen: boom', status: 2, signal: null, ...extra });
  assert.throws(() => parseSession(r('')), /produced no frame sequence .*exit 2.*tui-screen: boom/s);
  assert.throws(() => parseSession(r('{"format":"clode-frames-v1","fr')), /produced no frame sequence/);
  assert.throws(() => parseSession(r('{"format":"clode-frame-v1","cells":[]}')), /unexpected frame-sequence format/);
  assert.throws(() => parseSession(r('{"format":"clode-frames-v1"}')), /unexpected frame-sequence format/);
  const ok = { format: 'clode-frames-v1', exit: null, frames: [{ label: 'boot', settled: true, ms: 5, frame: { format: 'clode-frame-v1' } }] };
  assert.deepStrictEqual(parseSession(r(JSON.stringify(ok))), ok);
});

// Exit 4 (tui-screen.cjs stopChild: the driven TUI outlived its stop) fails every shared capture, so each PTY gate
// inherits the check (fix round 1 of CI 44460009323).
test('a driver that reports a leaked TUI (exit 4) fails capture, frame and session parsing alike', () => {
  const { refuseLeak } = require('./e2e-pty.cjs');
  const leaked = { status: 4, signal: null, stdout: '{"format":"clode-frames-v1","frames":[]}',
    stderr: 'tui-screen: the child (pid 7) was still running 15000ms after it was killed' };
  assert.throws(() => refuseLeak(leaked), /outlived the driver \(exit 4\): .*pid 7\) was still running/);
  assert.throws(() => parseSession(leaked), /outlived the driver/);
  assert.strictEqual(refuseLeak({ ...leaked, status: 0 }).status, 0, 'a clean stop passes through');
  assert.deepStrictEqual(parseSession({ ...leaked, status: 0 }).frames, []);
});
