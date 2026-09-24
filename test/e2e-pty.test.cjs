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
