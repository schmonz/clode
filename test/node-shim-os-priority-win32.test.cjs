'use strict';
// os.getPriority / os.setPriority on WINDOWS (libexec/node-shim/internal/priority.cjs): a real value, never ENOSYS.
//
// WHY. The POSIX implementation asks /proc, ps and renice; Windows has none, so for one commit getPriority threw ENOSYS
// there, where the old shim answered 0 and node answers a real value. The 2.1.283 bundle's one call site is guarded off
// Windows and wrapped in try/catch (`if (platform !== "windows") try { setPriority(0, Math.min(getPriority(0) + 5, 19))
// } catch {}`), so nothing broke; it is still a platform gap where one rule (a real value everywhere) holds.
//
// WHAT IS JUDGED. PowerShell is INJECTED: each row checks the command the shim runs and what it makes of PowerShell's
// answer, against libuv's Windows mapping (src/win/util.c): IDLE 19, BELOW_NORMAL 10, NORMAL 0, ABOVE_NORMAL -7,
// HIGH -14, REALTIME -20, and for a set, the band a number falls in. UNMEASURED on a real Windows box: what PowerShell
// prints for a missing or protected process is from its documented messages, not from a run.
//
// This file spawns nothing, so the forced-win32 pass runs it with process.platform really 'win32' (the last row).
const { test } = require('node:test');
const assert = require('node:assert');
const { makePriority, WIN_CLASSES, winClassFor } = require('../libexec/node-shim/internal/priority.cjs');

const ERRNO = { ESRCH: 3, EINVAL: 22, EPERM: 1, ENOSYS: 78, EACCES: 13 };
function rig({ platform = () => 'win32', answer }) {
  const calls = [];
  const p = makePriority({
    platform,
    pid: () => 4242,
    errno: ERRNO,
    readProcStat: () => { throw new Error('Windows must not read /proc'); },
    run(cmd, args) { calls.push([cmd, ...args]); return answer(cmd, args); },
  });
  return { ...p, calls };
}
const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });
const thrown = (f) => { try { f(); } catch (e) { return e; } assert.fail('did not throw'); };

test('win32 getPriority maps each PowerShell PriorityClass to libuv\'s number', () => {
  const want = { Idle: 19, BelowNormal: 10, Normal: 0, AboveNormal: -7, High: -14, RealTime: -20 };
  for (const [name, v] of Object.entries(want)) {
    const r = rig({ answer: ok(`${name}\r\n`) });
    assert.strictEqual(r.getPriority(0), v, name);
    assert.strictEqual(r.calls[0][0], 'powershell.exe');
    assert.match(r.calls[0].at(-1), /^\(Get-Process -Id 4242 -ErrorAction Stop\)\.PriorityClass$/);
  }
  assert.deepStrictEqual(WIN_CLASSES.map((c) => c.v), [-20, -14, -7, 0, 10, 19]);
});

test('win32 getPriority(pid) asks about that pid; a non-number pid is node\'s TypeError, before any spawn', () => {
  const r = rig({ answer: ok('High') });
  assert.strictEqual(r.getPriority(777), -14);
  assert.match(r.calls[0].at(-1), /-Id 777 /);
  const e = thrown(() => r.getPriority('x'));
  assert.strictEqual(e.code, 'ERR_INVALID_ARG_TYPE');
  assert.strictEqual(r.calls.length, 1);
});

test('win32 setPriority picks the class whose libuv band holds the number, at every band edge', () => {
  const want = [[-20, 'RealTime'], [-15, 'RealTime'], [-14, 'High'], [-8, 'High'], [-7, 'AboveNormal'], [-1, 'AboveNormal'],
    [0, 'Normal'], [9, 'Normal'], [10, 'BelowNormal'], [18, 'BelowNormal'], [19, 'Idle']];
  for (const [n, name] of want) {
    assert.strictEqual(winClassFor(n), name, String(n));
    const r = rig({ answer: ok('') });
    r.setPriority(0, n);
    assert.strictEqual(r.calls[0].at(-1), `(Get-Process -Id 4242 -ErrorAction Stop).PriorityClass = '${name}'`);
  }
  const one = rig({ answer: ok('') });
  one.setPriority(10);                       // the one-argument form is the current process
  assert.match(one.calls[0].at(-1), /-Id 4242 .*'BelowNormal'$/);
  const e = thrown(() => rig({ answer: ok('') }).setPriority(0, 99));
  assert.strictEqual(e.code, 'ERR_OUT_OF_RANGE');
});

test('win32 failures are libuv\'s: no process is EINVAL, a protected one EPERM, no PowerShell ENOSYS naming it', () => {
  const fail = (stderr) => () => ({ status: 1, stdout: '', stderr });
  const gone = thrown(() => rig({ answer: fail('Get-Process : Cannot find a process with the process identifier 5.') }).getPriority(5));
  assert.deepStrictEqual([gone.code, gone.info.code, gone.info.syscall, gone.errno], ['ERR_SYSTEM_ERROR', 'EINVAL', 'uv_os_getpriority', -22]);
  const prot = thrown(() => rig({ answer: fail('Exception setting "PriorityClass": "Access is denied"') }).setPriority(4, 0));
  assert.deepStrictEqual([prot.info.code, prot.info.syscall], ['EPERM', 'uv_os_setpriority']);
  const none = thrown(() => rig({ answer: () => ({ missing: 'powershell.exe could not be run (ENOENT)' }) }).getPriority());
  assert.strictEqual(none.info.code, 'ENOSYS');
  assert.match(none.message, /powershell\.exe could not be run/);
  const odd = thrown(() => rig({ answer: ok('Banana') }).getPriority());
  assert.match(odd.message, /no priority class: "Banana"/);
});

test('CONTROL: off win32 the same module never runs PowerShell (it reads /proc, then ps)', () => {
  const calls = [];
  const p = makePriority({
    platform: () => 'darwin', pid: () => 4242, errno: ERRNO,
    readProcStat: () => undefined,
    run(cmd, args) { calls.push(cmd); return { status: 0, stdout: '  5\n', stderr: '' }; },
  });
  assert.strictEqual(p.getPriority(0), 5);
  assert.deepStrictEqual(calls, ['ps']);
});

test('the branch follows process.platform at call time (the forced-win32 pass runs this with it really win32)', () => {
  const r = rig({ platform: () => process.platform, answer: (cmd) => (cmd === 'powershell.exe' ? ok('BelowNormal')() : ok('3')()) });
  r.calls.length = 0;
  const v = (() => { try { return r.getPriority(0); } catch (e) { return e; } })();
  if (process.platform === 'win32') {
    assert.strictEqual(v, 10);
    assert.strictEqual(r.calls[0][0], 'powershell.exe');
  } else {
    assert.ok(!r.calls.some((c) => c[0] === 'powershell.exe'), JSON.stringify(r.calls));
  }
});
