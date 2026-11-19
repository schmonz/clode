'use strict';
// os.getPriority / os.setPriority under quaude, judged against host node, with both run under `nice -n 5`
// (a deliberately non-default niceness, so the answer cannot be the constant 0 by luck of the host: the increment
// is bumped when the host's own nice would cancel it, and the oracle's answer is asserted non-zero).
//
// WHY. node-shim's os answered getPriority() with a constant 0 and made setPriority() a silent no-op. CI run
// 44597568635's node-shim-oracle-darwin found it only because the macOS runner happens to run at nice -10
// (node -10, quaude 0). The 2.1.283 bundle's background daemon does `setPriority(0, Math.min(getPriority(0) + 5,
// 19))` off Windows: under quaude it silently stayed at full priority.
//
// Each row is a call and what it returned or threw ({ v } or { code, syscall, errCode }); both runtimes run the
// same program, and the rows must be equal. setPriority's rows only move the process's nice UP (always allowed),
// then try to move it back down, which an unprivileged process may not do (EACCES), and root may: equal either way.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineSpawn, LOADER, skipUnlessTjs } = require('./node-shim-helper.cjs');
const { unmaskedIncrement } = require('./nice-increment.cjs');

const PROG = `
const os = require('node:os');
const rows = [];
const call = (what, f) => {
  try { rows.push([what, { v: f() }]); }
  catch (e) { rows.push([what, { code: e.code, errCode: e.info ? e.info.code : undefined, syscall: e.info ? e.info.syscall : undefined, name: e.name }]); }
};
call('getPriority(0)', () => os.getPriority(0));
call('getPriority()', () => os.getPriority());
call('getPriority(process.pid)', () => os.getPriority(process.pid));
call('getPriority(a pid that is no process)', () => os.getPriority(2147483646));
call('getPriority("x")', () => os.getPriority('x'));
const start = os.getPriority(0);
call('setPriority(0, start + 2)', () => os.setPriority(0, start + 2));
call('getPriority(0) after +2', () => os.getPriority(0));
call('setPriority(start + 3) (one-argument form)', () => os.setPriority(start + 3));
call('getPriority(0) after +3', () => os.getPriority(0));
call('setPriority(0, start) (lower: EACCES unless root)', () => os.setPriority(0, start));
call('setPriority(0, 99)', () => os.setPriority(0, 99));
call('setPriority(2147483646, 10)', () => os.setPriority(2147483646, 10));
console.log(JSON.stringify(rows));
`;

const NICE = unmaskedIncrement(5, process.platform === 'win32' ? 0 : os.getPriority(0));
test(`os.getPriority/setPriority under quaude answer as host node does, both under nice -n ${NICE}`, { skip: process.platform === 'win32' ? 'nice(1) is POSIX; Windows priority classes are unmeasured' : false }, (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-os-priority-'));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const run = (cmd, argv) => {
      const r = spawnSync('nice', ['-n', String(NICE), cmd, ...argv], { encoding: 'utf8', timeout: 60000 });
      assert.strictEqual(r.status, 0, `${cmd}: ${r.stderr}`);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const node = run(process.execPath, [prog]);
    // the oracle itself must see the nice it was given (on top of whatever the host runs at), and not 0
    assert.strictEqual(node[0][1].v, Math.min(os.getPriority(0) + NICE, 19), JSON.stringify(node[0]));
    assert.notStrictEqual(node[0][1].v, 0, 'the oracle answered 0: a constant-0 stub would pass by luck');
    const [cmd, argv] = engineSpawn(['run', LOADER, prog]);
    const ours = run(cmd, argv);
    assert.deepStrictEqual(ours, node);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the nice increment is never cancelled by the host\'s own nice (a runner at -5 or -7 would mask it to 0)', () => {
  assert.strictEqual(unmaskedIncrement(5, 0), 5);
  assert.strictEqual(unmaskedIncrement(5, -10), 5);
  assert.strictEqual(unmaskedIncrement(5, -5), 6);
  assert.strictEqual(unmaskedIncrement(7, -7), 8);
  assert.strictEqual(unmaskedIncrement(7, 15), 7);   // clamped to 19 by the kernel, still not 0
});
