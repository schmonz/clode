'use strict';
// Pins the /bin/sh-trampoline SELECTION LOGIC in node-shim-helper.cjs's
// engineSpawn(), platform-independently. This is a regression test for a real
// CI failure: run 30675029624 had `windows-x64-tests` and `windows-arm64-tests`
// both fail the agentic Bash/Edit round-trip rows in node-shim-agentic.test.cjs
// with `Error: spawn /bin/sh ENOENT`.
//
// Root cause: every Windows PE (cosmo APE or plain PE, doesn't matter) starts
// with the DOS 'MZ' header — the same two bytes isApeFile() uses to detect a
// Cosmopolitan APE that needs the POSIX `/bin/sh` ENOEXEC trampoline. The old
// engineSpawn() gated the trampoline on `isApeFile(tjs)` alone, so on Windows
// it always misfired: tjs.exe looks APE-shaped by the 2-byte test, and the
// harness tried to spawn a shell that doesn't exist there.
//
// This file could not have caught the bug by running only on Windows — a
// Windows-only test wouldn't have run on the darwin dev box where the bug was
// introduced and reviewed. Instead it asserts the pure decision function
// wantsTrampoline(platform, isApe) directly, injecting the platform string, so
// all four platform x isApe combinations are checked on every host (darwin,
// Linux, BSD, and yes, Windows too, all get the same four assertions run
// in-process — no real Windows box or real APE binary required).
const test = require('node:test');
const assert = require('node:assert');

const { wantsTrampoline } = require('./node-shim-helper.cjs');

test('wantsTrampoline: POSIX + APE -> trampoline (the whole reason it exists: execve ENOEXEC on an MZ-headed polyglot)', () => {
  for (const platform of ['darwin', 'linux', 'freebsd', 'openbsd', 'netbsd', 'sunos']) {
    assert.strictEqual(wantsTrampoline(platform, true), true, `platform=${platform}`);
  }
});

test('wantsTrampoline: POSIX + non-APE -> direct exec (native ELF/Mach-O needs no trampoline)', () => {
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.strictEqual(wantsTrampoline(platform, false), false, `platform=${platform}`);
  }
});

test('wantsTrampoline: win32 + APE -> direct exec (regression pin for CI run 30675029624: an MZ-headed cosmo APE is a valid, natively-loadable PE on Windows — routing it through /bin/sh is the exact bug, since Windows has no /bin/sh to spawn)', () => {
  assert.strictEqual(wantsTrampoline('win32', true), false);
});

test('wantsTrampoline: win32 + non-APE -> direct exec (an ordinary tjs.exe is also MZ-headed; must not be treated as APE-needs-trampoline on Windows either)', () => {
  assert.strictEqual(wantsTrampoline('win32', false), false);
});
