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
  const plain = driveArgs(sbx, { seconds: 12, cells: true, cmd: [process.execPath] }).args;
  assert.deepStrictEqual(plain, [TUI_SCREEN, '12', '--cells', '--', process.execPath], 'a single-frame drive is unchanged');
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
