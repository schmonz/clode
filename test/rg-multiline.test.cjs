'use strict';
// quaude's rg under -U (grep-native Task 10): rg's multi-line searcher, and its refusal of a \n without -U.
// Native is the truth: test/fixtures/rg-multiline-native.json holds what 2.1.283's EMBEDDED rg (ripgrep
// 14.1.1 rev 7c1d0ed28a) printed for 379 argv over test/rg-multiline-cases.cjs's tree, on darwin-arm64;
// linux-x64 native printed the same for the first 374 (walk order aside) in a node:24.21.0-bookworm container, and
// quaude's rg (the matcher alone) equalled it there, row for row (2026-10-04; generator and evidence: the task-10
// report; the last 5, the standard printer's --max-columns, were measured on darwin only).
// Each row names its rule, stated once in libexec/rg-native.cjs ("rg's multi-line search"):
//   RG-MULTILINE            -U with a pattern that can match \n or holds ^/$: rg's multi-line searcher, blocks of
//                           whole lines, --multiline-dotall; also ruling G5 under -U: `^`, `$` and `.` over
//                           invalid UTF-8 (bad.txt) answer as native
//   RG-MULTILINE-LINE-MODE  any other pattern under -U is searched line by line (and --multiline-dotall alone
//                           changes nothing)
//   RG-MULTILINE-SLICE      each find starts a haystack where the last match ended, so ^ and \b see nothing before
//   RG-MULTILINE-PRINTED    what -c, -c -o, -l, -o and --json's submatches find again in a block
//   RG-MULTILINE-CONTEXT    -A/-B/-C around blocks, `--` between groups
//   RG-MULTILINE-BINARY     a NUL in the first 64 KiB, or in a block or context line about to print
//   RG-NEWLINE-NEEDS-U      a \n without -U: rg's own error, rc 2
// Every row runs four ways: over ugrep (ugrep proposing files with the multi-line prefilter), with the matcher
// alone (no ugrep), as the async twin (rgExecFile), and under tjs (both twins). Walked rows (-j1 over `.`)
// compare their files in any order: -j1's order is the filesystem's readdir order (RG-WALK-ORDER's own tests);
// named and stdin rows compare exactly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const rgn = require('../libexec/rg-native.cjs');
const { normalizeRg } = require('../scripts/lib/rg-probe.cjs');
const { tjsPath, runLoader } = require('./node-shim-helper.cjs');
const { judgeHold } = require('./loop-hold.cjs');
const { missingExtDeps } = require('./shim-surface/collect.cjs');
const { makeMlTree, ML_INPUT } = require('./rg-multiline-cases.cjs');
const { rows: ROWS } = require('./fixtures/rg-multiline-native.json');

const NO_TJS = !tjsPath() ? 'no tjs engine' : (() => {
  const missing = missingExtDeps();
  return missing.length ? `the shim's ext-dep closure is not installed (${missing.join(', ')}; npm ci --prefix deps/claude)` : false;
})();
function hostUgrep() {
  if (process.env.CLODE_UGREP) return process.env.CLODE_UGREP;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const x of exts) { const p = path.join(d, 'ugrep' + x); if (d && fs.existsSync(p)) return p; }
  }
  return null;
}
const UGREP = hostUgrep();
const CAPS = UGREP ? rgn.ugrepCapabilities(UGREP) : null;
const needUgrep = { skip: !UGREP ? 'no ugrep on this host' : !CAPS.format ? CAPS.reason : false };
// The tree's files are POSIX names and bytes; rg's Windows path spelling is unmeasured (BACKLOG).
const POSIX = process.platform === 'win32' ? 'rg\'s Windows path spelling is unmeasured (BACKLOG)' : false;

async function withMl(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ml-')));
  try { makeMlTree(fs, path, root); return await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const l1 = (b) => Buffer.from(b).toString('latin1');
const walked = (argv) => argv.includes('.');
const sortLines = (s) => s.split('\n').sort().join('\n');
function check(row, got) {
  const [rule, argv, , status, out, err] = row;
  const what = `${rule}: rg ${argv.join(' ')} => ${JSON.stringify(got).slice(0, 800)}`;
  assert.strictEqual(got.status, status, what);
  const anyOrder = walked(argv) ? argv.filter((a) => a !== '-j1') : argv;
  const printer = anyOrder.includes('--json') || anyOrder.includes('-l') || anyOrder.includes('-c');
  if (printer) assert.strictEqual(normalizeRg(Buffer.from(got.stdout, 'latin1'), anyOrder), normalizeRg(Buffer.from(out, 'latin1'), anyOrder), what);
  else if (walked(argv)) assert.strictEqual(sortLines(got.stdout), sortLines(out), what);
  else assert.strictEqual(got.stdout, out, what);
  if (status === 2) assert.strictEqual(got.stderr, err, what);
  assert.strictEqual(rgn.parseRgRefusal(got.stderr), null, `${what}: native answers this, so ours must not refuse it`);
}
function syncRun(root, [, argv, input], { alone = false } = {}) {
  const r = rgn.runRg(argv, { cwd: root, input: input ? ML_INPUT(input) : Buffer.alloc(0), spawnSync: cp.spawnSync,
    ugrep: () => (alone ? null : UGREP), matchFiles: alone ? rgn.matchFilesAlone : undefined });
  return { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) };
}
function asyncRun(root, [, argv, input]) {
  return new Promise((resolve) => {
    const child = rgn.rgExecFile(argv, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, so, se) => resolve({
      status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }),
    'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP });
    if (input) child.stdin.end(ML_INPUT(input)); else if (child.stdin) child.stdin.end();
  });
}

const RULES = [...new Set(ROWS.map((r) => r[0]))];
test('the native rows cover every rule, and enough of each', () => {
  assert.deepStrictEqual(RULES.slice().sort(), ['RG-MULTILINE', 'RG-MULTILINE-BINARY', 'RG-MULTILINE-CONTEXT', 'RG-MULTILINE-LINE-MODE',
    'RG-MULTILINE-PRINTED', 'RG-MULTILINE-SLICE', 'RG-NEWLINE-NEEDS-U']);
  for (const rule of RULES) assert.ok(ROWS.filter((r) => r[0] === rule).length >= 16, rule);
  assert.ok(ROWS.length >= 379, `${ROWS.length} rows`);
});
for (const rule of RULES) {
  test(`${rule}: runRg answers as native (native, over ugrep)`, { skip: POSIX || needUgrep.skip }, () => withMl((root) => {
    for (const row of ROWS.filter((r) => r[0] === rule)) check(row, syncRun(root, row));
  }));
}
test('RG-MULTILINE-*: with the matcher alone deciding every file (no ugrep), every row (native)', { skip: POSIX }, () => withMl((root) => {
  for (const row of ROWS) check(row, syncRun(root, row, { alone: true }));
}));
test('RG-MULTILINE-*: the async twin answers every row as the sync one does (rgExecFile, native)', { skip: POSIX || needUgrep.skip }, () => withMl(async (root) => {
  for (const row of ROWS) check(row, await asyncRun(root, row));
}));
test('RG-MULTILINE-*: under tjs, both twins, every row (native)', { skip: POSIX || needUgrep.skip || NO_TJS }, () => withMl((root) => {
  const prog = path.join(root, '..', path.basename(root) + '-probe.cjs');
  fs.writeFileSync(prog, `
    const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
    const cp = require('child_process');
    const root = ${JSON.stringify(root)}, UGREP = ${JSON.stringify(UGREP)};
    const rows = ${JSON.stringify(ROWS.map((r) => [r[1], r[2] ? ML_INPUT(r[2]).toString('base64') : null]))};
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    const l1 = (b) => Buffer.from(b).toString('latin1');
    (async () => {
      const out = [];
      for (const [argv, input] of rows) {
        const inp = input ? Buffer.from(input, 'base64') : Buffer.alloc(0);
        const s = rgn.runRg(argv, { ...ctx, cwd: root, input: inp });
        const a = await new Promise((res) => {
          const c = rgn.rgExecFile(argv, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, so, se) => res({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx);
          if (c.stdin) c.stdin.end(inp);
        });
        out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
      }
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `);
  try {
    const res = runLoader(prog, [], { timeout: 300000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    assert.strictEqual(got.length, ROWS.length);
    ROWS.forEach((row, i) => { check(row, got[i].sync); check(row, got[i].async); });
  } finally { fs.rmSync(prog, { force: true }); }
}));

// RG-NEWLINE-NEEDS-U is rg's own error, not quaude's refusal: the bundle's consumer reads it as native's.
test('RG-NEWLINE-NEEDS-U: a \\n without -U is rg\'s two-paragraph error, rc 2, before anything is searched (no ugrep runs)', () => {
  let ran = 0;
  const r = rgn.runRg(['-n', 'one\\nbeta', '/nonexistent-dir'], { spawnSync: (...a) => { ran++; return cp.spawnSync(...a); }, ugrep: () => UGREP || '/nonexistent/ugrep',
    matchFiles: rgn.matchFilesAlone });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout.length, 0);
  assert.strictEqual(l1(r.stderr), ROWS.find((x) => x[0] === 'RG-NEWLINE-NEEDS-U' && x[3] === 2)[5]);
  assert.strictEqual(rgn.parseRgRefusal(r.stderr), null);
  assert.strictEqual(ran, 0, 'rg errors on the pattern before it searches');
});

// ---- bounded and abortable, as the line searcher is ----------------------------------------------------------
// RG-RE-REFUSE-COST under -U: one step budget per file (twice lineStepBudget of its text, its finds and its
// printers' together), so a pattern whose leftmost-first finds rescan the text (`a.*z|a`: each `a` reads on to
// the end looking for a z) is refused by name after a bounded number of steps, never left to run for minutes.
test('RG-RE-REFUSE-COST: a multi-line search past its file\'s step budget refuses by name, bounded (counted)', { skip: POSIX }, () => withMl((root) => {
  fs.writeFileSync(path.join(root, 'aaa.txt'), 'a'.repeat(4000) + '\n' + 'a'.repeat(4000) + '\n');
  const t0 = Date.now();
  const r = rgn.runRg(['-U', '--multiline-dotall', '-c', 'a.*z|a', 'aaa.txt'], { cwd: root, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
  const ref = rgn.parseRgRefusal(r.stderr);
  assert.ok(ref && /RG-RE-REFUSE-COST/.test(ref.reason) && /multi-line search of 8002 bytes/.test(ref.reason), l1(r.stderr));
  assert.ok(Date.now() - t0 < 30000, `${Date.now() - t0} ms`);
  // an ordinary multi-line pattern over the same text is answered (native: 2 lines' worth of blocks, 1 match each... counted)
  const ok = rgn.runRg(['-U', '--multiline-dotall', '-c', 'a\\na', 'aaa.txt'], { cwd: root, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
  assert.deepStrictEqual([ok.status, l1(ok.stdout)], [0, '1\n'], l1(ok.stderr));
}));

// Under tjs, over a 4 MB file of blocks: the async twin keeps the event loop turning (no gap past 600 ms) and
// answers what the sync twin does; an execFile timeout ends it within a bound; maxBuffer stops the printing.
test('RG-MULTILINE under tjs: a 4 MB multi-line search keeps the loop turning, ends at a timeout, stops at maxBuffer', {
  skip: POSIX || NO_TJS,
}, () => withMl((root) => {
  fs.writeFileSync(path.join(root, 'big.txt'), 'x one\nbeta y\nfiller line here\n'.repeat(130000));
  const prog = path.join(root, '..', path.basename(root) + '-big.cjs');
  fs.writeFileSync(prog, `
    const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
    const cp = require('child_process');
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone };
    const root = ${JSON.stringify(root)};
    const exec = (argv, o) => new Promise((res) => rgn.rgExecFile(argv, { cwd: root, encoding: 'buffer', ...o },
      (err, so) => res({ code: err && err.code, killed: err && err.killed, signal: err && err.signal, out: so.toString('latin1') }), 'rg', ctx));
    (async () => {
      const out = {};
      const s = rgn.runRg(['-U', '--multiline-dotall', '-c', 'one.beta', 'big.txt'], { ...ctx, cwd: root });
      out.sync = s.stdout.toString();
      let last = Date.now(), gap = 0;
      const iv = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 10);
      const t0 = Date.now();
      const a = await exec(['-U', '--multiline-dotall', '-c', 'one.beta', 'big.txt'], { maxBuffer: 1 << 20 });
      out.async = { out: a.out, ms: Date.now() - t0, gap };
      const t1 = Date.now();
      const k = await exec(['-U', '--multiline-dotall', '--json', 'one.beta', 'big.txt'], { timeout: 300, killSignal: 'SIGKILL', maxBuffer: 1 << 30 });
      out.timeout = { killed: k.killed, signal: k.signal, ms: Date.now() - t1 };
      const m = await exec(['-U', '--multiline-dotall', '--json', 'one.beta', 'big.txt'], { maxBuffer: 5000 });
      out.maxBuffer = { code: m.code, len: m.out.length, printed: rgn.searchStats.printed };
      clearInterval(iv);
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `);
  try {
    const res = runLoader(prog, [], { timeout: 300000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    if (process.env.RG_TIMINGS) console.log('RG_TIMINGS ' + JSON.stringify(got));
    assert.strictEqual(got.sync, '130000\n');
    assert.strictEqual(got.async.out, '130000\n');
    const held = judgeHold({ maxGap: got.async.gap, ms: got.async.ms });
    assert.ok(!held, `the async twin: ${held}`);
    assert.deepStrictEqual([got.timeout.killed, got.timeout.signal], [true, 'SIGKILL'], JSON.stringify(got.timeout));
    assert.ok(got.timeout.ms < 5000, `the timeout ended the search ${got.timeout.ms} ms in`);
    assert.strictEqual(got.maxBuffer.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.ok(got.maxBuffer.printed < 5000 + 64 * 1024, `printed ${got.maxBuffer.printed} bytes past a 5000-byte maxBuffer`);
  } finally { fs.rmSync(prog, { force: true }); }
}));

// Review I-2 of Task 10's fix round: many matches on ONE long line made lines::locate rescan the line from its
// start for every match (quadratic: a 1 MB minified line stepped back over 23 GB). Counted (searchStats.scannedBack,
// rg-native.cjs's instrument for every line-start search): linear in the text.
test('RG-MULTILINE: locating many matches on one long line steps back over the text a bounded number of times (counted)', { skip: POSIX }, () => withMl((root) => {
  const line = 'x = function (a) { return a; }, '.repeat(6000) + '\n';           // 192 KB, 6,000 matches, one line
  fs.writeFileSync(path.join(root, 'min.js'), line);
  const r = rgn.runRg(['-U', '--multiline-dotall', '-c', 'function\\s*\\(', 'min.js'], { cwd: root, spawnSync: cp.spawnSync, ugrep: () => null,
    matchFiles: rgn.matchFilesAlone });
  assert.deepStrictEqual([r.status, l1(r.stdout)], [0, '6000\n'], l1(r.stderr));   // native 2.1.283: 6000
  assert.ok(rgn.searchStats.scannedBack <= 2 * line.length, `stepped back over ${rgn.searchStats.scannedBack} bytes of a ${line.length}-byte text`);
}));

// RG-MULTILINE-PRINTED's refusal (review minor of Task 10's fix round): the searcher's slice sees `^b` at byte 1
// (after `a`), so the block is line 1 alone, but the printer, reading from the text's start, re-finds `b\nc\nd`
// there, reaching to byte 6: native 2.1.283's --json PANICS ("range end index 6 out of range for slice of length
// 3", no exit status), so quaude's rg refuses by name; every other printer answers as native's does.
test('RG-MULTILINE-PRINTED: where native\'s --json panics, quaude\'s rg refuses by name; -c, -l, -o, -n answer as native', { skip: POSIX }, () => withMl((root) => {
  fs.writeFileSync(path.join(root, 'p.txt'), 'ab\nc\nd\n');
  const run = (m) => rgn.runRg(['-U', ...m, 'a|^b|b\\nc\\nd', 'p.txt'], { cwd: root, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
  const j = run(['--json']);
  const ref = rgn.parseRgRefusal(j.stderr);
  assert.strictEqual(j.status, 2);
  assert.strictEqual(j.stdout.length, 0);
  assert.ok(ref && /RG-MULTILINE-PRINTED/.test(ref.reason) && /panics/.test(ref.reason) && /search had started/.test(ref.reason), l1(j.stderr));
  // native 2.1.283's literals
  for (const [m, out] of [[['-c'], '2\n'], [['-l'], 'p.txt\n'], [['-n'], '1:ab\n'], [['-n', '-o'], '1:a\n1:b\n'], [['-c', '-o'], '2\n']]) {
    const r = run(m);
    assert.deepStrictEqual([r.status, l1(r.stdout)], [0, out], `${m.join(' ')}: ${l1(r.stderr)}`);
  }
}));
