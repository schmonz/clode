'use strict';
// quaude's rg emulation (libexec/rg-native.cjs), rule by rule. Native is the truth: every
// expected literal below is what 2.1.283's EMBEDDED rg (ripgrep 14.1.1 rev 7c1d0ed28a,
// darwin-arm64) answered on the same fixture, read from its `--json` submatches as
// absolute_offset + start/end (measured 2026-10-03, grep-native Task 5; the measurement is
// recorded in that task's report). Each test names the rule it pins.
//
// THE PLUMBING (Task 5): ugrep supplies the MATCH BYTE RANGES for an explicit list of files
// (the walk is quaude's, Task 9), searching binaries as text; the printers (Tasks 6-8)
// re-derive everything else from the file bytes. ugrepMatches is that plumbing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const rgn = require('../libexec/rg-native.cjs');
const { makeRgTree, normalizeRg } = require('../scripts/lib/rg-probe.cjs');
const { tjsPath, runLoader, engineSpawn, LOADER } = require('./node-shim-helper.cjs');
const { judgeHold } = require('./loop-hold.cjs');
const { missingExtDeps } = require('./shim-surface/collect.cjs');
const { census, rngBias, assertCensus, intRng } = require('./shape-census.cjs');
// Why a test under tjs cannot run here: no engine, or the shim without its ext-dep closure (quaude
// always carries it; without it node-shim falls back to buffer-lite, a shim quaude never ships, which
// lacks Buffer methods rg-native uses: the test would fail on the checkout, not on quaude).
const NO_TJS = !tjsPath() ? 'no tjs engine' : (() => {
  const missing = missingExtDeps();
  return missing.length ? `the shim's ext-dep closure is not installed (${missing.join(', ')}; npm ci --prefix deps/claude)` : false;
})();

// The host ugrep the tests drive (quaude's own resolution: CLODE_UGREP, else PATH).
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

const r = (...pairs) => pairs.map(([start, end]) => ({ start, end }));
const asObj = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.map(({ start, end }) => [start, end])]));

function withTree(kind, fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-'));
  try { return fn(makeRgTree(path.join(base, kind), kind)); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

// ---- native's literals (embedded rg 14.1.1, `rg --json PATTERN FILES...` in the tree) ------
const NATIVE_NEEDLE_ROOT = {
  'a.txt': [[6, 12], [28, 34], [39, 45], [65, 71]],   // two matches on line 3
  'crlf.txt': [[4, 10], [23, 29]],                     // CRLF: the \r is not part of a match
  'latin1.txt': [[5, 11]],                             // invalid UTF-8 (0xE9) is searched
  'bin.dat': [[5, 11], [23, 29]],                      // NUL at 19: searched as text
  'code.js': [[6, 12]],
  'uni.txt': [[6, 12], [20, 26]],
  'nonl.txt': [[5, 11]],
  'long.txt': [[6, 12], [614, 620], [1339, 1345]],
};
const NATIVE_NEEDLE_I_ROOT = {
  'a.txt': [[6, 12], [28, 34], [39, 45], [65, 71]],
  'crlf.txt': [[4, 10], [23, 29]],
  'uni.txt': [[6, 12], [20, 26], [32, 38]],           // NEEDLE on line 2, after U+1F600
};
// `e*` matches empty: rg reports every empty match EXCEPT one at the end of the match before it.
const NATIVE_EMPTY_ROOT = {
  'crlf.txt': [[0, 0], [1, 1], [2, 3], [4, 4], [5, 7], [8, 8], [9, 10], [11, 11], [12, 12], [13, 13], [14, 14], [15, 15],
    [16, 16], [17, 17], [18, 18], [19, 19], [20, 22], [23, 23], [24, 26], [27, 27], [28, 29], [30, 30]],
  'nonl.txt': [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 8], [9, 9], [10, 11], [12, 12], [13, 13], [14, 14],
    [15, 15], [16, 17], [18, 18], [19, 19], [20, 20], [21, 22]],
};
const ROOT_FILES = ['a.txt', 'bin.dat', 'code.js', 'crlf.txt', 'empty.txt', 'latin1.txt', 'long.txt', 'nonl.txt', 'uni.txt'];

test('ugrepMatches: byte ranges for text, CRLF, invalid UTF-8, a binary, several matches per line (native)', needUgrep, () => {
  withTree('root', (dir) => {
    const got = rgn.ugrepMatches(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir });
    assert.deepStrictEqual(asObj(got), Object.fromEntries(ROOT_FILES.filter((f) => NATIVE_NEEDLE_ROOT[f]).map((f) => [f, NATIVE_NEEDLE_ROOT[f]])));
    assert.deepStrictEqual(got.get('a.txt'), r([6, 12], [28, 34], [39, 45], [65, 71]), 'ranges are {start, end}');
  });
});

test('ugrepMatches: the Map follows the input order and holds only files with a match', needUgrep, () => {
  withTree('root', (dir) => {
    const order = ['uni.txt', 'empty.txt', 'a.txt', 'code.js', 'crlf.txt'];
    const got = rgn.ugrepMatches(order, 'needle', { ugrep: UGREP, cwd: dir });
    assert.deepStrictEqual([...got.keys()], ['uni.txt', 'a.txt', 'code.js', 'crlf.txt']);
    assert.strictEqual(got.has('empty.txt'), false);
  });
});

test('ugrepMatches: a NUL past rg\'s first 64 KiB read is still searched as text (native, bin2)', needUgrep, () => {
  withTree('bin2', (dir) => {
    const got = rgn.ugrepMatches(['early.dat', 'late.dat'], 'needle', { ugrep: UGREP, cwd: dir });
    assert.deepStrictEqual(asObj(got), { 'early.dat': [[5, 11], [23, 29]], 'late.dat': [[6, 12], [120023, 120029], [120038, 120044]] });
  });
});

test('ugrepMatches: -i (native)', needUgrep, () => {
  withTree('root', (dir) => {
    const got = rgn.ugrepMatches(['a.txt', 'crlf.txt', 'uni.txt'], 'NEEDLE', { ugrep: UGREP, cwd: dir, ignoreCase: true });
    assert.deepStrictEqual(asObj(got), NATIVE_NEEDLE_I_ROOT);
  });
});

test('RG-EMPTY-AFTER-MATCH: an empty match at the end of the match before it is not a match (native)', needUgrep, () => {
  withTree('root', (dir) => {
    const got = rgn.ugrepMatches(['crlf.txt', 'nonl.txt'], 'e*', { ugrep: UGREP, cwd: dir });
    assert.deepStrictEqual(asObj(got), NATIVE_EMPTY_ROOT);
  });
});

// NATIVE covers `-dash.txt`, `nl\nname.txt` and `./-` (`rg --json needle -- -dash.txt 'nl<LF>name.txt' ./-`
// gave each [[2,8]]). A BARE `-` is NOT a file to rg: as a positional it reads stdin (`<stdin>`).
// ugrepMatches is file-level plumbing, so every name it is given is a FILE, `-` included (it goes
// in as ./-); rg's positional `-` is the stdin branch, and the emulation must answer it there and
// NEVER pass it into ugrepMatches.
test('ugrepMatches: names that look like options, or hold a newline, are files (native); a bare - is the file ./-', needUgrep, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-odd-'));
  try {
    const names = ['-dash.txt', 'nl\nname.txt', '-', './-'];
    for (const n of ['-dash.txt', 'nl\nname.txt', '-']) fs.writeFileSync(path.join(dir, n), 'x needle\n');
    const got = rgn.ugrepMatches(names, 'needle', { ugrep: UGREP, cwd: dir });
    // native: {"-dash.txt":[[2,8]],"nl\nname.txt":[[2,8]],"./-":[[2,8]]}; `-` here is the file ./- (ours only)
    assert.deepStrictEqual(asObj(got), { '-dash.txt': [[2, 8]], 'nl\nname.txt': [[2, 8]], '-': [[2, 8]], './-': [[2, 8]] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ugrepMatches: a list longer than one command line is searched in chunks, same answer', needUgrep, () => {
  withTree('root', (dir) => {
    const whole = rgn.ugrepMatches(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir });
    const chunked = rgn.ugrepMatches(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir, argvBudget: 1 });
    assert.deepStrictEqual(asObj(chunked), asObj(whole));
    assert.deepStrictEqual(rgn.chunkFiles(['a', 'bb', 'ccc', 'dddd'], 6), [['a', 'bb'], ['ccc'], ['dddd']]);
    assert.deepStrictEqual(rgn.chunkFiles([], 6), []);
  });
});

test('ugrepMatches: an empty list starts no ugrep and finds nothing', () => {
  let ran = 0;
  const got = rgn.ugrepMatches([], 'needle', { ugrep: '/nonexistent/ugrep', spawnSync: () => { ran++; return {}; } });
  assert.strictEqual(ran, 0);
  assert.strictEqual(got.size, 0);
});

// A path ugrep only WARNS about (exit 2, the rest searched: 7.8.2 `ugrep: warning: X: No such file or
// directory`) is rg's per-path error riding on the answer, never ugrep failing (Task 6 re-review N3);
// ugrep failing otherwise is the stand-in rows below ("a failed chunk ends the search").
test('ugrepMatches: a path ugrep warns about is a per-path error on the answer, the rest answered (sync and async)', needUgrep, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-'));
  try {
    const dir = makeRgTree(path.join(base, 'root'), 'root');
    for (const got of [rgn.ugrepMatches(['a.txt', 'no-such-file.txt'], 'needle', { ugrep: UGREP, cwd: dir }),
      await rgn.ugrepMatchesAsync(['a.txt', 'no-such-file.txt'], 'needle', { ugrep: UGREP, cwd: dir })]) {
      assert.deepStrictEqual(asObj(got), { 'a.txt': NATIVE_NEEDLE_ROOT['a.txt'] });
      assert.deepStrictEqual(got.pathErrors, [{ file: 'no-such-file.txt', text: 'No such file or directory (os error 2)' }]);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('parseUgrepRanges: path NUL start SP end LF records, linear, any bytes in the path', () => {
  const rec = (p, a, b) => Buffer.concat([Buffer.from(p), Buffer.from([0]), Buffer.from(`${a} ${b}\n`)]);
  const buf = Buffer.concat([rec('a', 1, 2), rec('x\ny', 0, 0), rec('a', 5, 9), rec('a', 9, 9), rec('a', 12, 12)]);
  const got = rgn.parseUgrepRanges(buf);
  assert.deepStrictEqual(asObj(got), { a: [[1, 2], [5, 9], [12, 12]], 'x\ny': [[0, 0]] });
  // `%~` is "newline (LF or CRLF)" in ugrep's help: a CRLF-terminated record reads the same
  const crlf = Buffer.concat([Buffer.from('w'), Buffer.from([0]), Buffer.from('3 4\r\n'), Buffer.from('w'), Buffer.from([0]), Buffer.from('7 9\r\n')]);
  assert.deepStrictEqual(asObj(rgn.parseUgrepRanges(crlf)), { w: [[3, 4], [7, 9]] });
  assert.throws(() => rgn.parseUgrepRanges(Buffer.concat([Buffer.from('a'), Buffer.from([0]), Buffer.from('x y\n')])), (e) => e.name === 'UgrepError' && /ugrep's --format output/.test(e.message));
});

// ---- the floor: which ugrep this plumbing is measured against --------------------------------
test('ugrepCapabilities: the version floor is 5.0.0 (measured: 3.11.2 differs, 5.0.0 and 7.8.2 agree)', () => {
  assert.strictEqual(rgn.UGREP_MIN, '5.0.0');
  assert.strictEqual(rgn.parseUgrepVersion('ugrep 7.8.2 aarch64-apple-darwin25 +neon/AArch64; -P:pcre2'), '7.8.2');
  assert.strictEqual(rgn.parseUgrepVersion('ugrep 3.11.2 x86_64-pc-linux-gnu +sse2 +pcre2jit'), '3.11.2');
  assert.strictEqual(rgn.parseUgrepVersion('ripgrep 14.1.1'), null);
  for (const [v, ok] of [['3.11.2', false], ['4.99.99', false], ['5.0.0', true], ['5.0.1', true], ['7.8.2', true], ['10.0.0', true]]) {
    assert.strictEqual(rgn.versionAtLeast(v, rgn.UGREP_MIN), ok, v);
  }
});

test('ugrepCapabilities: an older ugrep is refused, naming its version and the floor', { skip: process.platform === 'win32' ? 'needs a /bin/sh stand-in' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-caps-'));
  try {
    const old = path.join(dir, 'ugrep');
    fs.writeFileSync(old, '#!/bin/sh\necho "ugrep 3.11.2 x86_64-pc-linux-gnu +sse2"\n', { mode: 0o755 });
    const c = rgn.ugrepCapabilities(old);
    assert.strictEqual(c.version, '3.11.2');
    assert.strictEqual(c.format, false);
    assert.match(c.reason, /ugrep 3\.11\.2 .*5\.0\.0/);
    const none = rgn.ugrepCapabilities(path.join(dir, 'absent'));
    assert.strictEqual(none.format, false);
    assert.strictEqual(none.version, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ugrepCapabilities: this host\'s ugrep', needUgrep, () => {
  assert.match(CAPS.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(CAPS.format, true);
  assert.strictEqual(CAPS.reason, null);
});

// Stand-in ugreps, written to a scratch dir: { name: '/bin/sh body' } -> { name: path }.
const posixStub = { skip: process.platform === 'win32' ? 'needs a /bin/sh stand-in' : false };
function withStubs(bodies, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-stub-'));
  const paths = {};
  for (const [n, body] of Object.entries(bodies)) {
    paths[n] = path.join(dir, n);
    fs.writeFileSync(paths[n], `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return Promise.resolve().then(() => fn(paths, dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// The floor is ENFORCED, not just reported: a ugrep below it answers a missing file with exit 0
// and nothing printed, which reads as "no matches" (review I1: ugrepMatches returned an empty Map).
test('ugrepMatches / ugrepMatchesAsync refuse a ugrep below the floor, never answer "no matches"', posixStub, () =>
  withStubs({ ugrep: 'if [ "$1" = --version ]; then echo "ugrep 3.11.2 x86_64-pc-linux-gnu"; fi; exit 0' }, async ({ ugrep }, dir) => {
    const floor = (e) => e.name === 'UgrepError' && /ugrep 3\.11\.2 is older than 5\.0\.0/.test(e.message);
    assert.throws(() => rgn.ugrepMatches(['no-such.txt'], 'needle', { ugrep, cwd: dir }), floor);
    await assert.rejects(rgn.ugrepMatchesAsync(['no-such.txt'], 'needle', { ugrep, cwd: dir }), floor);
  }));

// A failed chunk ends the search: later chunks never start (review I3: killing the first child
// still spawned all five). Each stand-in logs its run, then fails its own way.
const STUB_VERSION = 'if [ "$1" = --version ]; then echo "ugrep 7.8.2 stand-in"; exit 0; fi';
test('a failed chunk ends the search: killed, or exit >= 2, no later chunk starts (sync and async)', posixStub, () =>
  withStubs({ slow: `${STUB_VERSION}; exec sleep 5`, fails: `${STUB_VERSION}; echo "ugrep: boom" >&2; exit 2` }, async (st, dir) => {
    const files = ['a', 'b', 'c', 'd', 'e'];
    // count the searches each twin starts (the --version probe is not one)
    let spawned = 0;
    await assert.rejects(rgn.ugrepMatchesAsync(files, 'x', { ugrep: st.slow, cwd: dir, argvBudget: 1,
      onChild: (c) => { spawned++; c.kill('SIGKILL'); } }), (e) => e.name === 'UgrepError' && e.signal === 'SIGKILL');
    assert.strictEqual(spawned, 1, 'a killed chunk must end the search');
    spawned = 0;
    await assert.rejects(rgn.ugrepMatchesAsync(files, 'x', { ugrep: st.fails, cwd: dir, argvBudget: 1, onChild: () => { spawned++; } }),
      (e) => e.name === 'UgrepError' && e.status === 2);
    assert.strictEqual(spawned, 1, 'an exit >= 2 must end the async search');
    let searches = 0;
    const counting = (bin, args, o) => { if (args[0] !== '--version') searches++; return cp.spawnSync(bin, args, o); };
    assert.throws(() => rgn.ugrepMatches(files, 'x', { ugrep: st.fails, cwd: dir, argvBudget: 1, spawnSync: counting }),
      (e) => e.name === 'UgrepError' && e.status === 2);
    assert.strictEqual(searches, 1, 'an exit >= 2 must end the sync search');
  }));

// A ugrep killed mid-record is reported as KILLED, not as malformed output (review M1): the
// status is read before the bytes, which a killed run may have cut off anywhere.
test('a ugrep killed mid-record is reported as killed, never as malformed output (sync and async)', posixStub, () =>
  withStubs({ trunc: `${STUB_VERSION}; printf 'a.txt\\0006 1'; kill -9 $$` }, async (st, dir) => {
    const killed = (e) => e.name === 'UgrepError' && e.signal === 'SIGKILL' && /signal SIGKILL/.test(e.message)
      && !/--format output/.test(e.message);
    assert.throws(() => rgn.ugrepMatches(['a.txt'], 'x', { ugrep: st.trunc, cwd: dir }), killed);
    await assert.rejects(rgn.ugrepMatchesAsync(['a.txt'], 'x', { ugrep: st.trunc, cwd: dir }), killed);
  }));

// A ugrep that EXITS >= 2 having printed a partial record is reported as the failure it is (its
// status and stderr), never as malformed output (Task 5 re-review N-1): the status is read before
// the bytes, and a bad tail after a failure says nothing more than the failure already does.
test('a ugrep that exits >= 2 mid-record is reported as its failure, never as malformed output (sync and async)', posixStub, () =>
  withStubs({ bad2: `${STUB_VERSION}; printf 'a.txt\\0006 1'; echo "ugrep: boom" >&2; exit 2` }, async (st, dir) => {
    const failed = (e) => e.name === 'UgrepError' && e.status === 2 && /exit 2/.test(e.message) && /boom/.test(e.message)
      && /boom/.test(e.stderr) && !/--format output/.test(e.message);
    assert.throws(() => rgn.ugrepMatches(['a.txt'], 'x', { ugrep: st.bad2, cwd: dir }), failed);
    await assert.rejects(rgn.ugrepMatchesAsync(['a.txt'], 'x', { ugrep: st.bad2, cwd: dir }), failed);
  }));

// Every reported path is one that was asked for, and every listed name is a file (review M2):
// a match ugrep places in some OTHER path cannot be answered for, and a directory in the list
// was searched as nothing at all (ugrep exits 0 on one). Both are refusals, never dropped.
test('a match in a path not asked for, or a directory in the list, is refused (sync and async)', posixStub, () =>
  withStubs({ stray: `${STUB_VERSION}; printf 'other.txt\\0001 2\\n'; exit 0` }, async (st, dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    const env = process.env;
    const stray = (e) => e.name === 'UgrepError' && /other\.txt/.test(e.message) && /not asked for/.test(e.message);
    assert.throws(() => rgn.ugrepMatches(['a.txt'], 'x', { ugrep: st.stray, cwd: dir, env }), stray);
    await assert.rejects(rgn.ugrepMatchesAsync(['a.txt'], 'x', { ugrep: st.stray, cwd: dir, env }), stray);
    const isDir = (e) => e.name === 'UgrepError' && /sub is a directory/.test(e.message);
    assert.throws(() => rgn.ugrepMatches(['a.txt', 'sub'], 'x', { ugrep: st.stray, cwd: dir, env }), isDir);
    await assert.rejects(rgn.ugrepMatchesAsync(['a.txt', 'sub'], 'x', { ugrep: st.stray, cwd: dir, env }), isDir);
  }));

// ---- Task 5b: ugrep proposes, rg's matcher decides ---------------------------------------------
// No ugrep dialect is rg's (Task 5's table, BACKLOG). So ugrepMatches hands ugrep rg-regex.cjs's
// PREFILTER (a superset of rg's lines) and decides every proposed line with rg's own matcher. Every
// row of Task 5's dialect table is native's now, on whatever ugrep is at or above the floor. The
// literals are native's --json submatches over the root tree plus alt.txt (bin.dat is binary:
// its lines are rg's binary rules, Task 8), with ONE addition per RG-RE-MATCH-AT-UNTERMINATED-END:
// nonl.txt's last line has no terminator, so the match at its end (22-22) that the matcher finds
// is one rg's printers do not print (`$`: native's --json selects the line with submatches []).
const DIALECT_FILES = ['a.txt', 'alt.txt', 'code.js', 'crlf.txt', 'empty.txt', 'latin1.txt', 'long.txt', 'nonl.txt', 'uni.txt'];
const NATIVE_DIALECT = [
  ['a|ab', {"a.txt":[[0,1],[4,5],[20,21],[23,24],[26,27],[50,51],[63,64]],"alt.txt":[[0,1],[7,8],[11,12],[18,19],[21,22]],"latin1.txt":[[1,2]],"long.txt":[[1333,1334]],"nonl.txt":[[1,2]],"uni.txt":[[1,2],[46,47]]}],
  ['foo|foobar', {"alt.txt":[[3,6]]}],
  ['sam|samwise', {"alt.txt":[[10,13]]}],
  ['\\b', {"a.txt":[[0,0],[5,5],[6,6],[12,12],[13,13],[16,16],[17,17],[21,21],[22,22],[27,27],[28,28],[34,34],[35,35],[38,38],[39,39],[45,45],[46,46],[51,51],[52,52],[59,59],[60,60],[64,64],[65,65],[71,71]],"alt.txt":[[0,0],[2,2],[3,3],[9,9],[10,10],[17,17],[18,18],[20,20],[21,21],[23,23]],"code.js":[[0,0],[5,5],[6,6],[12,12],[15,15],[16,16]],"crlf.txt":[[0,0],[3,3],[4,4],[10,10],[12,12],[15,15],[17,17],[22,22],[23,23],[29,29]],"latin1.txt":[[0,0],[3,3],[5,5],[11,11]],"long.txt":[[0,0],[5,5],[6,6],[12,12],[13,13],[613,613],[614,614],[620,620],[621,621],[631,631],[632,632],[1332,1332],[1333,1333],[1338,1338],[1339,1339],[1345,1345]],"nonl.txt":[[0,0],[4,4],[5,5],[11,11],[12,12],[14,14],[15,15]],"uni.txt":[[0,0],[5,5],[6,6],[12,12],[13,13],[19,19],[20,20],[26,26],[32,32],[38,38],[39,39],[43,43],[44,44],[49,49]]}],
  ['f\\b', {"latin1.txt":[[2,3]]}],
  ['[[:alpha:]]+', {"a.txt":[[0,5],[6,12],[13,16],[17,21],[22,27],[28,34],[35,38],[39,45],[46,51],[52,59],[60,64],[65,71]],"alt.txt":[[0,2],[3,9],[10,17],[18,20],[21,23]],"code.js":[[0,5],[6,12]],"crlf.txt":[[0,3],[4,10],[12,15],[17,22],[23,29]],"latin1.txt":[[0,3],[5,11]],"long.txt":[[0,5],[6,12],[13,613],[614,620],[621,631],[632,1332],[1333,1338],[1339,1345]],"nonl.txt":[[0,4],[5,11],[12,14],[15,22]],"uni.txt":[[0,3],[6,12],[20,26],[32,38],[39,43],[44,49]]}],
  ['needle', {"a.txt":[[6,12],[28,34],[39,45],[65,71]],"code.js":[[6,12]],"crlf.txt":[[4,10],[23,29]],"latin1.txt":[[5,11]],"long.txt":[[6,12],[614,620],[1339,1345]],"nonl.txt":[[5,11]],"uni.txt":[[6,12],[20,26]]}],
  ['e*', {"a.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,9],[10,10],[11,12],[13,13],[14,14],[15,16],[17,17],[18,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,28],[29,31],[32,32],[33,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,42],[43,43],[44,45],[46,46],[47,48],[49,49],[50,50],[51,51],[52,53],[54,54],[55,55],[56,56],[57,57],[58,58],[59,59],[60,60],[61,62],[63,63],[64,64],[65,65],[66,68],[69,69],[70,71]],"alt.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]],"code.js":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,9],[10,10],[11,12],[13,13],[14,14],[15,15],[16,16],[17,17]],"crlf.txt":[[0,0],[1,1],[2,3],[4,4],[5,7],[8,8],[9,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,22],[23,23],[24,26],[27,27],[28,29],[30,30]],"latin1.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,8],[9,9],[10,11]],"long.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,9],[10,10],[11,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,42],[43,43],[44,44],[45,45],[46,46],[47,47],[48,48],[49,49],[50,50],[51,51],[52,52],[53,53],[54,54],[55,55],[56,56],[57,57],[58,58],[59,59],[60,60],[61,61],[62,62],[63,63],[64,64],[65,65],[66,66],[67,67],[68,68],[69,69],[70,70],[71,71],[72,72],[73,73],[74,74],[75,75],[76,76],[77,77],[78,78],[79,79],[80,80],[81,81],[82,82],[83,83],[84,84],[85,85],[86,86],[87,87],[88,88],[89,89],[90,90],[91,91],[92,92],[93,93],[94,94],[95,95],[96,96],[97,97],[98,98],[99,99],[100,100],[101,101],[102,102],[103,103],[104,104],[105,105],[106,106],[107,107],[108,108],[109,109],[110,110],[111,111],[112,112],[113,113],[114,114],[115,115],[116,116],[117,117],[118,118],[119,119],[120,120],[121,121],[122,122],[123,123],[124,124],[125,125],[126,126],[127,127],[128,128],[129,129],[130,130],[131,131],[132,132],[133,133],[134,134],[135,135],[136,136],[137,137],[138,138],[139,139],[140,140],[141,141],[142,142],[143,143],[144,144],[145,145],[146,146],[147,147],[148,148],[149,149],[150,150],[151,151],[152,152],[153,153],[154,154],[155,155],[156,156],[157,157],[158,158],[159,159],[160,160],[161,161],[162,162],[163,163],[164,164],[165,165],[166,166],[167,167],[168,168],[169,169],[170,170],[171,171],[172,172],[173,173],[174,174],[175,175],[176,176],[177,177],[178,178],[179,179],[180,180],[181,181],[182,182],[183,183],[184,184],[185,185],[186,186],[187,187],[188,188],[189,189],[190,190],[191,191],[192,192],[193,193],[194,194],[195,195],[196,196],[197,197],[198,198],[199,199],[200,200],[201,201],[202,202],[203,203],[204,204],[205,205],[206,206],[207,207],[208,208],[209,209],[210,210],[211,211],[212,212],[213,213],[214,214],[215,215],[216,216],[217,217],[218,218],[219,219],[220,220],[221,221],[222,222],[223,223],[224,224],[225,225],[226,226],[227,227],[228,228],[229,229],[230,230],[231,231],[232,232],[233,233],[234,234],[235,235],[236,236],[237,237],[238,238],[239,239],[240,240],[241,241],[242,242],[243,243],[244,244],[245,245],[246,246],[247,247],[248,248],[249,249],[250,250],[251,251],[252,252],[253,253],[254,254],[255,255],[256,256],[257,257],[258,258],[259,259],[260,260],[261,261],[262,262],[263,263],[264,264],[265,265],[266,266],[267,267],[268,268],[269,269],[270,270],[271,271],[272,272],[273,273],[274,274],[275,275],[276,276],[277,277],[278,278],[279,279],[280,280],[281,281],[282,282],[283,283],[284,284],[285,285],[286,286],[287,287],[288,288],[289,289],[290,290],[291,291],[292,292],[293,293],[294,294],[295,295],[296,296],[297,297],[298,298],[299,299],[300,300],[301,301],[302,302],[303,303],[304,304],[305,305],[306,306],[307,307],[308,308],[309,309],[310,310],[311,311],[312,312],[313,313],[314,314],[315,315],[316,316],[317,317],[318,318],[319,319],[320,320],[321,321],[322,322],[323,323],[324,324],[325,325],[326,326],[327,327],[328,328],[329,329],[330,330],[331,331],[332,332],[333,333],[334,334],[335,335],[336,336],[337,337],[338,338],[339,339],[340,340],[341,341],[342,342],[343,343],[344,344],[345,345],[346,346],[347,347],[348,348],[349,349],[350,350],[351,351],[352,352],[353,353],[354,354],[355,355],[356,356],[357,357],[358,358],[359,359],[360,360],[361,361],[362,362],[363,363],[364,364],[365,365],[366,366],[367,367],[368,368],[369,369],[370,370],[371,371],[372,372],[373,373],[374,374],[375,375],[376,376],[377,377],[378,378],[379,379],[380,380],[381,381],[382,382],[383,383],[384,384],[385,385],[386,386],[387,387],[388,388],[389,389],[390,390],[391,391],[392,392],[393,393],[394,394],[395,395],[396,396],[397,397],[398,398],[399,399],[400,400],[401,401],[402,402],[403,403],[404,404],[405,405],[406,406],[407,407],[408,408],[409,409],[410,410],[411,411],[412,412],[413,413],[414,414],[415,415],[416,416],[417,417],[418,418],[419,419],[420,420],[421,421],[422,422],[423,423],[424,424],[425,425],[426,426],[427,427],[428,428],[429,429],[430,430],[431,431],[432,432],[433,433],[434,434],[435,435],[436,436],[437,437],[438,438],[439,439],[440,440],[441,441],[442,442],[443,443],[444,444],[445,445],[446,446],[447,447],[448,448],[449,449],[450,450],[451,451],[452,452],[453,453],[454,454],[455,455],[456,456],[457,457],[458,458],[459,459],[460,460],[461,461],[462,462],[463,463],[464,464],[465,465],[466,466],[467,467],[468,468],[469,469],[470,470],[471,471],[472,472],[473,473],[474,474],[475,475],[476,476],[477,477],[478,478],[479,479],[480,480],[481,481],[482,482],[483,483],[484,484],[485,485],[486,486],[487,487],[488,488],[489,489],[490,490],[491,491],[492,492],[493,493],[494,494],[495,495],[496,496],[497,497],[498,498],[499,499],[500,500],[501,501],[502,502],[503,503],[504,504],[505,505],[506,506],[507,507],[508,508],[509,509],[510,510],[511,511],[512,512],[513,513],[514,514],[515,515],[516,516],[517,517],[518,518],[519,519],[520,520],[521,521],[522,522],[523,523],[524,524],[525,525],[526,526],[527,527],[528,528],[529,529],[530,530],[531,531],[532,532],[533,533],[534,534],[535,535],[536,536],[537,537],[538,538],[539,539],[540,540],[541,541],[542,542],[543,543],[544,544],[545,545],[546,546],[547,547],[548,548],[549,549],[550,550],[551,551],[552,552],[553,553],[554,554],[555,555],[556,556],[557,557],[558,558],[559,559],[560,560],[561,561],[562,562],[563,563],[564,564],[565,565],[566,566],[567,567],[568,568],[569,569],[570,570],[571,571],[572,572],[573,573],[574,574],[575,575],[576,576],[577,577],[578,578],[579,579],[580,580],[581,581],[582,582],[583,583],[584,584],[585,585],[586,586],[587,587],[588,588],[589,589],[590,590],[591,591],[592,592],[593,593],[594,594],[595,595],[596,596],[597,597],[598,598],[599,599],[600,600],[601,601],[602,602],[603,603],[604,604],[605,605],[606,606],[607,607],[608,608],[609,609],[610,610],[611,611],[612,612],[613,613],[614,614],[615,617],[618,618],[619,620],[621,621],[622,622],[623,623],[624,624],[625,625],[626,626],[627,627],[628,628],[629,629],[630,630],[631,631],[632,632],[633,633],[634,634],[635,635],[636,636],[637,637],[638,638],[639,639],[640,640],[641,641],[642,642],[643,643],[644,644],[645,645],[646,646],[647,647],[648,648],[649,649],[650,650],[651,651],[652,652],[653,653],[654,654],[655,655],[656,656],[657,657],[658,658],[659,659],[660,660],[661,661],[662,662],[663,663],[664,664],[665,665],[666,666],[667,667],[668,668],[669,669],[670,670],[671,671],[672,672],[673,673],[674,674],[675,675],[676,676],[677,677],[678,678],[679,679],[680,680],[681,681],[682,682],[683,683],[684,684],[685,685],[686,686],[687,687],[688,688],[689,689],[690,690],[691,691],[692,692],[693,693],[694,694],[695,695],[696,696],[697,697],[698,698],[699,699],[700,700],[701,701],[702,702],[703,703],[704,704],[705,705],[706,706],[707,707],[708,708],[709,709],[710,710],[711,711],[712,712],[713,713],[714,714],[715,715],[716,716],[717,717],[718,718],[719,719],[720,720],[721,721],[722,722],[723,723],[724,724],[725,725],[726,726],[727,727],[728,728],[729,729],[730,730],[731,731],[732,732],[733,733],[734,734],[735,735],[736,736],[737,737],[738,738],[739,739],[740,740],[741,741],[742,742],[743,743],[744,744],[745,745],[746,746],[747,747],[748,748],[749,749],[750,750],[751,751],[752,752],[753,753],[754,754],[755,755],[756,756],[757,757],[758,758],[759,759],[760,760],[761,761],[762,762],[763,763],[764,764],[765,765],[766,766],[767,767],[768,768],[769,769],[770,770],[771,771],[772,772],[773,773],[774,774],[775,775],[776,776],[777,777],[778,778],[779,779],[780,780],[781,781],[782,782],[783,783],[784,784],[785,785],[786,786],[787,787],[788,788],[789,789],[790,790],[791,791],[792,792],[793,793],[794,794],[795,795],[796,796],[797,797],[798,798],[799,799],[800,800],[801,801],[802,802],[803,803],[804,804],[805,805],[806,806],[807,807],[808,808],[809,809],[810,810],[811,811],[812,812],[813,813],[814,814],[815,815],[816,816],[817,817],[818,818],[819,819],[820,820],[821,821],[822,822],[823,823],[824,824],[825,825],[826,826],[827,827],[828,828],[829,829],[830,830],[831,831],[832,832],[833,833],[834,834],[835,835],[836,836],[837,837],[838,838],[839,839],[840,840],[841,841],[842,842],[843,843],[844,844],[845,845],[846,846],[847,847],[848,848],[849,849],[850,850],[851,851],[852,852],[853,853],[854,854],[855,855],[856,856],[857,857],[858,858],[859,859],[860,860],[861,861],[862,862],[863,863],[864,864],[865,865],[866,866],[867,867],[868,868],[869,869],[870,870],[871,871],[872,872],[873,873],[874,874],[875,875],[876,876],[877,877],[878,878],[879,879],[880,880],[881,881],[882,882],[883,883],[884,884],[885,885],[886,886],[887,887],[888,888],[889,889],[890,890],[891,891],[892,892],[893,893],[894,894],[895,895],[896,896],[897,897],[898,898],[899,899],[900,900],[901,901],[902,902],[903,903],[904,904],[905,905],[906,906],[907,907],[908,908],[909,909],[910,910],[911,911],[912,912],[913,913],[914,914],[915,915],[916,916],[917,917],[918,918],[919,919],[920,920],[921,921],[922,922],[923,923],[924,924],[925,925],[926,926],[927,927],[928,928],[929,929],[930,930],[931,931],[932,932],[933,933],[934,934],[935,935],[936,936],[937,937],[938,938],[939,939],[940,940],[941,941],[942,942],[943,943],[944,944],[945,945],[946,946],[947,947],[948,948],[949,949],[950,950],[951,951],[952,952],[953,953],[954,954],[955,955],[956,956],[957,957],[958,958],[959,959],[960,960],[961,961],[962,962],[963,963],[964,964],[965,965],[966,966],[967,967],[968,968],[969,969],[970,970],[971,971],[972,972],[973,973],[974,974],[975,975],[976,976],[977,977],[978,978],[979,979],[980,980],[981,981],[982,982],[983,983],[984,984],[985,985],[986,986],[987,987],[988,988],[989,989],[990,990],[991,991],[992,992],[993,993],[994,994],[995,995],[996,996],[997,997],[998,998],[999,999],[1000,1000],[1001,1001],[1002,1002],[1003,1003],[1004,1004],[1005,1005],[1006,1006],[1007,1007],[1008,1008],[1009,1009],[1010,1010],[1011,1011],[1012,1012],[1013,1013],[1014,1014],[1015,1015],[1016,1016],[1017,1017],[1018,1018],[1019,1019],[1020,1020],[1021,1021],[1022,1022],[1023,1023],[1024,1024],[1025,1025],[1026,1026],[1027,1027],[1028,1028],[1029,1029],[1030,1030],[1031,1031],[1032,1032],[1033,1033],[1034,1034],[1035,1035],[1036,1036],[1037,1037],[1038,1038],[1039,1039],[1040,1040],[1041,1041],[1042,1042],[1043,1043],[1044,1044],[1045,1045],[1046,1046],[1047,1047],[1048,1048],[1049,1049],[1050,1050],[1051,1051],[1052,1052],[1053,1053],[1054,1054],[1055,1055],[1056,1056],[1057,1057],[1058,1058],[1059,1059],[1060,1060],[1061,1061],[1062,1062],[1063,1063],[1064,1064],[1065,1065],[1066,1066],[1067,1067],[1068,1068],[1069,1069],[1070,1070],[1071,1071],[1072,1072],[1073,1073],[1074,1074],[1075,1075],[1076,1076],[1077,1077],[1078,1078],[1079,1079],[1080,1080],[1081,1081],[1082,1082],[1083,1083],[1084,1084],[1085,1085],[1086,1086],[1087,1087],[1088,1088],[1089,1089],[1090,1090],[1091,1091],[1092,1092],[1093,1093],[1094,1094],[1095,1095],[1096,1096],[1097,1097],[1098,1098],[1099,1099],[1100,1100],[1101,1101],[1102,1102],[1103,1103],[1104,1104],[1105,1105],[1106,1106],[1107,1107],[1108,1108],[1109,1109],[1110,1110],[1111,1111],[1112,1112],[1113,1113],[1114,1114],[1115,1115],[1116,1116],[1117,1117],[1118,1118],[1119,1119],[1120,1120],[1121,1121],[1122,1122],[1123,1123],[1124,1124],[1125,1125],[1126,1126],[1127,1127],[1128,1128],[1129,1129],[1130,1130],[1131,1131],[1132,1132],[1133,1133],[1134,1134],[1135,1135],[1136,1136],[1137,1137],[1138,1138],[1139,1139],[1140,1140],[1141,1141],[1142,1142],[1143,1143],[1144,1144],[1145,1145],[1146,1146],[1147,1147],[1148,1148],[1149,1149],[1150,1150],[1151,1151],[1152,1152],[1153,1153],[1154,1154],[1155,1155],[1156,1156],[1157,1157],[1158,1158],[1159,1159],[1160,1160],[1161,1161],[1162,1162],[1163,1163],[1164,1164],[1165,1165],[1166,1166],[1167,1167],[1168,1168],[1169,1169],[1170,1170],[1171,1171],[1172,1172],[1173,1173],[1174,1174],[1175,1175],[1176,1176],[1177,1177],[1178,1178],[1179,1179],[1180,1180],[1181,1181],[1182,1182],[1183,1183],[1184,1184],[1185,1185],[1186,1186],[1187,1187],[1188,1188],[1189,1189],[1190,1190],[1191,1191],[1192,1192],[1193,1193],[1194,1194],[1195,1195],[1196,1196],[1197,1197],[1198,1198],[1199,1199],[1200,1200],[1201,1201],[1202,1202],[1203,1203],[1204,1204],[1205,1205],[1206,1206],[1207,1207],[1208,1208],[1209,1209],[1210,1210],[1211,1211],[1212,1212],[1213,1213],[1214,1214],[1215,1215],[1216,1216],[1217,1217],[1218,1218],[1219,1219],[1220,1220],[1221,1221],[1222,1222],[1223,1223],[1224,1224],[1225,1225],[1226,1226],[1227,1227],[1228,1228],[1229,1229],[1230,1230],[1231,1231],[1232,1232],[1233,1233],[1234,1234],[1235,1235],[1236,1236],[1237,1237],[1238,1238],[1239,1239],[1240,1240],[1241,1241],[1242,1242],[1243,1243],[1244,1244],[1245,1245],[1246,1246],[1247,1247],[1248,1248],[1249,1249],[1250,1250],[1251,1251],[1252,1252],[1253,1253],[1254,1254],[1255,1255],[1256,1256],[1257,1257],[1258,1258],[1259,1259],[1260,1260],[1261,1261],[1262,1262],[1263,1263],[1264,1264],[1265,1265],[1266,1266],[1267,1267],[1268,1268],[1269,1269],[1270,1270],[1271,1271],[1272,1272],[1273,1273],[1274,1274],[1275,1275],[1276,1276],[1277,1277],[1278,1278],[1279,1279],[1280,1280],[1281,1281],[1282,1282],[1283,1283],[1284,1284],[1285,1285],[1286,1286],[1287,1287],[1288,1288],[1289,1289],[1290,1290],[1291,1291],[1292,1292],[1293,1293],[1294,1294],[1295,1295],[1296,1296],[1297,1297],[1298,1298],[1299,1299],[1300,1300],[1301,1301],[1302,1302],[1303,1303],[1304,1304],[1305,1305],[1306,1306],[1307,1307],[1308,1308],[1309,1309],[1310,1310],[1311,1311],[1312,1312],[1313,1313],[1314,1314],[1315,1315],[1316,1316],[1317,1317],[1318,1318],[1319,1319],[1320,1320],[1321,1321],[1322,1322],[1323,1323],[1324,1324],[1325,1325],[1326,1326],[1327,1327],[1328,1328],[1329,1329],[1330,1330],[1331,1331],[1332,1332],[1333,1333],[1334,1334],[1335,1335],[1336,1337],[1338,1338],[1339,1339],[1340,1342],[1343,1343],[1344,1345]],"nonl.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,8],[9,9],[10,11],[12,12],[13,13],[14,14],[15,15],[16,17],[18,18],[19,19],[20,20],[21,22]],"uni.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,9],[10,10],[11,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,23],[24,24],[25,26],[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,43],[44,44],[45,45],[46,46],[47,47],[48,48],[49,49]]}],
  ['x*', {"a.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,42],[43,43],[44,44],[45,45],[46,46],[47,47],[48,48],[49,49],[50,50],[51,51],[52,52],[53,53],[54,54],[55,55],[56,56],[57,57],[58,58],[59,59],[60,60],[61,61],[62,62],[63,63],[64,64],[65,65],[66,66],[67,67],[68,68],[69,69],[70,70],[71,71]],"alt.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]],"code.js":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]],"crlf.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,28],[29,29],[30,30]],"latin1.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11]],"long.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,613],[614,614],[615,615],[616,616],[617,617],[618,618],[619,619],[620,620],[621,621],[622,622],[623,623],[624,624],[625,625],[626,626],[627,627],[628,628],[629,629],[630,630],[631,631],[632,632],[633,633],[634,634],[635,635],[636,636],[637,637],[638,638],[639,639],[640,640],[641,641],[642,642],[643,643],[644,644],[645,645],[646,646],[647,647],[648,648],[649,649],[650,650],[651,651],[652,652],[653,653],[654,654],[655,655],[656,656],[657,657],[658,658],[659,659],[660,660],[661,661],[662,662],[663,663],[664,664],[665,665],[666,666],[667,667],[668,668],[669,669],[670,670],[671,671],[672,672],[673,673],[674,674],[675,675],[676,676],[677,677],[678,678],[679,679],[680,680],[681,681],[682,682],[683,683],[684,684],[685,685],[686,686],[687,687],[688,688],[689,689],[690,690],[691,691],[692,692],[693,693],[694,694],[695,695],[696,696],[697,697],[698,698],[699,699],[700,700],[701,701],[702,702],[703,703],[704,704],[705,705],[706,706],[707,707],[708,708],[709,709],[710,710],[711,711],[712,712],[713,713],[714,714],[715,715],[716,716],[717,717],[718,718],[719,719],[720,720],[721,721],[722,722],[723,723],[724,724],[725,725],[726,726],[727,727],[728,728],[729,729],[730,730],[731,731],[732,732],[733,733],[734,734],[735,735],[736,736],[737,737],[738,738],[739,739],[740,740],[741,741],[742,742],[743,743],[744,744],[745,745],[746,746],[747,747],[748,748],[749,749],[750,750],[751,751],[752,752],[753,753],[754,754],[755,755],[756,756],[757,757],[758,758],[759,759],[760,760],[761,761],[762,762],[763,763],[764,764],[765,765],[766,766],[767,767],[768,768],[769,769],[770,770],[771,771],[772,772],[773,773],[774,774],[775,775],[776,776],[777,777],[778,778],[779,779],[780,780],[781,781],[782,782],[783,783],[784,784],[785,785],[786,786],[787,787],[788,788],[789,789],[790,790],[791,791],[792,792],[793,793],[794,794],[795,795],[796,796],[797,797],[798,798],[799,799],[800,800],[801,801],[802,802],[803,803],[804,804],[805,805],[806,806],[807,807],[808,808],[809,809],[810,810],[811,811],[812,812],[813,813],[814,814],[815,815],[816,816],[817,817],[818,818],[819,819],[820,820],[821,821],[822,822],[823,823],[824,824],[825,825],[826,826],[827,827],[828,828],[829,829],[830,830],[831,831],[832,832],[833,833],[834,834],[835,835],[836,836],[837,837],[838,838],[839,839],[840,840],[841,841],[842,842],[843,843],[844,844],[845,845],[846,846],[847,847],[848,848],[849,849],[850,850],[851,851],[852,852],[853,853],[854,854],[855,855],[856,856],[857,857],[858,858],[859,859],[860,860],[861,861],[862,862],[863,863],[864,864],[865,865],[866,866],[867,867],[868,868],[869,869],[870,870],[871,871],[872,872],[873,873],[874,874],[875,875],[876,876],[877,877],[878,878],[879,879],[880,880],[881,881],[882,882],[883,883],[884,884],[885,885],[886,886],[887,887],[888,888],[889,889],[890,890],[891,891],[892,892],[893,893],[894,894],[895,895],[896,896],[897,897],[898,898],[899,899],[900,900],[901,901],[902,902],[903,903],[904,904],[905,905],[906,906],[907,907],[908,908],[909,909],[910,910],[911,911],[912,912],[913,913],[914,914],[915,915],[916,916],[917,917],[918,918],[919,919],[920,920],[921,921],[922,922],[923,923],[924,924],[925,925],[926,926],[927,927],[928,928],[929,929],[930,930],[931,931],[932,932],[933,933],[934,934],[935,935],[936,936],[937,937],[938,938],[939,939],[940,940],[941,941],[942,942],[943,943],[944,944],[945,945],[946,946],[947,947],[948,948],[949,949],[950,950],[951,951],[952,952],[953,953],[954,954],[955,955],[956,956],[957,957],[958,958],[959,959],[960,960],[961,961],[962,962],[963,963],[964,964],[965,965],[966,966],[967,967],[968,968],[969,969],[970,970],[971,971],[972,972],[973,973],[974,974],[975,975],[976,976],[977,977],[978,978],[979,979],[980,980],[981,981],[982,982],[983,983],[984,984],[985,985],[986,986],[987,987],[988,988],[989,989],[990,990],[991,991],[992,992],[993,993],[994,994],[995,995],[996,996],[997,997],[998,998],[999,999],[1000,1000],[1001,1001],[1002,1002],[1003,1003],[1004,1004],[1005,1005],[1006,1006],[1007,1007],[1008,1008],[1009,1009],[1010,1010],[1011,1011],[1012,1012],[1013,1013],[1014,1014],[1015,1015],[1016,1016],[1017,1017],[1018,1018],[1019,1019],[1020,1020],[1021,1021],[1022,1022],[1023,1023],[1024,1024],[1025,1025],[1026,1026],[1027,1027],[1028,1028],[1029,1029],[1030,1030],[1031,1031],[1032,1032],[1033,1033],[1034,1034],[1035,1035],[1036,1036],[1037,1037],[1038,1038],[1039,1039],[1040,1040],[1041,1041],[1042,1042],[1043,1043],[1044,1044],[1045,1045],[1046,1046],[1047,1047],[1048,1048],[1049,1049],[1050,1050],[1051,1051],[1052,1052],[1053,1053],[1054,1054],[1055,1055],[1056,1056],[1057,1057],[1058,1058],[1059,1059],[1060,1060],[1061,1061],[1062,1062],[1063,1063],[1064,1064],[1065,1065],[1066,1066],[1067,1067],[1068,1068],[1069,1069],[1070,1070],[1071,1071],[1072,1072],[1073,1073],[1074,1074],[1075,1075],[1076,1076],[1077,1077],[1078,1078],[1079,1079],[1080,1080],[1081,1081],[1082,1082],[1083,1083],[1084,1084],[1085,1085],[1086,1086],[1087,1087],[1088,1088],[1089,1089],[1090,1090],[1091,1091],[1092,1092],[1093,1093],[1094,1094],[1095,1095],[1096,1096],[1097,1097],[1098,1098],[1099,1099],[1100,1100],[1101,1101],[1102,1102],[1103,1103],[1104,1104],[1105,1105],[1106,1106],[1107,1107],[1108,1108],[1109,1109],[1110,1110],[1111,1111],[1112,1112],[1113,1113],[1114,1114],[1115,1115],[1116,1116],[1117,1117],[1118,1118],[1119,1119],[1120,1120],[1121,1121],[1122,1122],[1123,1123],[1124,1124],[1125,1125],[1126,1126],[1127,1127],[1128,1128],[1129,1129],[1130,1130],[1131,1131],[1132,1132],[1133,1133],[1134,1134],[1135,1135],[1136,1136],[1137,1137],[1138,1138],[1139,1139],[1140,1140],[1141,1141],[1142,1142],[1143,1143],[1144,1144],[1145,1145],[1146,1146],[1147,1147],[1148,1148],[1149,1149],[1150,1150],[1151,1151],[1152,1152],[1153,1153],[1154,1154],[1155,1155],[1156,1156],[1157,1157],[1158,1158],[1159,1159],[1160,1160],[1161,1161],[1162,1162],[1163,1163],[1164,1164],[1165,1165],[1166,1166],[1167,1167],[1168,1168],[1169,1169],[1170,1170],[1171,1171],[1172,1172],[1173,1173],[1174,1174],[1175,1175],[1176,1176],[1177,1177],[1178,1178],[1179,1179],[1180,1180],[1181,1181],[1182,1182],[1183,1183],[1184,1184],[1185,1185],[1186,1186],[1187,1187],[1188,1188],[1189,1189],[1190,1190],[1191,1191],[1192,1192],[1193,1193],[1194,1194],[1195,1195],[1196,1196],[1197,1197],[1198,1198],[1199,1199],[1200,1200],[1201,1201],[1202,1202],[1203,1203],[1204,1204],[1205,1205],[1206,1206],[1207,1207],[1208,1208],[1209,1209],[1210,1210],[1211,1211],[1212,1212],[1213,1213],[1214,1214],[1215,1215],[1216,1216],[1217,1217],[1218,1218],[1219,1219],[1220,1220],[1221,1221],[1222,1222],[1223,1223],[1224,1224],[1225,1225],[1226,1226],[1227,1227],[1228,1228],[1229,1229],[1230,1230],[1231,1231],[1232,1232],[1233,1233],[1234,1234],[1235,1235],[1236,1236],[1237,1237],[1238,1238],[1239,1239],[1240,1240],[1241,1241],[1242,1242],[1243,1243],[1244,1244],[1245,1245],[1246,1246],[1247,1247],[1248,1248],[1249,1249],[1250,1250],[1251,1251],[1252,1252],[1253,1253],[1254,1254],[1255,1255],[1256,1256],[1257,1257],[1258,1258],[1259,1259],[1260,1260],[1261,1261],[1262,1262],[1263,1263],[1264,1264],[1265,1265],[1266,1266],[1267,1267],[1268,1268],[1269,1269],[1270,1270],[1271,1271],[1272,1272],[1273,1273],[1274,1274],[1275,1275],[1276,1276],[1277,1277],[1278,1278],[1279,1279],[1280,1280],[1281,1281],[1282,1282],[1283,1283],[1284,1284],[1285,1285],[1286,1286],[1287,1287],[1288,1288],[1289,1289],[1290,1290],[1291,1291],[1292,1292],[1293,1293],[1294,1294],[1295,1295],[1296,1296],[1297,1297],[1298,1298],[1299,1299],[1300,1300],[1301,1301],[1302,1302],[1303,1303],[1304,1304],[1305,1305],[1306,1306],[1307,1307],[1308,1308],[1309,1309],[1310,1310],[1311,1311],[1312,1312],[1313,1313],[1314,1314],[1315,1315],[1316,1316],[1317,1317],[1318,1318],[1319,1319],[1320,1320],[1321,1321],[1322,1322],[1323,1323],[1324,1324],[1325,1325],[1326,1326],[1327,1327],[1328,1328],[1329,1329],[1330,1330],[1331,1331],[1332,1332],[1333,1333],[1334,1334],[1335,1335],[1336,1336],[1337,1337],[1338,1338],[1339,1339],[1340,1340],[1341,1341],[1342,1342],[1343,1343],[1344,1344],[1345,1345]],"nonl.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21]],"uni.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,42],[43,43],[44,44],[45,45],[46,46],[47,47],[48,48],[49,49]]}],
  ['needle|', {"a.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,34],[35,35],[36,36],[37,37],[38,38],[39,45],[46,46],[47,47],[48,48],[49,49],[50,50],[51,51],[52,52],[53,53],[54,54],[55,55],[56,56],[57,57],[58,58],[59,59],[60,60],[61,61],[62,62],[63,63],[64,64],[65,71]],"alt.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]],"code.js":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,12],[13,13],[14,14],[15,15],[16,16],[17,17]],"crlf.txt":[[0,0],[1,1],[2,2],[3,3],[4,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,29],[30,30]],"latin1.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,11]],"long.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26],[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,42],[43,43],[44,44],[45,45],[46,46],[47,47],[48,48],[49,49],[50,50],[51,51],[52,52],[53,53],[54,54],[55,55],[56,56],[57,57],[58,58],[59,59],[60,60],[61,61],[62,62],[63,63],[64,64],[65,65],[66,66],[67,67],[68,68],[69,69],[70,70],[71,71],[72,72],[73,73],[74,74],[75,75],[76,76],[77,77],[78,78],[79,79],[80,80],[81,81],[82,82],[83,83],[84,84],[85,85],[86,86],[87,87],[88,88],[89,89],[90,90],[91,91],[92,92],[93,93],[94,94],[95,95],[96,96],[97,97],[98,98],[99,99],[100,100],[101,101],[102,102],[103,103],[104,104],[105,105],[106,106],[107,107],[108,108],[109,109],[110,110],[111,111],[112,112],[113,113],[114,114],[115,115],[116,116],[117,117],[118,118],[119,119],[120,120],[121,121],[122,122],[123,123],[124,124],[125,125],[126,126],[127,127],[128,128],[129,129],[130,130],[131,131],[132,132],[133,133],[134,134],[135,135],[136,136],[137,137],[138,138],[139,139],[140,140],[141,141],[142,142],[143,143],[144,144],[145,145],[146,146],[147,147],[148,148],[149,149],[150,150],[151,151],[152,152],[153,153],[154,154],[155,155],[156,156],[157,157],[158,158],[159,159],[160,160],[161,161],[162,162],[163,163],[164,164],[165,165],[166,166],[167,167],[168,168],[169,169],[170,170],[171,171],[172,172],[173,173],[174,174],[175,175],[176,176],[177,177],[178,178],[179,179],[180,180],[181,181],[182,182],[183,183],[184,184],[185,185],[186,186],[187,187],[188,188],[189,189],[190,190],[191,191],[192,192],[193,193],[194,194],[195,195],[196,196],[197,197],[198,198],[199,199],[200,200],[201,201],[202,202],[203,203],[204,204],[205,205],[206,206],[207,207],[208,208],[209,209],[210,210],[211,211],[212,212],[213,213],[214,214],[215,215],[216,216],[217,217],[218,218],[219,219],[220,220],[221,221],[222,222],[223,223],[224,224],[225,225],[226,226],[227,227],[228,228],[229,229],[230,230],[231,231],[232,232],[233,233],[234,234],[235,235],[236,236],[237,237],[238,238],[239,239],[240,240],[241,241],[242,242],[243,243],[244,244],[245,245],[246,246],[247,247],[248,248],[249,249],[250,250],[251,251],[252,252],[253,253],[254,254],[255,255],[256,256],[257,257],[258,258],[259,259],[260,260],[261,261],[262,262],[263,263],[264,264],[265,265],[266,266],[267,267],[268,268],[269,269],[270,270],[271,271],[272,272],[273,273],[274,274],[275,275],[276,276],[277,277],[278,278],[279,279],[280,280],[281,281],[282,282],[283,283],[284,284],[285,285],[286,286],[287,287],[288,288],[289,289],[290,290],[291,291],[292,292],[293,293],[294,294],[295,295],[296,296],[297,297],[298,298],[299,299],[300,300],[301,301],[302,302],[303,303],[304,304],[305,305],[306,306],[307,307],[308,308],[309,309],[310,310],[311,311],[312,312],[313,313],[314,314],[315,315],[316,316],[317,317],[318,318],[319,319],[320,320],[321,321],[322,322],[323,323],[324,324],[325,325],[326,326],[327,327],[328,328],[329,329],[330,330],[331,331],[332,332],[333,333],[334,334],[335,335],[336,336],[337,337],[338,338],[339,339],[340,340],[341,341],[342,342],[343,343],[344,344],[345,345],[346,346],[347,347],[348,348],[349,349],[350,350],[351,351],[352,352],[353,353],[354,354],[355,355],[356,356],[357,357],[358,358],[359,359],[360,360],[361,361],[362,362],[363,363],[364,364],[365,365],[366,366],[367,367],[368,368],[369,369],[370,370],[371,371],[372,372],[373,373],[374,374],[375,375],[376,376],[377,377],[378,378],[379,379],[380,380],[381,381],[382,382],[383,383],[384,384],[385,385],[386,386],[387,387],[388,388],[389,389],[390,390],[391,391],[392,392],[393,393],[394,394],[395,395],[396,396],[397,397],[398,398],[399,399],[400,400],[401,401],[402,402],[403,403],[404,404],[405,405],[406,406],[407,407],[408,408],[409,409],[410,410],[411,411],[412,412],[413,413],[414,414],[415,415],[416,416],[417,417],[418,418],[419,419],[420,420],[421,421],[422,422],[423,423],[424,424],[425,425],[426,426],[427,427],[428,428],[429,429],[430,430],[431,431],[432,432],[433,433],[434,434],[435,435],[436,436],[437,437],[438,438],[439,439],[440,440],[441,441],[442,442],[443,443],[444,444],[445,445],[446,446],[447,447],[448,448],[449,449],[450,450],[451,451],[452,452],[453,453],[454,454],[455,455],[456,456],[457,457],[458,458],[459,459],[460,460],[461,461],[462,462],[463,463],[464,464],[465,465],[466,466],[467,467],[468,468],[469,469],[470,470],[471,471],[472,472],[473,473],[474,474],[475,475],[476,476],[477,477],[478,478],[479,479],[480,480],[481,481],[482,482],[483,483],[484,484],[485,485],[486,486],[487,487],[488,488],[489,489],[490,490],[491,491],[492,492],[493,493],[494,494],[495,495],[496,496],[497,497],[498,498],[499,499],[500,500],[501,501],[502,502],[503,503],[504,504],[505,505],[506,506],[507,507],[508,508],[509,509],[510,510],[511,511],[512,512],[513,513],[514,514],[515,515],[516,516],[517,517],[518,518],[519,519],[520,520],[521,521],[522,522],[523,523],[524,524],[525,525],[526,526],[527,527],[528,528],[529,529],[530,530],[531,531],[532,532],[533,533],[534,534],[535,535],[536,536],[537,537],[538,538],[539,539],[540,540],[541,541],[542,542],[543,543],[544,544],[545,545],[546,546],[547,547],[548,548],[549,549],[550,550],[551,551],[552,552],[553,553],[554,554],[555,555],[556,556],[557,557],[558,558],[559,559],[560,560],[561,561],[562,562],[563,563],[564,564],[565,565],[566,566],[567,567],[568,568],[569,569],[570,570],[571,571],[572,572],[573,573],[574,574],[575,575],[576,576],[577,577],[578,578],[579,579],[580,580],[581,581],[582,582],[583,583],[584,584],[585,585],[586,586],[587,587],[588,588],[589,589],[590,590],[591,591],[592,592],[593,593],[594,594],[595,595],[596,596],[597,597],[598,598],[599,599],[600,600],[601,601],[602,602],[603,603],[604,604],[605,605],[606,606],[607,607],[608,608],[609,609],[610,610],[611,611],[612,612],[613,613],[614,620],[621,621],[622,622],[623,623],[624,624],[625,625],[626,626],[627,627],[628,628],[629,629],[630,630],[631,631],[632,632],[633,633],[634,634],[635,635],[636,636],[637,637],[638,638],[639,639],[640,640],[641,641],[642,642],[643,643],[644,644],[645,645],[646,646],[647,647],[648,648],[649,649],[650,650],[651,651],[652,652],[653,653],[654,654],[655,655],[656,656],[657,657],[658,658],[659,659],[660,660],[661,661],[662,662],[663,663],[664,664],[665,665],[666,666],[667,667],[668,668],[669,669],[670,670],[671,671],[672,672],[673,673],[674,674],[675,675],[676,676],[677,677],[678,678],[679,679],[680,680],[681,681],[682,682],[683,683],[684,684],[685,685],[686,686],[687,687],[688,688],[689,689],[690,690],[691,691],[692,692],[693,693],[694,694],[695,695],[696,696],[697,697],[698,698],[699,699],[700,700],[701,701],[702,702],[703,703],[704,704],[705,705],[706,706],[707,707],[708,708],[709,709],[710,710],[711,711],[712,712],[713,713],[714,714],[715,715],[716,716],[717,717],[718,718],[719,719],[720,720],[721,721],[722,722],[723,723],[724,724],[725,725],[726,726],[727,727],[728,728],[729,729],[730,730],[731,731],[732,732],[733,733],[734,734],[735,735],[736,736],[737,737],[738,738],[739,739],[740,740],[741,741],[742,742],[743,743],[744,744],[745,745],[746,746],[747,747],[748,748],[749,749],[750,750],[751,751],[752,752],[753,753],[754,754],[755,755],[756,756],[757,757],[758,758],[759,759],[760,760],[761,761],[762,762],[763,763],[764,764],[765,765],[766,766],[767,767],[768,768],[769,769],[770,770],[771,771],[772,772],[773,773],[774,774],[775,775],[776,776],[777,777],[778,778],[779,779],[780,780],[781,781],[782,782],[783,783],[784,784],[785,785],[786,786],[787,787],[788,788],[789,789],[790,790],[791,791],[792,792],[793,793],[794,794],[795,795],[796,796],[797,797],[798,798],[799,799],[800,800],[801,801],[802,802],[803,803],[804,804],[805,805],[806,806],[807,807],[808,808],[809,809],[810,810],[811,811],[812,812],[813,813],[814,814],[815,815],[816,816],[817,817],[818,818],[819,819],[820,820],[821,821],[822,822],[823,823],[824,824],[825,825],[826,826],[827,827],[828,828],[829,829],[830,830],[831,831],[832,832],[833,833],[834,834],[835,835],[836,836],[837,837],[838,838],[839,839],[840,840],[841,841],[842,842],[843,843],[844,844],[845,845],[846,846],[847,847],[848,848],[849,849],[850,850],[851,851],[852,852],[853,853],[854,854],[855,855],[856,856],[857,857],[858,858],[859,859],[860,860],[861,861],[862,862],[863,863],[864,864],[865,865],[866,866],[867,867],[868,868],[869,869],[870,870],[871,871],[872,872],[873,873],[874,874],[875,875],[876,876],[877,877],[878,878],[879,879],[880,880],[881,881],[882,882],[883,883],[884,884],[885,885],[886,886],[887,887],[888,888],[889,889],[890,890],[891,891],[892,892],[893,893],[894,894],[895,895],[896,896],[897,897],[898,898],[899,899],[900,900],[901,901],[902,902],[903,903],[904,904],[905,905],[906,906],[907,907],[908,908],[909,909],[910,910],[911,911],[912,912],[913,913],[914,914],[915,915],[916,916],[917,917],[918,918],[919,919],[920,920],[921,921],[922,922],[923,923],[924,924],[925,925],[926,926],[927,927],[928,928],[929,929],[930,930],[931,931],[932,932],[933,933],[934,934],[935,935],[936,936],[937,937],[938,938],[939,939],[940,940],[941,941],[942,942],[943,943],[944,944],[945,945],[946,946],[947,947],[948,948],[949,949],[950,950],[951,951],[952,952],[953,953],[954,954],[955,955],[956,956],[957,957],[958,958],[959,959],[960,960],[961,961],[962,962],[963,963],[964,964],[965,965],[966,966],[967,967],[968,968],[969,969],[970,970],[971,971],[972,972],[973,973],[974,974],[975,975],[976,976],[977,977],[978,978],[979,979],[980,980],[981,981],[982,982],[983,983],[984,984],[985,985],[986,986],[987,987],[988,988],[989,989],[990,990],[991,991],[992,992],[993,993],[994,994],[995,995],[996,996],[997,997],[998,998],[999,999],[1000,1000],[1001,1001],[1002,1002],[1003,1003],[1004,1004],[1005,1005],[1006,1006],[1007,1007],[1008,1008],[1009,1009],[1010,1010],[1011,1011],[1012,1012],[1013,1013],[1014,1014],[1015,1015],[1016,1016],[1017,1017],[1018,1018],[1019,1019],[1020,1020],[1021,1021],[1022,1022],[1023,1023],[1024,1024],[1025,1025],[1026,1026],[1027,1027],[1028,1028],[1029,1029],[1030,1030],[1031,1031],[1032,1032],[1033,1033],[1034,1034],[1035,1035],[1036,1036],[1037,1037],[1038,1038],[1039,1039],[1040,1040],[1041,1041],[1042,1042],[1043,1043],[1044,1044],[1045,1045],[1046,1046],[1047,1047],[1048,1048],[1049,1049],[1050,1050],[1051,1051],[1052,1052],[1053,1053],[1054,1054],[1055,1055],[1056,1056],[1057,1057],[1058,1058],[1059,1059],[1060,1060],[1061,1061],[1062,1062],[1063,1063],[1064,1064],[1065,1065],[1066,1066],[1067,1067],[1068,1068],[1069,1069],[1070,1070],[1071,1071],[1072,1072],[1073,1073],[1074,1074],[1075,1075],[1076,1076],[1077,1077],[1078,1078],[1079,1079],[1080,1080],[1081,1081],[1082,1082],[1083,1083],[1084,1084],[1085,1085],[1086,1086],[1087,1087],[1088,1088],[1089,1089],[1090,1090],[1091,1091],[1092,1092],[1093,1093],[1094,1094],[1095,1095],[1096,1096],[1097,1097],[1098,1098],[1099,1099],[1100,1100],[1101,1101],[1102,1102],[1103,1103],[1104,1104],[1105,1105],[1106,1106],[1107,1107],[1108,1108],[1109,1109],[1110,1110],[1111,1111],[1112,1112],[1113,1113],[1114,1114],[1115,1115],[1116,1116],[1117,1117],[1118,1118],[1119,1119],[1120,1120],[1121,1121],[1122,1122],[1123,1123],[1124,1124],[1125,1125],[1126,1126],[1127,1127],[1128,1128],[1129,1129],[1130,1130],[1131,1131],[1132,1132],[1133,1133],[1134,1134],[1135,1135],[1136,1136],[1137,1137],[1138,1138],[1139,1139],[1140,1140],[1141,1141],[1142,1142],[1143,1143],[1144,1144],[1145,1145],[1146,1146],[1147,1147],[1148,1148],[1149,1149],[1150,1150],[1151,1151],[1152,1152],[1153,1153],[1154,1154],[1155,1155],[1156,1156],[1157,1157],[1158,1158],[1159,1159],[1160,1160],[1161,1161],[1162,1162],[1163,1163],[1164,1164],[1165,1165],[1166,1166],[1167,1167],[1168,1168],[1169,1169],[1170,1170],[1171,1171],[1172,1172],[1173,1173],[1174,1174],[1175,1175],[1176,1176],[1177,1177],[1178,1178],[1179,1179],[1180,1180],[1181,1181],[1182,1182],[1183,1183],[1184,1184],[1185,1185],[1186,1186],[1187,1187],[1188,1188],[1189,1189],[1190,1190],[1191,1191],[1192,1192],[1193,1193],[1194,1194],[1195,1195],[1196,1196],[1197,1197],[1198,1198],[1199,1199],[1200,1200],[1201,1201],[1202,1202],[1203,1203],[1204,1204],[1205,1205],[1206,1206],[1207,1207],[1208,1208],[1209,1209],[1210,1210],[1211,1211],[1212,1212],[1213,1213],[1214,1214],[1215,1215],[1216,1216],[1217,1217],[1218,1218],[1219,1219],[1220,1220],[1221,1221],[1222,1222],[1223,1223],[1224,1224],[1225,1225],[1226,1226],[1227,1227],[1228,1228],[1229,1229],[1230,1230],[1231,1231],[1232,1232],[1233,1233],[1234,1234],[1235,1235],[1236,1236],[1237,1237],[1238,1238],[1239,1239],[1240,1240],[1241,1241],[1242,1242],[1243,1243],[1244,1244],[1245,1245],[1246,1246],[1247,1247],[1248,1248],[1249,1249],[1250,1250],[1251,1251],[1252,1252],[1253,1253],[1254,1254],[1255,1255],[1256,1256],[1257,1257],[1258,1258],[1259,1259],[1260,1260],[1261,1261],[1262,1262],[1263,1263],[1264,1264],[1265,1265],[1266,1266],[1267,1267],[1268,1268],[1269,1269],[1270,1270],[1271,1271],[1272,1272],[1273,1273],[1274,1274],[1275,1275],[1276,1276],[1277,1277],[1278,1278],[1279,1279],[1280,1280],[1281,1281],[1282,1282],[1283,1283],[1284,1284],[1285,1285],[1286,1286],[1287,1287],[1288,1288],[1289,1289],[1290,1290],[1291,1291],[1292,1292],[1293,1293],[1294,1294],[1295,1295],[1296,1296],[1297,1297],[1298,1298],[1299,1299],[1300,1300],[1301,1301],[1302,1302],[1303,1303],[1304,1304],[1305,1305],[1306,1306],[1307,1307],[1308,1308],[1309,1309],[1310,1310],[1311,1311],[1312,1312],[1313,1313],[1314,1314],[1315,1315],[1316,1316],[1317,1317],[1318,1318],[1319,1319],[1320,1320],[1321,1321],[1322,1322],[1323,1323],[1324,1324],[1325,1325],[1326,1326],[1327,1327],[1328,1328],[1329,1329],[1330,1330],[1331,1331],[1332,1332],[1333,1333],[1334,1334],[1335,1335],[1336,1336],[1337,1337],[1338,1338],[1339,1345]],"nonl.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21]],"uni.txt":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,26],[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,42],[43,43],[44,44],[45,45],[46,46],[47,47],[48,48],[49,49]]}],
  ['\\w+', {"a.txt":[[0,5],[6,12],[13,16],[17,21],[22,27],[28,34],[35,38],[39,45],[46,51],[52,59],[60,64],[65,71]],"alt.txt":[[0,2],[3,9],[10,17],[18,20],[21,23]],"code.js":[[0,5],[6,12],[15,16]],"crlf.txt":[[0,3],[4,10],[12,15],[17,22],[23,29]],"latin1.txt":[[0,3],[5,11]],"long.txt":[[0,5],[6,12],[13,613],[614,620],[621,631],[632,1332],[1333,1338],[1339,1345]],"nonl.txt":[[0,4],[5,11],[12,14],[15,22]],"uni.txt":[[0,5],[6,12],[13,19],[20,26],[32,38],[39,43],[44,49]]}],
  ['(?i)NEEDLE', {"a.txt":[[6,12],[28,34],[39,45],[65,71]],"code.js":[[6,12]],"crlf.txt":[[4,10],[23,29]],"latin1.txt":[[5,11]],"long.txt":[[6,12],[614,620],[1339,1345]],"nonl.txt":[[5,11]],"uni.txt":[[6,12],[20,26],[32,38]]}],
  ['ne+', {"a.txt":[[6,9],[14,16],[28,31],[39,42],[65,68]],"code.js":[[6,9]],"crlf.txt":[[1,3],[4,7],[23,26]],"latin1.txt":[[5,8]],"long.txt":[[6,9],[614,617],[1339,1342]],"nonl.txt":[[5,8],[15,17],[20,22]],"uni.txt":[[6,9],[20,23]]}],
  ['\\d+', {"code.js":[[15,16]]}],
  ['n(ee|e)d', {"a.txt":[[6,10],[28,32],[39,43],[65,69]],"code.js":[[6,10]],"crlf.txt":[[4,8],[23,27]],"latin1.txt":[[5,9]],"long.txt":[[6,10],[614,618],[1339,1343]],"nonl.txt":[[5,9]],"uni.txt":[[6,10],[20,24]]}],
  ['^', {"a.txt":[[0,0],[17,17],[22,22],[46,46],[52,52],[60,60]],"alt.txt":[[0,0],[18,18]],"code.js":[[0,0]],"crlf.txt":[[0,0],[12,12],[17,17]],"latin1.txt":[[0,0]],"long.txt":[[0,0],[13,13],[632,632],[1333,1333]],"nonl.txt":[[0,0]],"uni.txt":[[0,0],[27,27],[44,44]]}],
  ['$', {"a.txt":[[16,16],[21,21],[45,45],[51,51],[59,59],[71,71]],"alt.txt":[[17,17],[23,23]],"code.js":[[17,17]],"crlf.txt":[[11,11],[16,16],[30,30]],"latin1.txt":[[11,11]],"long.txt":[[12,12],[631,631],[1332,1332],[1345,1345]],"nonl.txt":[],"uni.txt":[[26,26],[43,43],[49,49]]}],
  ['caf.', {"uni.txt":[[0,5]]}],
];
const AT_UNTERMINATED_END = new Set(['\\b', 'x*', 'needle|', '$']);
for (const [pattern, native] of NATIVE_DIALECT) {
  test(`RG-RE (Task 5 dialect row): ${JSON.stringify(pattern)} through ugrepMatches is native's`, needUgrep, () => {
    withTree('root', (dir) => {
      fs.writeFileSync(path.join(dir, 'alt.txt'), 'ab foobar samwise\nab ab\n');
      const want = JSON.parse(JSON.stringify(native));
      if (AT_UNTERMINATED_END.has(pattern)) want['nonl.txt'] = (want['nonl.txt'] || []).concat([[22, 22]]);
      for (const k of Object.keys(want)) if (!want[k].length) delete want[k];
      assert.deepStrictEqual(asObj(rgn.ugrepMatches(DIALECT_FILES, pattern, { ugrep: UGREP, cwd: dir })), want);
    });
  });
}

// A pattern quaude's rg cannot answer exactly is refused BEFORE any ugrep runs: a UgrepError whose
// `refused` names the rule, its message the reason (rg-regex.cjs REFUSALS).
test('a pattern rg-regex refuses is a UgrepError naming the rule, and no ugrep runs (sync and async)', async () => {
  let ran = 0;
  const spawnSync = () => { ran++; return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; };
  const spawn = () => { ran++; throw new Error('must not spawn'); };
  const refused = (e) => e.name === 'UgrepError' && e.refused === 'RG-RE-REFUSE-UNICODE-CLASS' && /quaude answers rg/.test(e.message);
  assert.throws(() => rgn.ugrepMatches(['a.txt'], '\\p{Greek}', { ugrep: '/nonexistent/ugrep', spawnSync }), refused);
  await assert.rejects(rgn.ugrepMatchesAsync(['a.txt'], '\\p{Greek}', { ugrep: '/nonexistent/ugrep', spawnSync, spawn }), refused);
  assert.strictEqual(ran, 0);
});

// RG-RE-REFUSE-LOOKBEHIND reaches the caller the same way, from the line that needs it.
test('RG-RE-REFUSE-LOOKBEHIND: \\B on a line that starts inside a character refuses through ugrepMatches (sync and async)', needUgrep, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-lb-'));
  try {
    fs.writeFileSync(path.join(dir, 'lb.txt'), Buffer.concat([Buffer.from('y\n'), Buffer.from([0x80]), Buffer.from(' x\n')]));
    const refused = (e) => e.name === 'UgrepError' && e.refused === 'RG-RE-REFUSE-LOOKBEHIND';
    assert.throws(() => rgn.ugrepMatches(['lb.txt'], '\\B', { ugrep: UGREP, cwd: dir }), refused);
    await assert.rejects(rgn.ugrepMatchesAsync(['lb.txt'], '\\B', { ugrep: UGREP, cwd: dir }), refused);
    // \b reads an invalid byte and a line start alike: answered (native: [[0,0],[1,1]] then [[4,4],[5,5]])
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(['lb.txt'], '\\b', { ugrep: UGREP, cwd: dir })), { 'lb.txt': [[0, 0], [1, 1], [4, 4], [5, 5]] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// RG-TEXT-BOM: rg searches what its decoder makes of a file with a byte order mark: a UTF-8 BOM is
// stripped, UTF-16 (LE `FF FE`, BE `FE FF`) is transcoded to UTF-8 the WHATWG way (an unpaired
// surrogate, and an odd last byte, each become U+FFFD), and its offsets are into THAT text. A UTF-32
// BOM is not rg's: `FF FE 00 00` reads as UTF-16LE. ugrep transcodes such files its own way, so
// every line of a file with any BOM is decided by the matcher, whatever ugrep proposed (native).
test('RG-TEXT-BOM: files with a byte order mark answer as native', needUgrep, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-bom-'));
  try {
    const u16 = (s) => Buffer.from(s, 'utf16le');
    const files = {
      'bom8.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ab needle\n')]),
      'bom16le.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), u16('ab needle\nx needle\n')]),
      'bom16be.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), u16('ab needle\n').swap16()]),
      'bom32le.txt': Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from([...'ab needle\n'].flatMap((c) => [c.charCodeAt(0), 0, 0, 0]))]),
      'u16bad.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), u16('ab needle\n'), Buffer.from([0x00, 0xd8]), u16('x needle\n'),
        Buffer.from([0x00, 0xdc]), u16('y.\n'), Buffer.from([0x41])]),
    };
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
    const names = Object.keys(files);
    // native: bom8 [[3,9]]; bom16le [[3,9],[12,18]]; bom16be [[3,9]]; bom32le rc 1; u16bad [[3,9],[15,21]]
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(names, 'needle', { ugrep: UGREP, cwd: dir })),
      { 'bom8.txt': [[3, 9]], 'bom16le.txt': [[3, 9], [12, 18]], 'bom16be.txt': [[3, 9]], 'u16bad.txt': [[3, 9], [15, 21]] });
    // native, u16bad `y.*`: [[25,27]] (U+FFFD at 22-25, then `y.`); `^.`: each line's first character
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(['u16bad.txt'], 'y.*', { ugrep: UGREP, cwd: dir })), { 'u16bad.txt': [[25, 27]] });
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(['u16bad.txt'], '^.', { ugrep: UGREP, cwd: dir })), { 'u16bad.txt': [[0, 1], [10, 13], [22, 25], [28, 31]] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ugrepMatchesAsync answers an aborted signal with a UgrepError, never a partial answer', needUgrep, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-abort-'));
  try {
    const dir = makeRgTree(path.join(base, 'root'), 'root');
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(rgn.ugrepMatchesAsync(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir, signal: ac.signal }),
      (e) => e.name === 'UgrepError' && /aborted/.test(e.message));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// RG-RE-REFUSE-COST through ugrepMatches: a line past the step budget is a UgrepError naming the rule.
test('RG-RE-REFUSE-COST: a line past the step budget refuses through ugrepMatches (sync and async)', needUgrep, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-cost-'));
  try {
    // the `@` at its end makes ugrep propose the line; deciding it is the costly part
    fs.writeFileSync(path.join(dir, 'min.js'), 'abcdefgh'.repeat(25000) + '@\n');
    const cost = (e) => e.name === 'UgrepError' && e.refused === 'RG-RE-REFUSE-COST';
    assert.throws(() => rgn.ugrepMatches(['min.js'], '[a-z]{1,64}@', { ugrep: UGREP, cwd: dir }), cost);
    await assert.rejects(rgn.ugrepMatchesAsync(['min.js'], '[a-z]{1,64}@', { ugrep: UGREP, cwd: dir }), cost);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A minified bundle's one line (5 MB, seeded code-like tokens) and native's answers over it: test/rg-bundle-line.cjs.
const { bundleLine, NATIVE_BUNDLE_LINE } = require('./rg-bundle-line.cjs');
test('RG-RE-REFUSE-COST scales with the line: a 5 MB minified line answers ordinary patterns through both twins (native)', needUgrep, async () => {
  const crypto = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-bundle-'));
  try {
    fs.writeFileSync(path.join(dir, 'bundle.js'), bundleLine());
    fs.writeFileSync(path.join(dir, 'q.txt'), 'quiet\n');
    const dig = (m) => crypto.createHash('sha256').update(JSON.stringify((m.get('bundle.js') || []).map((x) => [x.start, x.end]))).digest('hex').slice(0, 20);
    for (const [pattern, , digest] of NATIVE_BUNDLE_LINE.filter(([p]) => p === '\\w+Error' || p === 'x|')) {
      assert.strictEqual(dig(rgn.ugrepMatches(['bundle.js', 'q.txt'], pattern, { ugrep: UGREP, cwd: dir })), digest, pattern);
      assert.strictEqual(dig(await rgn.ugrepMatchesAsync(['bundle.js', 'q.txt'], pattern, { ugrep: UGREP, cwd: dir })), digest, pattern);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The PREFILTER must not make ugrep itself slow on a long line: ugrep 7.8.2 takes over 20 minutes
// on `(?:.)*needle` (the old widening of `.{0,100}needle`) over a 5 MB line with no `needle`, and
// `x(?:.)*needle` stalls likewise (each `x` scans to the line's end), where it takes 40 ms on
// `needle`. A prefilter therefore holds no unbounded repetition (RG-RE-PREFILTER-SUPERSET's
// pieces rule); the search below must end, whichever way, inside 15 s.
test('a prefilter never stalls ugrep on a 5 MB line: `.{0,100}needle` and `x.*needle` end in seconds', needUgrep, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-stall-'));
  try {
    fs.writeFileSync(path.join(dir, 'bundle.js'), bundleLine());
    // nested counts (review round 3): `(?:[^a]{0,16}b){16}` became `(?:(?:.){0,16}b){16}`, over 30 s
    for (const pattern of ['.{0,100}needle', 'x.*needle', '[a-z]+.*Zebra', '(?:[^a]{0,16}b){16}', '(?:[^,]{0,16},){16}', '(?:.{0,16}){16}needle']) {
      let child = null, timer = null;
      const t0 = Date.now();
      const run = rgn.ugrepMatchesAsync(['bundle.js'], pattern, { ugrep: UGREP, cwd: dir, onChild: (c) => { child = c; } })
        .then((m) => `answered ${m.size}`, (e) => `refused ${e.refused || e.message}`);
      const out = await Promise.race([run, new Promise((r) => { timer = setTimeout(() => r('TIMEOUT'), 15000); })]);
      clearTimeout(timer);
      if (out === 'TIMEOUT' && child) child.kill('SIGKILL');
      assert.notStrictEqual(out, 'TIMEOUT', `${pattern}: still searching after ${Date.now() - t0} ms`);
      assert.match(out, /^answered \d+$|^refused RG-RE-REFUSE-COST$/, pattern);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The async twin decides in SLICES of steps, so an abort lands DURING one long line, not after it
// (review I2: it used to yield only between files). Under tjs, where one such line takes seconds.
test('ugrepMatchesAsync under tjs: an abort lands within a bound during one long line', {
  skip: needUgrep.skip || NO_TJS,
}, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-abort-tjs-'));
  try {
    fs.writeFileSync(path.join(base, 'min.js'), 'x'.repeat(200000) + 'needle\n');
    const prog = path.join(base, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const ac = new AbortController();
      let abortedAt = 0;
      const t0 = Date.now();
      setTimeout(() => { abortedAt = Date.now(); ac.abort(); }, 300);
      rgn.ugrepMatchesAsync(['min.js'], '.{0,100}needle', { ugrep: ${JSON.stringify(UGREP)}, cwd: ${JSON.stringify(base)}, signal: ac.signal })
        .then(() => ({ outcome: 'answered' }), (e) => ({ outcome: e.refused || e.message }))
        .then((r) => process.stdout.write('PROBE:' + JSON.stringify({ ...r, abortedAt: abortedAt && abortedAt - t0, done: Date.now() - t0 }) + '\\n'));
    `);
    const res = runLoader(prog, [], { timeout: 120000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    assert.match(got.outcome, /aborted/, JSON.stringify(got));
    assert.ok(got.abortedAt > 0 && got.done - got.abortedAt < 1000, `the abort landed ${got.done - got.abortedAt} ms after it fired: ${JSON.stringify(got)}`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// P1 (review): the matcher decides every proposed LINE and recomputes its ranges, so ugrep reports
// one record per line (`%u`: measured alike on 7.8.2 macOS, 7.8.2 NetBSD and 5.0.0 noble, -Y empty
// matches included). P2 (RG-RE-LITERAL-RANGES): a case-sensitive plain literal over a file with no
// BOM takes ugrep's own ranges, every one, no read and no decide; a stand-in ugrep proves which path
// ran, and the property below proves the two paths agree.
test('ugrep reports one record per line, except for a plain literal, whose ranges it gives', () => {
  assert.deepStrictEqual(rgn.ugrepMatchArgv('x', { perLine: true }), ['-Y', '-H', '--null', '--format=%u%F%b %e%~', '-e', 'x', '--']);
  assert.deepStrictEqual(rgn.ugrepMatchArgv('x'), ['-Y', '-H', '--null', '--format=%F%b %e%~', '-e', 'x', '--']);
});
test('RG-RE-LITERAL-RANGES: a plain literal takes ugrep\'s ranges as they are; anything else is decided', posixStub, () =>
  withStubs({ says: `${STUB_VERSION}; printf 'a.txt\\0000 6\\n'; exit 0` }, async ({ says }, dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'no such word here\n');
    // the stand-in claims 0-6; a literal believes it (nothing was read), a regex decides (nothing)
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(['a.txt'], 'needle', { ugrep: says, cwd: dir })), { 'a.txt': [[0, 6]] });
    assert.deepStrictEqual(asObj(await rgn.ugrepMatchesAsync(['a.txt'], 'needle', { ugrep: says, cwd: dir })), { 'a.txt': [[0, 6]] });
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(['a.txt'], 'needle\\b', { ugrep: says, cwd: dir })), {});
    assert.deepStrictEqual(asObj(rgn.ugrepMatches(['a.txt'], '(?i)needle', { ugrep: says, cwd: dir })), {});
  }));
// RG-RE-LITERAL-RANGES' corpus: the oracle generator's pieces (scripts/gen-rg-regex-oracle.cjs), 200 seeded lines of
// them, then a fixed tail for the literals the pieces cannot make (aa, the doubled e-acute, needleneedle, x+CJK).
// THE RNG (observability Task 4): it drew `seed % n` from `seed * 1103515245`, which in JS rounds past 2^53 into a
// 10,466-state cycle and whose low bits cycle besides; it draws from test/shape-census.cjs's intRng now, and the census
// test below proves every literal is compared against at least one occurrence (a literal the corpus never holds
// compares [] with [] and cannot fail) and every piece is drawn.
const cpt = (...c) => String.fromCodePoint(...c);
const LIT_PIECES = ['a', 'b', 'ab', 'k', 'K', 's', 'S', '_', '1', '9', ' ', '  ', '.', '-', 'x', 'needle', 'foo', 'bar', '\t', '\r',
  cpt(0xe9), cpt(0x65, 0x301), cpt(0x4e2d), cpt(0x4e2d, 0x6587), cpt(0x1f600), cpt(0x212a), cpt(0x17f), cpt(0xdf), cpt(0x3c3), cpt(0x3c2),
  cpt(0x661), cpt(0xa0), cpt(0x200d), [0xff], [0x80], [0xe4, 0xb8], [0xc3], [0xed, 0xa0, 0x80], [0xf0, 0x9f]];
const LITS = ['a', 'b', 'ab', 'aa', 'aba', 'k', 'K', 's', '_', '1', ' ', '  ', '.', '-', 'x', 'needle', 'needleneedle', 'foo', 'bar', '\t', '\r',
  cpt(0xe9), cpt(0xe9, 0xe9), cpt(0x65, 0x301), cpt(0x4e2d), cpt(0x4e2d, 0x6587), cpt(0x1f600), cpt(0x212a), cpt(0x17f), cpt(0xdf), cpt(0x3c3),
  cpt(0x661), cpt(0xa0), cpt(0x200d), `x${cpt(0x4e2d)}`];
const LIT_SEED = 20261003, LIT_LINES = 200, LIT_MAX_PIECES = 9;
function literalLines(rnd = intRng(LIT_SEED)) {
  const lines = [];
  for (let i = 0; i < LIT_LINES; i++) { const l = []; for (let j = rnd(LIT_MAX_PIECES); j > 0; j--) l.push(rnd(LIT_PIECES.length)); lines.push(l); }
  return lines;
}
function literalCorpus() {
  const parts = [];
  for (const l of literalLines()) { for (const k of l) parts.push(Buffer.from(LIT_PIECES[k])); parts.push(Buffer.from('\n')); }
  return Buffer.concat([...parts, Buffer.from('aaaa aaa ababab abab\n'),
    Buffer.from([0xe4]), Buffer.from(`${cpt(0xe9)}${cpt(0xe9)}${cpt(0xe9)} x${cpt(0x4e2d)}${cpt(0x4e2d)}\n`), Buffer.from([0xc3, 0xa9, 0xa9, 0x80]),
    Buffer.from('needleneedle\r\n'), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from(`${cpt(0x1f600)}aa\n`)]);
}
const occurrences = (buf, s) => { const b = Buffer.from(s); let k = 0; for (let i = buf.indexOf(b); i >= 0; i = buf.indexOf(b, i + 1)) k++; return k; };
test('RG-RE-LITERAL-RANGES\' corpus: every literal occurs, every piece is drawn, the RNG is unbiased (census)', (t) => {
  const corpus = literalCorpus();
  // The piece floors: a floor written as a fraction of today's count is a regression tripwire on a deterministic
  // count (the seeds are fixed), not a coverage requirement; the literal floor of 1 is a requirement.
  // Floors measured 2026-11-19: every literal 1 or more (the tail's own literals 1-6, the others 12-93); every piece
  // 12-32 times over the 200 lines (an expected 4 x 200 / 39 = 20.5 each).
  const lits = census('RG-RE-LITERAL-RANGES literals', LITS.map((l) => ({ shape: `occurs: ${JSON.stringify(l)}`, min: 1, has: (b) => occurrences(b, l),
    why: 'a literal the corpus never holds compares [] with [] and cannot fail; one occurrence makes it a comparison' })), [corpus]);
  const pieces = census('RG-RE-LITERAL-RANGES pieces', LIT_PIECES.map((p, k) => ({ shape: `drawn: piece ${k}`, min: 5, has: (l) => l.filter((x) => x === k).length,
    why: 'a quarter of the 20.5 draws each piece expects over 200 lines' })), literalLines());
  const bias = rngBias('RG-RE-LITERAL-RANGES RNG', () => intRng(LIT_SEED), [LIT_MAX_PIECES, LIT_PIECES.length]);
  for (const r of [lits, pieces, bias]) t.diagnostic(r.summary);
  assertCensus(assert, lits, pieces, bias);
});
test('RG-RE-LITERAL-RANGES: ugrep\'s ranges for a plain literal are the matcher\'s, over a hostile corpus', needUgrep, () => {
  const R = require('../libexec/rg-regex.cjs');
  const corpus = literalCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-lit-'));
  try {
    fs.writeFileSync(path.join(dir, 'c.txt'), corpus);
    const lits = LITS;
    let checked = 0;
    for (const lit of lits) {
      const pattern = lit.replace(/[\\.+*?()|[\]{}^$#&~-]/g, '\\$&');
      const t = R.translateRgRegex(pattern, {});
      assert.ok(t.prog && t.prog.lit, `${JSON.stringify(pattern)} is a plain literal`);
      const want = [];
      for (let ls = 0; ls < corpus.length;) { const le = corpus.indexOf(0x0a, ls); want.push(...R.verifyLine(corpus, ls, le, t)); ls = le + 1; }
      const got = rgn.ugrepMatches(['c.txt'], pattern, { ugrep: UGREP, cwd: dir }).get('c.txt') || [];
      assert.deepStrictEqual(got, want, JSON.stringify(pattern));
      checked++;
    }
    assert.ok(checked >= 30);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the async twin, and the same plumbing under tjs -----------------------------------------
test('ugrepMatchesAsync answers what ugrepMatches does, and rejects as it throws', needUgrep, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-'));
  try {
    const dir = makeRgTree(path.join(base, 'root'), 'root');
    const sync = rgn.ugrepMatches(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir });
    const asyncGot = await rgn.ugrepMatchesAsync(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir, argvBudget: 1 });
    assert.deepStrictEqual(asObj(asyncGot), asObj(sync));
    const warned = await rgn.ugrepMatchesAsync(['a.txt', 'no-such-file.txt'], 'needle', { ugrep: UGREP, cwd: dir });
    assert.deepStrictEqual(warned.pathErrors, rgn.ugrepMatches(['a.txt', 'no-such-file.txt'], 'needle', { ugrep: UGREP, cwd: dir }).pathErrors);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('ugrepMatches and ugrepMatchesAsync under tjs: native\'s ranges', {
  skip: needUgrep.skip || NO_TJS,
}, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-tjs-'));
  try {
    const dir = makeRgTree(path.join(base, 'root'), 'root');
    const prog = path.join(base, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const o = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.map(({ start, end }) => [start, end])]));
      const files = ${JSON.stringify(ROOT_FILES)};
      const opts = { ugrep: ${JSON.stringify(UGREP)}, cwd: ${JSON.stringify(dir)} };
      (async () => {
        const sync = o(rgn.ugrepMatches(files, 'needle', opts));
        const asy = o(await rgn.ugrepMatchesAsync(files, 'needle', { ...opts, argvBudget: 1 }));
        process.stdout.write('PROBE:' + JSON.stringify({ sync, asy, caps: rgn.ugrepCapabilities(opts.ugrep).format }) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 60000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    const want = Object.fromEntries(ROOT_FILES.filter((f) => NATIVE_NEEDLE_ROOT[f]).map((f) => [f, NATIVE_NEEDLE_ROOT[f]]));
    assert.deepStrictEqual(got.sync, want);
    assert.deepStrictEqual(got.asy, want);
    assert.strictEqual(got.caps, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---- Task 6: rg's files, count and standard printers, as native prints them ----------------------
// runRg (the synchronous surfaces) and rgSpawn/rgExecFile (the asynchronous ones) answer a search
// THEMSELVES now: the targets walked (a directory is listed by ugrep under today's walk flags until
// the plan's Task 9 walks in JS), every file's matches from ugrepMatches, stdin's from the matcher
// alone, and rg's printers over rg's own text of each file (RG-TEXT-BOM). Every literal below is
// native 2.1.283's embedded rg (ripgrep 14.1.1) on P6_FILES, run in that tree with argv0 rg and
// --no-config (measured 2026-10-03, this Mac; the measuring script is in the task-6 report).
//   RG-FILES-NULL              -l prints `path` then \n, or \0 under --null
//   RG-COUNT-NONZERO           -c prints `[path SEP]N\n` for each file with a selected line, SEP
//                              `:` or \0 under --null; a file with none prints nothing (-c -o prints
//                              the 0 of a file selected only by an unprintable match)
//   RG-COUNT-MATCHES           -c -o counts the matches the printer would print, not lines
//   RG-WITH-FILENAME           the path is printed unless the search is ONE path that is not a
//                              directory (a file, or stdin), or -H / --no-filename says otherwise
//   RG-PATH-SPELLING           a walked file is its target joined as Rust's Path::join joins it
//                              (`.` gives ./a.txt, `one/` one/only.txt, `one//` one//only.txt);
//                              a named file as named; stdin `<stdin>`
//   RG-EXPLICIT-FILE           a NAMED file is searched whatever --glob, --hidden or ignore rules say
//   RG-STANDARD-LINES          `[path SEP][N SEP]line`, SEP `:` on a matching line and `-` on a
//                              context line (\0 after the path under --null); the line as rg's
//                              text holds it, its terminator kept (\r\n too), \n added when it has none
//   RG-CONTEXT                 -A/-B/-C (C for both, A/B over it), context merged across matches,
//                              `--` between groups that do not touch and between files
//   RG-ONLY-MATCHING           -o prints each printable match on its own line; a selected line with
//                              no printable match prints whole
//   RG-MAX-COLUMNS             no-op for -l and -c; the standard printer replaces a line whose bytes
//                              (terminator included) pass N with `[Omitted long matching line]` or
//                              `[Omitted long context line]`, a -o match by its own bytes; 0 = no limit
//   RG-RE-MATCH-AT-UNTERMINATED-END  (the printers' half) the matcher's match at the end of an
//                              unterminated last line selects the line (-l, -c, standard) but is not
//                              printed (-o) or counted as a match (-c -o)
//   RG-STDIN                   target `-` searches what the caller piped in, named `<stdin>`; a named
//                              path to rg, so a NUL in it does not end the search
//   RG-TEXT-BOM                (the printers' half) lines are printed, and measured, from rg's text
//   RG-EXIT                    0 when something was found, 1 when nothing was, 2 when any path
//                              failed (its error on stderr, the rest still searched and printed)
//   RG-ARGV                    -l and -c: the last one given wins; -M/--max-columns/-A/-B/-C take a
//                              number, else rg's own usage error; `--` ends the flags
//   RG-BINARY-QUIT             a WALKED file whose first fill holds a NUL prints nothing (bin.dat, nul.bin
//                              here; the rule's own rows are Task 8's P8 below); a named one, and stdin,
//                              are RG-BINARY-CONVERT's
//   RG-FIRST-MATCH             -l stops at a file's first match, -c and the standard printer without
//                              -o at a line's first (rg-regex.cjs RG-RE-EARLIEST); -o, -c -o: every one
const u16le = (s) => Buffer.from(s, 'utf16le');
const P6_FILES = [
  ['a.txt', 'alpha needle\nbeta\nneedle two needle\n'],
  ['b.txt', 'no match here\n'],
  ['ctx.txt', '1 needle\n2\n3\n4\n5 needle\n6\n7\n8\n9\n10 needle\n11\n'],
  ['long.txt', 'short needle\n' + 'x'.repeat(600) + ' needle ' + 'y'.repeat(10) + '\nafter\n'],
  ['c2.txt', 'needle\nlong context line here\n'],
  ['nonl.txt', 'abc\nxyz'],
  ['crlf.txt', 'one needle\r\ntwo\r\n'],
  ['bom8.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ab needle\nzz\n')])],
  ['bom16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), u16le('ab needle\nzz\n')])],
  ['latin1.txt', Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' needle\n')])],
  ['empty.txt', ''],
  ['bin.dat', Buffer.concat([Buffer.from('text needle before\n'), Buffer.from([0, 1, 2, 0x0a]), Buffer.from('needle after nul\n')])],
  ['one/only.txt', 'one needle\n'],
  ['two/1.txt', 'a needle\nb\n'],
  ['two/2.txt', 'c\nd needle\n'],
  ['u1.txt', 'xyz'],
  ['nul.bin', Buffer.concat([Buffer.from('needle one\n'), Buffer.from([0]), Buffer.from('x\nneedle two\n')])],
  // RG-JSON-ESCAPE: what serde_json escapes (", \\, the C0 controls) and what it leaves raw (DEL, U+2028, é)
  ['esc.txt', Buffer.concat([Buffer.from('q"b\\c'), Buffer.from([0x7f, 0x01, 0x1f, 0x08, 0x0c, 0x0d, 0x09]), Buffer.from(' mark '),
    Buffer.from(String.fromCodePoint(0x2028, 0x20, 0xe9)), Buffer.from('\n')])],
  ['blank.txt', '\n\nx\n'],
  // RG-JSON-BYTES: Rust's str::from_utf8 at its edges, one line each (overlong, surrogate, past U+10FFFF,
  // truncated, a lone continuation; then valid 2-, 3- and 4-byte forms)
  ['utf8.txt', Buffer.concat([[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80], [0xc2, 0x80], [0xef, 0xbf, 0xbf],
    [0xf0, 0x9f, 0x98, 0x80]].map((q) => Buffer.concat([Buffer.from('x'), Buffer.from(q), Buffer.from('y\n')])))],
];
const X600 = 'x'.repeat(600);
// What a row pipes into stdin: the bytes this test wrote for that fixture file.
const P6_INPUT = (name) => (name ? Buffer.from(new Map(P6_FILES).get(name)) : undefined);
// [rule, argv (<ROOT> is the tree), the file piped to stdin, rc, stdout (latin1), stderr when checked]
const P6_NATIVE = [
  ['RG-FILES-NULL', ["-l","needle","a.txt"], null, 0, 'a.txt\n'],
  ['RG-FILES-NULL', ["-l","--null","needle","a.txt"], null, 0, 'a.txt\x00'],
  ['RG-EXIT', ["-l","needle","b.txt"], null, 1, ''],
  ['RG-MAX-COLUMNS', ["-l","--null","--max-columns","5","needle","long.txt"], null, 0, 'long.txt\x00'],
  ['RG-STDIN', ["-l","--null","needle","-"], "a.txt", 0, '<stdin>\x00'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-l","$","nonl.txt"], null, 0, 'nonl.txt\n'],
  ['RG-PATH-SPELLING', ["-l","--null","needle","./one"], null, 0, './one/only.txt\x00'],
  ['RG-PATH-SPELLING', ["-l","--null","needle","one/"], null, 0, 'one/only.txt\x00'],
  ['RG-PATH-SPELLING', ["-l","--null","needle","one//"], null, 0, 'one//only.txt\x00'],
  ['RG-PATH-SPELLING', ["-l","--null","needle","<ROOT>/one"], null, 0, '<ROOT>/one/only.txt\x00'],
  ['RG-PATH-SPELLING', ["-l","--null","needle","./a.txt"], null, 0, './a.txt\x00'],
  ['RG-ARGV', ["-l","-c","needle","a.txt"], null, 0, '2\n'],
  ['RG-ARGV', ["-c","-l","needle","a.txt"], null, 0, 'a.txt\n'],
  ['RG-EXPLICIT-FILE', ["-l","--glob","*.js","needle","a.txt"], null, 0, 'a.txt\n'],
  ['RG-COUNT-NONZERO', ["-c","needle","a.txt"], null, 0, '2\n'],
  ['RG-COUNT-NONZERO', ["-c","-H","--null","needle","a.txt"], null, 0, 'a.txt\x002\n'],
  ['RG-COUNT-NONZERO', ["-c","needle","b.txt"], null, 1, ''],
  ['RG-COUNT-NONZERO', ["-c","-H","--null","needle","b.txt"], null, 1, ''],
  ['RG-COUNT-MATCHES', ["-c","-o","needle","a.txt"], null, 0, '3\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-c","$","nonl.txt"], null, 0, '2\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-c","-o","$","nonl.txt"], null, 0, '1\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-c","-o","q*","nonl.txt"], null, 0, '7\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-c","-o","$","u1.txt"], null, 0, '0\n'],
  // stdin is a NAMED path to rg, never a walked one: a NUL in it does not end the search (review I-1)
  ['RG-STDIN', ["-l","--null","needle","-"], "nul.bin", 0, '<stdin>\x00'],
  ['RG-STDIN', ["-c","needle","-"], "nul.bin", 0, '2\n'],
  ['RG-STDIN', ["-c","-H","--null","needle","-"], "nul.bin", 0, '<stdin>\x002\n'],
  ['RG-EXPLICIT-FILE', ["-l","needle","nul.bin"], null, 0, 'nul.bin\n'],
  ['RG-EXPLICIT-FILE', ["-c","needle","nul.bin"], null, 0, '2\n'],
  // RG-FIRST-MATCH: -l stops at a file's first match, -c and the standard printer without -o at a
  // line's first (an earliest search); -o and -c -o still find every match (review I-4)
  ['RG-FIRST-MATCH', ["-c","n.*e","a.txt"], null, 0, '2\n'],
  ['RG-FIRST-MATCH', ["-c","e.*?e","ctx.txt"], null, 0, '3\n'],
  ['RG-FIRST-MATCH', ["-l","t.*o","a.txt"], null, 0, 'a.txt\n'],
  ['RG-FIRST-MATCH', ["-c","(?:needle|e)+","a.txt"], null, 0, '3\n'],
  ['RG-FIRST-MATCH', ["-n","e+","a.txt"], null, 0, '1:alpha needle\n2:beta\n3:needle two needle\n'],
  ['RG-FIRST-MATCH', ["-c","-o","e+","a.txt"], null, 0, '7\n'],
  ['RG-FIRST-MATCH', ["-n","x*","nonl.txt"], null, 0, '1:abc\n2:xyz\n'],
  ['RG-FIRST-MATCH', ["-c","x*","nonl.txt"], null, 0, '2\n'],
  ['RG-FIRST-MATCH', ["-l","zz|needle","bom8.txt"], null, 0, 'bom8.txt\n'],
  ['RG-FIRST-MATCH', ["-c","a|ab","a.txt"], null, 0, '2\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-c","-o","-H","$","u1.txt"], null, 0, 'u1.txt:0\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-n","-o","$","u1.txt"], null, 0, '1:xyz\n'],
  ['RG-MAX-COLUMNS', ["-c","--max-columns","5","needle","long.txt"], null, 0, '2\n'],
  ['RG-STDIN', ["-c","needle","-"], "a.txt", 0, '2\n'],
  ['RG-STDIN', ["-c","-H","--null","needle","-"], "a.txt", 0, '<stdin>\x002\n'],
  ['RG-TEXT-BOM', ["-c","-H","needle","bom16.txt"], null, 0, 'bom16.txt:1\n'],
  ['RG-COUNT-NONZERO', ["-c","-H","needle","latin1.txt"], null, 0, 'latin1.txt:1\n'],
  ['RG-COUNT-NONZERO', ["-c","-j1","needle","a.txt","b.txt"], null, 0, 'a.txt:2\n'],
  ['RG-WITH-FILENAME', ["-c","--null","needle","a.txt"], null, 0, '2\n'],
  ['RG-COUNT-NONZERO', ["-c","-A","2","needle","a.txt"], null, 0, '2\n'],
  ['RG-STANDARD-LINES', ["needle","a.txt"], null, 0, 'alpha needle\nneedle two needle\n'],
  ['RG-STANDARD-LINES', ["-n","needle","a.txt"], null, 0, '1:alpha needle\n3:needle two needle\n'],
  ['RG-WITH-FILENAME', ["-H","needle","a.txt"], null, 0, 'a.txt:alpha needle\na.txt:needle two needle\n'],
  ['RG-STANDARD-LINES', ["-H","-n","--null","needle","a.txt"], null, 0, 'a.txt\x001:alpha needle\na.txt\x003:needle two needle\n'],
  ['RG-WITH-FILENAME', ["--null","needle","a.txt"], null, 0, 'alpha needle\nneedle two needle\n'],
  ['RG-ONLY-MATCHING', ["-o","needle","a.txt"], null, 0, 'needle\nneedle\nneedle\n'],
  ['RG-ONLY-MATCHING', ["-n","-o","needle","a.txt"], null, 0, '1:needle\n3:needle\n3:needle\n'],
  ['RG-WITH-FILENAME', ["-n","needle","one"], null, 0, 'one/only.txt:1:one needle\n'],
  ['RG-STANDARD-LINES', ["-n","--null","needle","one"], null, 0, 'one/only.txt\x001:one needle\n'],
  ['RG-CONTEXT', ["-n","-C","1","needle","ctx.txt"], null, 0, '1:1 needle\n2-2\n--\n4-4\n5:5 needle\n6-6\n--\n9-9\n10:10 needle\n11-11\n'],
  ['RG-CONTEXT', ["-C","1","needle","ctx.txt"], null, 0, '1 needle\n2\n--\n4\n5 needle\n6\n--\n9\n10 needle\n11\n'],
  ['RG-CONTEXT', ["-n","-B","1","-A","2","needle","ctx.txt"], null, 0, '1:1 needle\n2-2\n3-3\n4-4\n5:5 needle\n6-6\n7-7\n--\n9-9\n10:10 needle\n11-11\n'],
  ['RG-CONTEXT', ["-n","-A","3","needle","ctx.txt"], null, 0, '1:1 needle\n2-2\n3-3\n4-4\n5:5 needle\n6-6\n7-7\n8-8\n--\n10:10 needle\n11-11\n'],
  ['RG-CONTEXT', ["-n","-B","2","needle","ctx.txt"], null, 0, '1:1 needle\n--\n3-3\n4-4\n5:5 needle\n--\n8-8\n9-9\n10:10 needle\n'],
  ['RG-CONTEXT', ["-n","-C","0","needle","ctx.txt"], null, 0, '1:1 needle\n5:5 needle\n10:10 needle\n'],
  ['RG-ONLY-MATCHING', ["-n","-o","-C","1","needle","ctx.txt"], null, 0, '1:needle\n2-2\n--\n4-4\n5:needle\n6-6\n--\n9-9\n10:needle\n11-11\n'],
  ['RG-CONTEXT', ["-H","-n","-C","1","needle","ctx.txt"], null, 0, 'ctx.txt:1:1 needle\nctx.txt-2-2\n--\nctx.txt-4-4\nctx.txt:5:5 needle\nctx.txt-6-6\n--\nctx.txt-9-9\nctx.txt:10:10 needle\nctx.txt-11-11\n'],
  ['RG-CONTEXT', ["-H","-n","-C","1","--null","needle","ctx.txt"], null, 0, 'ctx.txt\x001:1 needle\nctx.txt\x002-2\n--\nctx.txt\x004-4\nctx.txt\x005:5 needle\nctx.txt\x006-6\n--\nctx.txt\x009-9\nctx.txt\x0010:10 needle\nctx.txt\x0011-11\n'],
  ['RG-CONTEXT', ["-n","-C","1","-j1","needle","two/1.txt","two/2.txt"], null, 0, 'two/1.txt:1:a needle\ntwo/1.txt-2-b\n--\ntwo/2.txt-1-c\ntwo/2.txt:2:d needle\n'],
  ['RG-WITH-FILENAME', ["-n","-j1","needle","two/1.txt","b.txt","two/2.txt"], null, 0, 'two/1.txt:1:a needle\ntwo/2.txt:2:d needle\n'],
  ['RG-CONTEXT', ["-n","-C","5","needle","a.txt"], null, 0, '1:alpha needle\n2-beta\n3:needle two needle\n'],
  ['RG-MAX-COLUMNS', ["-n","--max-columns","500","needle","long.txt"], null, 0, '1:short needle\n2:[Omitted long matching line]\n'],
  ['RG-MAX-COLUMNS', ["--max-columns","500","needle","long.txt"], null, 0, 'short needle\n[Omitted long matching line]\n'],
  ['RG-MAX-COLUMNS', ["-n","--max-columns","13","needle","long.txt"], null, 0, '1:short needle\n2:[Omitted long matching line]\n'],
  ['RG-MAX-COLUMNS', ["-n","--max-columns","12","needle","long.txt"], null, 0, '1:[Omitted long matching line]\n2:[Omitted long matching line]\n'],
  ['RG-MAX-COLUMNS', ["-n","-o","--max-columns","5","needle","a.txt"], null, 0, '1:[Omitted long matching line]\n3:[Omitted long matching line]\n3:[Omitted long matching line]\n'],
  ['RG-MAX-COLUMNS', ["-n","-o","--max-columns","6","needle","a.txt"], null, 0, '1:needle\n3:needle\n3:needle\n'],
  ['RG-MAX-COLUMNS', ["-n","-A","1","--max-columns","10","needle","c2.txt"], null, 0, '1:needle\n2-[Omitted long context line]\n'],
  ['RG-MAX-COLUMNS', ["-n","-A","1","--max-columns","0","needle","c2.txt"], null, 0, '1:needle\n2-long context line here\n'],
  ['RG-MAX-COLUMNS', ["-n","-C","1","--max-columns","20","needle","long.txt"], null, 0, '1:short needle\n2:[Omitted long matching line]\n3-after\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-n","$","nonl.txt"], null, 0, '1:abc\n2:xyz\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-n","-o","$","nonl.txt"], null, 0, '1:\n2:xyz\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["-n","-o","q*","nonl.txt"], null, 0, '1:\n1:\n1:\n1:\n2:\n2:\n2:\n'],
  ['RG-STANDARD-LINES', ["-n","-o","z","nonl.txt"], null, 0, '2:z\n'],
  ['RG-STANDARD-LINES', ["-n","-C","1","abc","nonl.txt"], null, 0, '1:abc\n2-xyz\n'],
  ['RG-STANDARD-LINES', ["-n","needle","crlf.txt"], null, 0, '1:one needle\x0d\n'],
  ['RG-MAX-COLUMNS', ["-n","--max-columns","12","needle","crlf.txt"], null, 0, '1:one needle\x0d\n'],
  ['RG-MAX-COLUMNS', ["-n","--max-columns","13","needle","crlf.txt"], null, 0, '1:one needle\x0d\n'],
  ['RG-ONLY-MATCHING', ["-n","-o","needle","crlf.txt"], null, 0, '1:needle\n'],
  ['RG-TEXT-BOM', ["-n","-A","1","needle","bom8.txt"], null, 0, '1:ab needle\n2-zz\n'],
  ['RG-TEXT-BOM', ["-n","needle","bom16.txt"], null, 0, '1:ab needle\n'],
  ['RG-TEXT-BOM', ["-n","--max-columns","9","needle","bom16.txt"], null, 0, '1:[Omitted long matching line]\n'],
  ['RG-TEXT-BOM', ["-n","--max-columns","10","needle","bom16.txt"], null, 0, '1:ab needle\n'],
  ['RG-STANDARD-LINES', ["-n","needle","latin1.txt"], null, 0, '1:caf\xe9 needle\n'],
  ['RG-STDIN', ["-n","needle","-"], "a.txt", 0, '1:alpha needle\n3:needle two needle\n'],
  ['RG-STDIN', ["-H","-n","needle","-"], "a.txt", 0, '<stdin>:1:alpha needle\n<stdin>:3:needle two needle\n'],
  ['RG-STDIN', ["-H","--null","needle","-"], "a.txt", 0, '<stdin>\x00alpha needle\n<stdin>\x00needle two needle\n'],
  ['RG-STANDARD-LINES', ["-n","-i","NEEDLE","a.txt"], null, 0, '1:alpha needle\n3:needle two needle\n'],
  ['RG-ARGV', ["-n","-e","-x","a.txt"], null, 1, ''],
  ['RG-EXIT', ["-l","needle","nope.txt"], null, 2, '', "rg: nope.txt: IO error for operation on nope.txt: No such file or directory (os error 2)\n"],
  ['RG-EXIT', ["-l","-j1","needle","nope.txt","a.txt"], null, 2, 'a.txt\n', "rg: nope.txt: IO error for operation on nope.txt: No such file or directory (os error 2)\n"],
  ['RG-EXIT', ["-n","needle","nope.txt"], null, 2, '', "rg: nope.txt: IO error for operation on nope.txt: No such file or directory (os error 2)\n"],
  ['RG-ARGV', ["-l","--max-columns","abc","needle","a.txt"], null, 2, '', "rg: error parsing flag --max-columns: value is not a valid number: invalid digit found in string\n"],
  ['RG-ARGV', ["-l","--max-columns","","needle","a.txt"], null, 2, '', "rg: error parsing flag --max-columns: value is not a valid number: cannot parse integer from empty string\n"],
  ['RG-ARGV', ["-n","-A","x","needle","a.txt"], null, 2, '', "rg: error parsing flag -A: value is not a valid number: invalid digit found in string\n"],
  ['RG-ARGV', ["-l","-M5","needle","a.txt"], null, 0, 'a.txt\n'],
  ['RG-ARGV', ["-n","--max-columns=5","needle","a.txt"], null, 0, '1:[Omitted long matching line]\n3:[Omitted long matching line]\n'],
  ['RG-ARGV', ["-n","-A1","needle","ctx.txt"], null, 0, '1:1 needle\n2-2\n--\n5:5 needle\n6-6\n--\n10:10 needle\n11-11\n'],
  ['RG-ARGV', ["-n","--after-context=1","needle","ctx.txt"], null, 0, '1:1 needle\n2-2\n--\n5:5 needle\n6-6\n--\n10:10 needle\n11-11\n'],
  ['RG-CONTEXT', ["-n","--context","1","needle","two/1.txt"], null, 0, '1:a needle\n2-b\n'],
  ['RG-EXPLICIT-FILE', ["-l","needle","bin.dat"], null, 0, 'bin.dat\n'],
  ['RG-PATH-SPELLING', ["-c","needle","one/only.txt","one"], null, 0, 'one/only.txt:1\none/only.txt:1\n'],
  ['RG-ARGV', ["-n","--","needle","a.txt"], null, 0, '1:alpha needle\n3:needle two needle\n'],
];
// Directory walks: rg's walk order is not deterministic (rg-probe.cjs normalizeRg, its one named
// normalization), so these compare after it; the standard printer's lines compare as a set.
const P6_NATIVE_WALK = [
  ['RG-BINARY-QUIT', ["-l","--null","needle","."], null, 0, './crlf.txt\x00./two/1.txt\x00./two/2.txt\x00./bom8.txt\x00./long.txt\x00./a.txt\x00./c2.txt\x00./one/only.txt\x00./latin1.txt\x00./ctx.txt\x00./bom16.txt\x00'],
  ['RG-COUNT-NONZERO', ["-c","-H","--null","needle","."], null, 0, './crlf.txt\x001\n./two/1.txt\x001\n./two/2.txt\x001\n./bom8.txt\x001\n./long.txt\x002\n./a.txt\x002\n./c2.txt\x001\n./one/only.txt\x001\n./latin1.txt\x001\n./ctx.txt\x003\n./bom16.txt\x001\n'],
  ['RG-PATH-SPELLING', ["-l","needle","."], null, 0, './crlf.txt\n./two/1.txt\n./two/2.txt\n./bom8.txt\n./long.txt\n./a.txt\n./c2.txt\n./one/only.txt\n./latin1.txt\n./ctx.txt\n./bom16.txt\n'],
  ['RG-PATH-SPELLING', ["-c","needle","<ROOT>"], null, 0, '<ROOT>/crlf.txt:1\n<ROOT>/two/1.txt:1\n<ROOT>/two/2.txt:1\n<ROOT>/bom8.txt:1\n<ROOT>/long.txt:2\n<ROOT>/a.txt:2\n<ROOT>/c2.txt:1\n<ROOT>/one/only.txt:1\n<ROOT>/latin1.txt:1\n<ROOT>/ctx.txt:3\n<ROOT>/bom16.txt:1\n'],
  ['RG-STANDARD-LINES', ["-n","needle","."], null, 0, './crlf.txt:1:one needle\x0d\n./two/1.txt:1:a needle\n./two/2.txt:2:d needle\n./bom8.txt:1:ab needle\n./long.txt:1:short needle\n./long.txt:2:' + X600 + ' needle yyyyyyyyyy\n./a.txt:1:alpha needle\n./a.txt:3:needle two needle\n./c2.txt:1:needle\n./one/only.txt:1:one needle\n./latin1.txt:1:caf\xe9 needle\n./ctx.txt:1:1 needle\n./ctx.txt:5:5 needle\n./ctx.txt:10:10 needle\n./bom16.txt:1:ab needle\n'],
  ['RG-ONLY-MATCHING', ["-l","--null","-o","needle","."], null, 0, './crlf.txt\x00./two/1.txt\x00./two/2.txt\x00./bom8.txt\x00./long.txt\x00./a.txt\x00./c2.txt\x00./one/only.txt\x00./latin1.txt\x00./ctx.txt\x00./bom16.txt\x00'],
  ['RG-COUNT-MATCHES', ["-c","-o","--max-columns","5","needle","."], null, 0, './crlf.txt:1\n./two/1.txt:1\n./two/2.txt:1\n./bom8.txt:1\n./long.txt:2\n./a.txt:3\n./c2.txt:1\n./one/only.txt:1\n./latin1.txt:1\n./ctx.txt:3\n./bom16.txt:1\n'],
];

// ---- rg's JSON Lines printer (grep-native Task 7): native's literals --------------------------------
// [rule, argv, the file piped to stdin, rc, stdout] as native 2.1.283's embedded rg printed them over
// P6_FILES, through rg-probe.cjs normalizeRg (its one named normalization of --json: each end and the
// summary's elapsed times blanked; a walk's records in sorted order). Ours is compared after the same.
// THE RULES (rg-native.cjs header): RG-JSON (begin, match, end per file with a match, and a summary
// always; line numbers on unless -N; the path always, whatever -H/--no-filename/--null say; stats sum
// only the files with a match; --max-columns does nothing), RG-JSON-CONTEXT (context messages with
// submatches [], merged, no separators), RG-JSON-BYTES (a line, match or path that is not UTF-8 is
// base64 `bytes`), RG-JSON-ESCAPE (serde_json's escaping), RG-JSON-ONLY-MATCHING (-o changes nothing),
// RG-ARGV (the last of --json, -l and -c wins), and the printers' half of RG-RE-MATCH-AT-UNTERMINATED-
// END (the line is a match with submatches []), RG-RE-ANCHORS and RG-RE-DOT (ruling G5: an anchor's
// empty submatch where rg puts it, `.` never matching invalid UTF-8), RG-TEXT-BOM (lines, offsets and
// bytes_searched from rg's decoding).
const P7_JSON_NATIVE = [
  ['RG-JSON', ["--json","-n","needle","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":467,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","needle","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":467,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","-N","needle","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":null,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":null,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":473,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":473,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","zzz","a.txt"], null, 1, '{"data":{"elapsed_total":{},"stats":{"bytes_printed":0,"bytes_searched":0,"elapsed":{},"matched_lines":0,"matches":0,"searches":0,"searches_with_match":0}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","-n","needle","b.txt","a.txt","one/only.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"type":"begin","data":{"path":{"text":"one/only.txt"}}}\n{"type":"match","data":{"path":{"text":"one/only.txt"},"lines":{"text":"one needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10}]}}\n{"type":"end","data":{"path":{"text":"one/only.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":11,"bytes_printed":244,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":711,"bytes_searched":47,"elapsed":{},"matched_lines":3,"matches":4,"searches":2,"searches_with_match":2}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","-n","needle","-"], 'a.txt', 0, '{"type":"begin","data":{"path":{"text":"<stdin>"}}}\n{"type":"match","data":{"path":{"text":"<stdin>"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"<stdin>"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"<stdin>"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":473,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":473,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","--no-filename","-H","--null","--max-columns","5","needle","long.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"long.txt"}}}\n{"type":"match","data":{"path":{"text":"long.txt"},"lines":{"text":"short needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"long.txt"},"lines":{"text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx needle yyyyyyyyyy\\n"},"line_number":2,"absolute_offset":13,"submatches":[{"match":{"text":"needle"},"start":601,"end":607}]}}\n{"type":"end","data":{"path":{"text":"long.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":638,"bytes_printed":1033,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1033,"bytes_searched":638,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON', ["--json","-i","NEEDLE","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":467,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-CONTEXT', ["--json","-n","-C","1","needle","ctx.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"ctx.txt"}}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"1 needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"2\\n"},"line_number":2,"absolute_offset":9,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"4\\n"},"line_number":4,"absolute_offset":13,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"5 needle\\n"},"line_number":5,"absolute_offset":15,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"6\\n"},"line_number":6,"absolute_offset":24,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"9\\n"},"line_number":9,"absolute_offset":30,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"10 needle\\n"},"line_number":10,"absolute_offset":32,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"11\\n"},"line_number":11,"absolute_offset":42,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"ctx.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":45,"bytes_printed":1244,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1244,"bytes_searched":45,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-CONTEXT', ["--json","-n","-B","1","-A","2","needle","ctx.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"ctx.txt"}}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"1 needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"2\\n"},"line_number":2,"absolute_offset":9,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"3\\n"},"line_number":3,"absolute_offset":11,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"4\\n"},"line_number":4,"absolute_offset":13,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"5 needle\\n"},"line_number":5,"absolute_offset":15,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"6\\n"},"line_number":6,"absolute_offset":24,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"7\\n"},"line_number":7,"absolute_offset":26,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"9\\n"},"line_number":9,"absolute_offset":30,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"10 needle\\n"},"line_number":10,"absolute_offset":32,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"11\\n"},"line_number":11,"absolute_offset":42,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"ctx.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":45,"bytes_printed":1504,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1504,"bytes_searched":45,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-CONTEXT', ["--json","-A","5","needle","c2.txt","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"context","data":{"path":{"text":"a.txt"},"lines":{"text":"beta\\n"},"line_number":2,"absolute_offset":13,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":598,"matched_lines":2,"matches":3}}}\n{"type":"begin","data":{"path":{"text":"c2.txt"}}}\n{"type":"match","data":{"path":{"text":"c2.txt"},"lines":{"text":"needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"context","data":{"path":{"text":"c2.txt"},"lines":{"text":"long context line here\\n"},"line_number":2,"absolute_offset":7,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"c2.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":30,"bytes_printed":376,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":974,"bytes_searched":66,"elapsed":{},"matched_lines":3,"matches":4,"searches":2,"searches_with_match":2}},"type":"summary"}\n'],
  ['RG-JSON-CONTEXT', ["--json","-C","1","abc","nonl.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"nonl.txt"}}}\n{"type":"match","data":{"path":{"text":"nonl.txt"},"lines":{"text":"abc\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"abc"},"start":0,"end":3}]}}\n{"type":"context","data":{"path":{"text":"nonl.txt"},"lines":{"text":"xyz"},"line_number":2,"absolute_offset":4,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"nonl.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":7,"bytes_printed":355,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":355,"bytes_searched":7,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-CONTEXT', ["--json","-B","1","xyz","nonl.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"nonl.txt"}}}\n{"type":"context","data":{"path":{"text":"nonl.txt"},"lines":{"text":"abc\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"nonl.txt"},"lines":{"text":"xyz"},"line_number":2,"absolute_offset":4,"submatches":[{"match":{"text":"xyz"},"start":0,"end":3}]}}\n{"type":"end","data":{"path":{"text":"nonl.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":7,"bytes_printed":355,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":355,"bytes_searched":7,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-CONTEXT', ["--json","-C","1","short","long.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"long.txt"}}}\n{"type":"match","data":{"path":{"text":"long.txt"},"lines":{"text":"short needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"short"},"start":0,"end":5}]}}\n{"type":"context","data":{"path":{"text":"long.txt"},"lines":{"text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx needle yyyyyyyyyy\\n"},"line_number":2,"absolute_offset":13,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"long.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":638,"bytes_printed":984,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":984,"bytes_searched":638,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-BYTES', ["--json","needle","latin1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"end","data":{"path":{"text":"latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":245,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":245,"bytes_searched":12,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-BYTES', ["--json","-n","caf","latin1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"caf"},"start":0,"end":3}]}}\n{"type":"end","data":{"path":{"text":"latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":241,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":241,"bytes_searched":12,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-BYTES', ["--json","-C","1","needle","latin1.txt","crlf.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"crlf.txt"}}}\n{"type":"match","data":{"path":{"text":"crlf.txt"},"lines":{"text":"one needle\\r\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10}]}}\n{"type":"context","data":{"path":{"text":"crlf.txt"},"lines":{"text":"two\\r\\n"},"line_number":2,"absolute_offset":12,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"crlf.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":17,"bytes_printed":373,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"end","data":{"path":{"text":"latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":245,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":618,"bytes_searched":29,"elapsed":{},"matched_lines":2,"matches":2,"searches":2,"searches_with_match":2}},"type":"summary"}\n'],
  ['RG-JSON-ESCAPE', ["--json","mark","esc.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"esc.txt"}}}\n{"type":"match","data":{"path":{"text":"esc.txt"},"lines":{"text":"q\\"b\\\\c\x7f\\u0001\\u001f\\b\\f\\r\\t mark \xe2\x80\xa8 \xc3\xa9\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"mark"},"start":13,"end":17}]}}\n{"type":"end","data":{"path":{"text":"esc.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":25,"bytes_printed":263,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":263,"bytes_searched":25,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-ESCAPE', ["--json","-C","1","needle","crlf.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"crlf.txt"}}}\n{"type":"match","data":{"path":{"text":"crlf.txt"},"lines":{"text":"one needle\\r\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10}]}}\n{"type":"context","data":{"path":{"text":"crlf.txt"},"lines":{"text":"two\\r\\n"},"line_number":2,"absolute_offset":12,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"crlf.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":17,"bytes_printed":373,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":373,"bytes_searched":17,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-ONLY-MATCHING', ["--json","-n","-o","needle","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":467,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-ONLY-MATCHING', ["--json","-o","-C","1","needle","ctx.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"ctx.txt"}}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"1 needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"2\\n"},"line_number":2,"absolute_offset":9,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"4\\n"},"line_number":4,"absolute_offset":13,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"5 needle\\n"},"line_number":5,"absolute_offset":15,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"6\\n"},"line_number":6,"absolute_offset":24,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"9\\n"},"line_number":9,"absolute_offset":30,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"ctx.txt"},"lines":{"text":"10 needle\\n"},"line_number":10,"absolute_offset":32,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"context","data":{"path":{"text":"ctx.txt"},"lines":{"text":"11\\n"},"line_number":11,"absolute_offset":42,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"ctx.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":45,"bytes_printed":1244,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1244,"bytes_searched":45,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-ARGV', ["-l","--json","needle","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":467,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-ARGV', ["--json","-l","needle","a.txt"], null, 0, 'a.txt\n'],
  ['RG-ARGV', ["-c","--json","needle","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":467,"matched_lines":2,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":467,"bytes_searched":36,"elapsed":{},"matched_lines":2,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-ARGV', ["--json","--count","needle","a.txt"], null, 0, '2\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["--json","-n","$","nonl.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"nonl.txt"}}}\n{"type":"match","data":{"path":{"text":"nonl.txt"},"lines":{"text":"abc\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":3,"end":3}]}}\n{"type":"match","data":{"path":{"text":"nonl.txt"},"lines":{"text":"xyz"},"line_number":2,"absolute_offset":4,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"nonl.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":7,"bytes_printed":350,"matched_lines":2,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":350,"bytes_searched":7,"elapsed":{},"matched_lines":2,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["--json","-n","$","u1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"u1.txt"}}}\n{"type":"match","data":{"path":{"text":"u1.txt"},"lines":{"text":"xyz"},"line_number":1,"absolute_offset":0,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"u1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":3,"bytes_printed":177,"matched_lines":1,"matches":0}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":177,"bytes_searched":3,"elapsed":{},"matched_lines":1,"matches":0,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["--json","-n","e*","a.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"a.txt"}}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":0,"end":0},{"match":{"text":""},"start":1,"end":1},{"match":{"text":""},"start":2,"end":2},{"match":{"text":""},"start":3,"end":3},{"match":{"text":""},"start":4,"end":4},{"match":{"text":""},"start":5,"end":5},{"match":{"text":""},"start":6,"end":6},{"match":{"text":"ee"},"start":7,"end":9},{"match":{"text":""},"start":10,"end":10},{"match":{"text":"e"},"start":11,"end":12}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"beta\\n"},"line_number":2,"absolute_offset":13,"submatches":[{"match":{"text":""},"start":0,"end":0},{"match":{"text":"e"},"start":1,"end":2},{"match":{"text":""},"start":3,"end":3},{"match":{"text":""},"start":4,"end":4}]}}\n{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":""},"start":0,"end":0},{"match":{"text":"ee"},"start":1,"end":3},{"match":{"text":""},"start":4,"end":4},{"match":{"text":"e"},"start":5,"end":6},{"match":{"text":""},"start":7,"end":7},{"match":{"text":""},"start":8,"end":8},{"match":{"text":""},"start":9,"end":9},{"match":{"text":""},"start":10,"end":10},{"match":{"text":""},"start":11,"end":11},{"match":{"text":"ee"},"start":12,"end":14},{"match":{"text":""},"start":15,"end":15},{"match":{"text":"e"},"start":16,"end":17}]}}\n{"type":"end","data":{"path":{"text":"a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":1518,"matched_lines":3,"matches":26}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1518,"bytes_searched":36,"elapsed":{},"matched_lines":3,"matches":26,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-MATCH-AT-UNTERMINATED-END', ["--json","q*","u1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"u1.txt"}}}\n{"type":"match","data":{"path":{"text":"u1.txt"},"lines":{"text":"xyz"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":0,"end":0},{"match":{"text":""},"start":1,"end":1},{"match":{"text":""},"start":2,"end":2}]}}\n{"type":"end","data":{"path":{"text":"u1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":3,"bytes_printed":296,"matched_lines":1,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":296,"bytes_searched":3,"elapsed":{},"matched_lines":1,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-ANCHORS', ["--json","^","latin1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":0,"end":0}]}}\n{"type":"end","data":{"path":{"text":"latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":238,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":238,"bytes_searched":12,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-ANCHORS', ["--json","$","latin1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":11,"end":11}]}}\n{"type":"end","data":{"path":{"text":"latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":240,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":240,"bytes_searched":12,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-ANCHORS', ["--json","^","blank.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"blank.txt"}}}\n{"type":"match","data":{"path":{"text":"blank.txt"},"lines":{"text":"\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":0,"end":0}]}}\n{"type":"match","data":{"path":{"text":"blank.txt"},"lines":{"text":"\\n"},"line_number":2,"absolute_offset":1,"submatches":[{"match":{"text":""},"start":0,"end":0}]}}\n{"type":"match","data":{"path":{"text":"blank.txt"},"lines":{"text":"x\\n"},"line_number":3,"absolute_offset":2,"submatches":[{"match":{"text":""},"start":0,"end":0}]}}\n{"type":"end","data":{"path":{"text":"blank.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":4,"bytes_printed":556,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":556,"bytes_searched":4,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-ANCHORS', ["--json","^$","blank.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"blank.txt"}}}\n{"type":"match","data":{"path":{"text":"blank.txt"},"lines":{"text":"\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":""},"start":0,"end":0}]}}\n{"type":"match","data":{"path":{"text":"blank.txt"},"lines":{"text":"\\n"},"line_number":2,"absolute_offset":1,"submatches":[{"match":{"text":""},"start":0,"end":0}]}}\n{"type":"end","data":{"path":{"text":"blank.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":4,"bytes_printed":388,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":388,"bytes_searched":4,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-DOT', ["--json",".","latin1.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"c"},"start":0,"end":1},{"match":{"text":"a"},"start":1,"end":2},{"match":{"text":"f"},"start":2,"end":3},{"match":{"text":" "},"start":4,"end":5},{"match":{"text":"n"},"start":5,"end":6},{"match":{"text":"e"},"start":6,"end":7},{"match":{"text":"e"},"start":7,"end":8},{"match":{"text":"d"},"start":8,"end":9},{"match":{"text":"l"},"start":9,"end":10},{"match":{"text":"e"},"start":10,"end":11}]}}\n{"type":"end","data":{"path":{"text":"latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":611,"matched_lines":1,"matches":10}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":611,"bytes_searched":12,"elapsed":{},"matched_lines":1,"matches":10,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-RE-DOT', ["--json","f.","latin1.txt"], null, 1, '{"data":{"elapsed_total":{},"stats":{"bytes_printed":0,"bytes_searched":0,"elapsed":{},"matched_lines":0,"matches":0,"searches":0,"searches_with_match":0}},"type":"summary"}\n'],
  ['RG-RE-DOT', ["--json","f..?n","latin1.txt"], null, 1, '{"data":{"elapsed_total":{},"stats":{"bytes_printed":0,"bytes_searched":0,"elapsed":{},"matched_lines":0,"matches":0,"searches":0,"searches_with_match":0}},"type":"summary"}\n'],
  ['RG-TEXT-BOM', ["--json","needle","bom8.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"bom8.txt"}}}\n{"type":"match","data":{"path":{"text":"bom8.txt"},"lines":{"text":"ab needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"end","data":{"path":{"text":"bom8.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":13,"bytes_printed":234,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":234,"bytes_searched":13,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-TEXT-BOM', ["--json","-C","1","z","bom16.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"bom16.txt"}}}\n{"type":"context","data":{"path":{"text":"bom16.txt"},"lines":{"text":"ab needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"bom16.txt"},"lines":{"text":"zz\\n"},"line_number":2,"absolute_offset":10,"submatches":[{"match":{"text":"z"},"start":0,"end":1},{"match":{"text":"z"},"start":1,"end":2}]}}\n{"type":"end","data":{"path":{"text":"bom16.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":13,"bytes_printed":405,"matched_lines":1,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":405,"bytes_searched":13,"elapsed":{},"matched_lines":1,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-TEXT-BOM', ["--json","needle","-"], 'bom16.txt', 0, '{"type":"begin","data":{"path":{"text":"<stdin>"}}}\n{"type":"match","data":{"path":{"text":"<stdin>"},"lines":{"text":"ab needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"end","data":{"path":{"text":"<stdin>"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":13,"bytes_printed":232,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":232,"bytes_searched":13,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-BYTES', ["--json","x","utf8.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"utf8.txt"}}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"bytes":"eMCAeQo="},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"bytes":"eO2ggHkK"},"line_number":2,"absolute_offset":5,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"bytes":"ePSQgIB5Cg=="},"line_number":3,"absolute_offset":11,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"bytes":"eOKCeQo="},"line_number":4,"absolute_offset":18,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"bytes":"eIB5Cg=="},"line_number":5,"absolute_offset":23,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"text":"x\xc2\x80y\\n"},"line_number":6,"absolute_offset":27,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"text":"x\xef\xbf\xbfy\\n"},"line_number":7,"absolute_offset":32,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"text":"x\xf0\x9f\x98\x80y\\n"},"line_number":8,"absolute_offset":38,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}\n{"type":"end","data":{"path":{"text":"utf8.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":45,"bytes_printed":1449,"matched_lines":8,"matches":8}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1449,"bytes_searched":45,"elapsed":{},"matched_lines":8,"matches":8,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-JSON-BYTES', ["--json","-e",".y","utf8.txt"], null, 0, '{"type":"begin","data":{"path":{"text":"utf8.txt"}}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"text":"x\xc2\x80y\\n"},"line_number":6,"absolute_offset":27,"submatches":[{"match":{"text":"\xc2\x80y"},"start":1,"end":4}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"text":"x\xef\xbf\xbfy\\n"},"line_number":7,"absolute_offset":32,"submatches":[{"match":{"text":"\xef\xbf\xbfy"},"start":1,"end":5}]}}\n{"type":"match","data":{"path":{"text":"utf8.txt"},"lines":{"text":"x\xf0\x9f\x98\x80y\\n"},"line_number":8,"absolute_offset":38,"submatches":[{"match":{"text":"\xf0\x9f\x98\x80y"},"start":1,"end":6}]}}\n{"type":"end","data":{"path":{"text":"utf8.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":45,"bytes_printed":581,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":581,"bytes_searched":45,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
];
const P7_JSON_WALK = [
  ['RG-JSON', ["--json","-n","needle","."], null, 0, '{"type":"begin","data":{"path":{"text":"./a.txt"}}}\n{"type":"match","data":{"path":{"text":"./a.txt"},"lines":{"text":"alpha needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"./a.txt"},"lines":{"text":"needle two needle\\n"},"line_number":3,"absolute_offset":18,"submatches":[{"match":{"text":"needle"},"start":0,"end":6},{"match":{"text":"needle"},"start":11,"end":17}]}}\n{"type":"end","data":{"path":{"text":"./a.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":36,"bytes_printed":473,"matched_lines":2,"matches":3}}}\n{"type":"begin","data":{"path":{"text":"./bom16.txt"}}}\n{"type":"match","data":{"path":{"text":"./bom16.txt"},"lines":{"text":"ab needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"end","data":{"path":{"text":"./bom16.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":13,"bytes_printed":240,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./bom8.txt"}}}\n{"type":"match","data":{"path":{"text":"./bom8.txt"},"lines":{"text":"ab needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"end","data":{"path":{"text":"./bom8.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":13,"bytes_printed":238,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./c2.txt"}}}\n{"type":"match","data":{"path":{"text":"./c2.txt"},"lines":{"text":"needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"./c2.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":30,"bytes_printed":231,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./crlf.txt"}}}\n{"type":"match","data":{"path":{"text":"./crlf.txt"},"lines":{"text":"one needle\\r\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10}]}}\n{"type":"end","data":{"path":{"text":"./crlf.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":17,"bytes_printed":242,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./ctx.txt"}}}\n{"type":"match","data":{"path":{"text":"./ctx.txt"},"lines":{"text":"1 needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"match","data":{"path":{"text":"./ctx.txt"},"lines":{"text":"5 needle\\n"},"line_number":5,"absolute_offset":15,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"match","data":{"path":{"text":"./ctx.txt"},"lines":{"text":"10 needle\\n"},"line_number":10,"absolute_offset":32,"submatches":[{"match":{"text":"needle"},"start":3,"end":9}]}}\n{"type":"end","data":{"path":{"text":"./ctx.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":45,"bytes_printed":601,"matched_lines":3,"matches":3}}}\n{"type":"begin","data":{"path":{"text":"./latin1.txt"}}}\n{"type":"match","data":{"path":{"text":"./latin1.txt"},"lines":{"bytes":"Y2Fm6SBuZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"end","data":{"path":{"text":"./latin1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":12,"bytes_printed":249,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./long.txt"}}}\n{"type":"match","data":{"path":{"text":"./long.txt"},"lines":{"text":"short needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"./long.txt"},"lines":{"text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx needle yyyyyyyyyy\\n"},"line_number":2,"absolute_offset":13,"submatches":[{"match":{"text":"needle"},"start":601,"end":607}]}}\n{"type":"end","data":{"path":{"text":"./long.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":638,"bytes_printed":1039,"matched_lines":2,"matches":2}}}\n{"type":"begin","data":{"path":{"text":"./one/only.txt"}}}\n{"type":"match","data":{"path":{"text":"./one/only.txt"},"lines":{"text":"one needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10}]}}\n{"type":"end","data":{"path":{"text":"./one/only.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":11,"bytes_printed":248,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./two/1.txt"}}}\n{"type":"match","data":{"path":{"text":"./two/1.txt"},"lines":{"text":"a needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"end","data":{"path":{"text":"./two/1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":11,"bytes_printed":239,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"./two/2.txt"}}}\n{"type":"match","data":{"path":{"text":"./two/2.txt"},"lines":{"text":"d needle\\n"},"line_number":2,"absolute_offset":2,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"end","data":{"path":{"text":"./two/2.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":11,"bytes_printed":239,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":4039,"bytes_searched":837,"elapsed":{},"matched_lines":15,"matches":16,"searches":11,"searches_with_match":11}},"type":"summary"}\n'],
  ['RG-JSON-ONLY-MATCHING', ["--hidden","--json","-n","-o","-B","1","-A","2","needle","two"], null, 0, '{"type":"begin","data":{"path":{"text":"two/1.txt"}}}\n{"type":"match","data":{"path":{"text":"two/1.txt"},"lines":{"text":"a needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"context","data":{"path":{"text":"two/1.txt"},"lines":{"text":"b\\n"},"line_number":2,"absolute_offset":9,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"two/1.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":11,"bytes_printed":366,"matched_lines":1,"matches":1}}}\n{"type":"begin","data":{"path":{"text":"two/2.txt"}}}\n{"type":"context","data":{"path":{"text":"two/2.txt"},"lines":{"text":"c\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"two/2.txt"},"lines":{"text":"d needle\\n"},"line_number":2,"absolute_offset":2,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n{"type":"end","data":{"path":{"text":"two/2.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":11,"bytes_printed":366,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":732,"bytes_searched":22,"elapsed":{},"matched_lines":2,"matches":2,"searches":2,"searches_with_match":2}},"type":"summary"}\n'],
];
P6_NATIVE.push(...P7_JSON_NATIVE);
P6_NATIVE_WALK.push(...P7_JSON_WALK);

async function withP6(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-p6-')));
  try {
    for (const [rel, data] of P6_FILES) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
    return await fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
// ours, synchronously; `alone`: no ugrep at all, every file decided by the matcher (matchFiles)
function p6Sync(root, [, argv, input], { alone = false } = {}) {
  const r = rgn.runRg(argv.map((a) => a.replace('<ROOT>', root)), {
    cwd: root, input: P6_INPUT(input), spawnSync: cp.spawnSync,
    ugrep: () => (alone ? null : UGREP), matchFiles: alone ? rgn.matchFilesAlone : undefined,
  });
  return { status: r.status, stdout: Buffer.from(r.stdout).toString('latin1'), stderr: Buffer.from(r.stderr).toString('latin1') };
}
const sortLines = (s) => s.split('\n').sort().join('\n');
function p6Check(root, row, got, walk) {
  const [rule, argv, , status, out, err] = row;
  const want = out.split('<ROOT>').join(root);
  const what = `${rule}: rg ${argv.join(' ')} => ${JSON.stringify(got)}`;
  assert.strictEqual(got.status, status, what);
  if (argv.includes('--json')) assert.strictEqual(normalizeRg(Buffer.from(got.stdout, 'latin1'), argv), want, what);
  else if (!walk) assert.strictEqual(got.stdout, want, what);
  else if (argv.includes('-l') || argv.includes('-c')) assert.strictEqual(normalizeRg(Buffer.from(got.stdout, 'latin1'), argv), normalizeRg(Buffer.from(want, 'latin1'), argv), what);
  else assert.strictEqual(sortLines(got.stdout), sortLines(want), what);
  if (err !== undefined) assert.strictEqual(got.stderr.split(root).join('<ROOT>'), err, what);
  assert.strictEqual(rgn.parseRgRefusal(got.stderr), null, `${what}: native answers this, so ours must not refuse it`);
}
const NAMES_DIR = (argv) => argv.some((a) => /^(?:\.|one|two|\.\/one|one\/|one\/\/|<ROOT>|<ROOT>\/one)$/.test(a));
const P6_RULES = [...new Set([...P6_NATIVE, ...P6_NATIVE_WALK].map((r) => r[0]))];
for (const rule of P6_RULES) {
  test(`${rule}: runRg prints what native prints (native, over ugrep)`, needUgrep, () => withP6((root) => {
    for (const row of P6_NATIVE.filter((r) => r[0] === rule)) p6Check(root, row, p6Sync(root, row), false);
    for (const row of P6_NATIVE_WALK.filter((r) => r[0] === rule)) p6Check(root, row, p6Sync(root, row), true);
  }));
}
// The same rows with no ugrep at all (so they run on every host): each named file and stdin decided
// by the matcher alone. A directory needs ugrep's listing (until Task 9), so those rows are not here.
test('the printers, with the matcher alone deciding every file: native\'s rows that name no directory', () => withP6((root) => {
  let n = 0;
  for (const row of P6_NATIVE.filter((r) => !NAMES_DIR(r[1]))) { p6Check(root, row, p6Sync(root, row, { alone: true }), false); n++; }
  assert.ok(n >= 80, `${n} rows`);
}));

// The asynchronous twin (execFile, spawn, Bun.spawn) prints the same bytes and exits the same way.
function p6Async(root, [, argv, input]) {
  return new Promise((resolve) => {
    const child = rgn.rgExecFile(argv.map((a) => a.replace('<ROOT>', root)), { cwd: root, encoding: 'buffer' }, (err, so, se) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: so.toString('latin1'), stderr: se.toString('latin1') });
    }, 'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP });
    if (input) child.stdin.end(P6_INPUT(input)); else if (child.stdin) child.stdin.end();
  });
}
test('the async twin prints every row the sync one does (rgExecFile, native)', needUgrep, () => withP6(async (root) => {
  for (const row of P6_NATIVE) p6Check(root, row, await p6Async(root, row), false);
  for (const row of P6_NATIVE_WALK) p6Check(root, row, await p6Async(root, row), true);
}));

// Under the engine quaude ships: both twins, every row.
test('the printers under tjs: both twins, every row (native)', { skip: needUgrep.skip || NO_TJS }, () => withP6((root) => {
  const prog = path.join(root, '..', path.basename(root) + '-probe.cjs');
  const rows = [...P6_NATIVE.map((r) => [r, false]), ...P6_NATIVE_WALK.map((r) => [r, true])];
  fs.writeFileSync(prog, `
    const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
    const cp = require('child_process'), fs = require('fs'), path = require('path');
    const root = ${JSON.stringify(root)}, UGREP = ${JSON.stringify(UGREP)};
    const rows = ${JSON.stringify(rows.map(([r]) => [r[1], r[2] ? P6_INPUT(r[2]).toString('base64') : null]))};
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    const l1 = (b) => Buffer.from(b).toString('latin1');
    (async () => {
      const out = [];
      for (const [argv0, input] of rows) {
        const argv = argv0.map((a) => a.replace('<ROOT>', root));
        const inp = input ? Buffer.from(input, 'base64') : undefined;
        const s = rgn.runRg(argv, { ...ctx, cwd: root, input: inp });
        const a = await new Promise((res) => {
          const c = rgn.rgExecFile(argv, { cwd: root, encoding: 'buffer' }, (err, so, se) => res({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx);
          if (inp) c.stdin.end(inp); else if (c.stdin) c.stdin.end();
        });
        out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
      }
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `);
  try {
    const res = runLoader(prog, [], { timeout: 120000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    assert.strictEqual(got.length, rows.length);
    rows.forEach(([row, walk], i) => { p6Check(root, row, got[i].sync, walk); p6Check(root, row, got[i].async, walk); });
  } finally { fs.rmSync(prog, { force: true }); }
}));

// RG-EXIT, and a ugrep that exits 2 for a LEGITIMATE reason: a path rg cannot read is reported on
// stderr as rg reports it, the rest is still searched and printed, and the search exits 2. It is
// never quaude's refusal (Task 4 review minor, deferred to Task 6). Native's literals, a tree with
// ok.txt, sub/x.txt and an unreadable locked.txt (and, last, an unreadable sub/).
test('RG-EXIT: an unreadable path is rg\'s error on stderr, the rest answered, exit 2; never a refusal (native)', {
  skip: needUgrep.skip || (process.platform === 'win32' ? 'chmod 000 does not deny reads on Windows' : (process.getuid && process.getuid() === 0) ? 'root reads a chmod 000 file' : false),
}, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-exit-')));
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    for (const f of ['ok.txt', 'locked.txt', 'sub/x.txt']) fs.writeFileSync(path.join(root, f), 'needle\n');
    fs.chmodSync(path.join(root, 'locked.txt'), 0);
    const run = (argv) => { const r = p6Sync(root, [null, argv, null]); return r; };
    const check = (argv, status, out, err, walk) => p6Check(root, ['RG-EXIT', argv, null, status, out, err], run(argv), walk);
    check(['-l', '--null', 'needle', '.'], 2, './sub/x.txt\x00./ok.txt\x00', 'rg: ./locked.txt: Permission denied (os error 13)\n', true);
    check(['-c', 'needle', 'locked.txt'], 2, '', 'rg: locked.txt: Permission denied (os error 13)\n', false);
    check(['-l', 'zzzq', '.'], 2, '', 'rg: ./locked.txt: Permission denied (os error 13)\n', false);
    check(['-l', 'needle', 'locked.txt', 'ok.txt'], 2, 'ok.txt\n', 'rg: locked.txt: Permission denied (os error 13)\n', false);
    // --json: the error on stderr, the rest's messages and the summary on stdout (RG-JSON)
    check(['--json', 'needle', 'locked.txt', 'ok.txt'], 2, '{"type":"begin","data":{"path":{"text":"ok.txt"}}}\n'
      + '{"type":"match","data":{"path":{"text":"ok.txt"},"lines":{"text":"needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n'
      + '{"type":"end","data":{"path":{"text":"ok.txt"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":7,"bytes_printed":227,"matched_lines":1,"matches":1}}}\n'
      + '{"data":{"elapsed_total":{},"stats":{"bytes_printed":227,"bytes_searched":7,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n',
    'rg: locked.txt: Permission denied (os error 13)\n', false);
    fs.chmodSync(path.join(root, 'sub'), 0);
    const r = run(['-c', '-H', '--null', 'needle', '.']);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.stdout, './ok.txt\x001\n');
    assert.deepStrictEqual(r.stderr.split('\n').filter(Boolean).sort(), ['rg: ./locked.txt: Permission denied (os error 13)', 'rg: ./sub: Permission denied (os error 13)']);
    fs.chmodSync(path.join(root, 'sub'), 0o755);
  } finally { try { fs.chmodSync(path.join(root, 'sub'), 0o755); } catch { /* gone */ } fs.rmSync(root, { recursive: true, force: true }); }
});

// What the emulation does not answer is refused by name (never answered differently), and nothing reaches
// the old rg -> ugrep translation (there is none since Task 10). --json is the
// printers' own since Task 7, --type, --type-not, --type-list and --version quaude's rg's since Task 9, -U
// and --files since Task 10 (test/rg-multiline.test.cjs); --type-add and --type-clear are refused by name.
test('a search flag the printers do not answer is refused by name; -U, --files, --json, --type and --version are answered', () => {
  const nope = rgn.runRg(['--frobnicate', 'needle', '.'], { spawnSync: cp.spawnSync, ugrep: () => UGREP });
  assert.strictEqual(rgn.parseRgRefusal(nope.stderr).flag, '--frobnicate');
  for (const flag of ['--type-add', '--type-clear']) {
    assert.strictEqual(rgn.parseRgRefusal(rgn.runRg([flag, 'x:*.x', 'needle', '.'], { spawnSync: cp.spawnSync }).stderr).flag, flag);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-flags-')));
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'needle\n');
    for (const argv of [['--json', '--type', 'ts', 'needle', '.'], ['-t', 'ts', '--json', 'needle', '.'], ['--version'], ['-V'], ['--type-list'],
      ['-U', '--multiline-dotall', '-l', 'needle', '.'], ['--files', '.'], ['--files', '--null', '--sort=modified', '.']]) {
      const a = rgn.runRg(argv, { spawnSync: cp.spawnSync, ugrep: () => UGREP, matchFiles: UGREP ? undefined : rgn.matchFilesAlone, cwd: dir });
      assert.strictEqual(a.status, 0, `${argv.join(' ')}: ${a.status} ${a.stderr}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const json = rgn.runRg(['--json', 'needle', '-'], { spawnSync: cp.spawnSync, ugrep: () => UGREP, input: 'a needle\n' });
  assert.strictEqual(json.status, 0);
  assert.match(String(json.stdout), /^\{"type":"begin","data":\{"path":\{"text":"<stdin>"\}\}\}\n/);
});

// THE SYNCHRONOUS TWIN IS BOUNDED (spawnSync, execFileSync: node's own cannot be interrupted, and
// neither can this). The caller's timeout ends it, wherever it is: in ugrep's match pass (every ugrep run
// gets the time left), or deciding a long line (every slice of steps checks it), reported as node
// reports a spawnSync timeout. With no timeout, RG-RE-REFUSE-COST's per-line budget still holds.
test('runRg ends at the caller\'s timeout: in ugrep\'s match pass, and while deciding lines', { skip: process.platform === 'win32' ? 'needs a shebang stand-in' : false }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-timeout-')));
  try {
    const fake = require('./rg-fake-ugrep.cjs').writeFakeUgrep(dir);
    fs.mkdirSync(path.join(dir, 'tree'));
    fs.writeFileSync(path.join(dir, 'tree', 'a.txt'), 'x needle\n');
    const base = { cwd: dir, spawnSync: cp.spawnSync, ugrep: () => fake, killSignal: 'SIGKILL' };
    let t0 = Date.now();
    const walk = rgn.runRg(['needle', 'tree'], { ...base, timeout: 300, env: { ...process.env, FAKE_UGREP_SLOW_MS: '5000' } });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    assert.deepStrictEqual([walk.status, walk.signal, walk.errorCode], [null, 'SIGKILL', 'ETIMEDOUT']);
    t0 = Date.now();
    // an ordinary pattern over more stdin than the time allows (-c -o decides every match: it
    // answers in about a second with no timeout)
    const input = ('abc def '.repeat(12) + '\n').repeat(100000);
    const lines = rgn.runRg(['-c', '-o', '\\w+', '-'], { ...base, timeout: 100, input });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    assert.deepStrictEqual([lines.status, lines.errorCode], [null, 'ETIMEDOUT']);
    assert.strictEqual(rgn.runRg(['-c', '-o', '\\w+', '-'], { ...base, input }).stdout.toString(), '2400000\n');
    // and with time enough, the same search answers
    assert.strictEqual(rgn.runRg(['needle', 'tree'], { ...base, timeout: 60000 }).stdout.toString(), 'tree/a.txt:x needle\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// RG-FIRST-MATCH, timed (review I-4): -l (the Grep tool's default mode) and -c answer WHETHER a line
// matches, as rg does, instead of deciding every match on it. On one 5 MB minified line with an
// `import` and a `from` every few dozen bytes, `import.*from`'s first leftmost-first match is the whole
// line (its `.*` is greedy), so deciding every match took 5.3 s under tjs (this Mac, 2026-10-04; the
// pinned carve's own one-line 59 MB extracted bundle passed Grep's 20 s timeout); the earliest search takes 70 ms.
test('RG-FIRST-MATCH: -l and -c over a 5 MB line answer in well under a second under tjs (both twins)', {
  skip: needUgrep.skip || NO_TJS,
}, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-first-')));
  try {
    let s = 'import a from b; ';
    for (let i = 0; s.length < 5e6; i++) s += `${i % 7 === 0 ? 'import ' : ''}x${i % 97} = y${i % 13} from z; `;
    fs.writeFileSync(path.join(dir, 'big.js'), s + '\n');
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      const cwd = ${JSON.stringify(dir)}, out = [];
      (async () => {
        for (const argv of [['-l', 'import.*from', 'big.js'], ['-c', 'import.*from', 'big.js']]) {
          let t0 = Date.now();
          const s = rgn.runRg(argv, { ...ctx, cwd });
          out.push({ argv, twin: 'sync', ms: Date.now() - t0, status: s.status, stdout: String(s.stdout) });
          t0 = Date.now();
          const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, timeout: 20000 }, (e, so) => res({ status: e ? (e.code || e.signal) : 0, stdout: String(so) }), 'rg', ctx));
          out.push({ argv, twin: 'async', ms: Date.now() - t0, ...a });
        }
        process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 120000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    for (const r of JSON.parse(line.slice('PROBE:'.length))) {
      // native 2.1.283: `rg -l import.*from big.js` -> big.js, `rg -c` -> 1
      assert.deepStrictEqual([r.status, r.stdout], [0, r.argv[0] === '-l' ? 'big.js\n' : '1\n'], JSON.stringify(r));
      assert.ok(r.ms < 2500, `${r.twin} rg ${r.argv.join(' ')}: ${r.ms} ms (deciding every match took 5.3 s)`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// THE SYNC TWIN'S BOUND reaches its first ugrep run too (Task 6 review M-2): asking a ugrep its
// version is one more spawn, and a ugrep that hangs there ends at the caller's timeout like any.
test('runRg ends at the caller\'s timeout while asking ugrep its version', { skip: process.platform === 'win32' ? 'needs a shell stand-in' : false }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-capstime-')));
  try {
    const slow = path.join(dir, 'slow-version-ugrep');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 5\necho "ugrep 7.8.2"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'needle\n');
    const t0 = Date.now();
    const r = rgn.runRg(['needle', 'a.txt'], { cwd: dir, spawnSync: cp.spawnSync, ugrep: () => slow, timeout: 300 });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    assert.deepStrictEqual([r.status, r.errorCode], [null, 'ETIMEDOUT']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A FIFO (Task 6 review M-2). Measured against native 2.1.283: a WALKED one is skipped (`rg -l needle
// w` over w/a.txt and w/pipe lists w/a.txt, rc 0); a NAMED one rg opens and reads until a writer
// closes it (with none, it waits: killed at 5 s). quaude's rg cannot read one without holding the
// caller (an open blocks, which neither twin's bounds can end), so a named path that is not a regular
// file or a directory refuses by name (RG-REFUSE-SPECIAL-FILE), at once, on both twins.
test('RG-REFUSE-SPECIAL-FILE: a named FIFO refuses at once; a walked one is skipped as native skips it', {
  skip: needUgrep.skip || (process.platform === 'win32' ? 'no mkfifo' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-fifo-')));
  try {
    fs.mkdirSync(path.join(dir, 'w'));
    fs.writeFileSync(path.join(dir, 'w', 'a.txt'), 'needle\n');
    const mk = cp.spawnSync('mkfifo', [path.join(dir, 'w', 'pipe')]);
    assert.strictEqual(mk.status, 0, String(mk.stderr));
    const ctx = { cwd: dir, spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    const walked = rgn.runRg(['-l', 'needle', 'w'], ctx);
    assert.deepStrictEqual([walked.status, String(walked.stdout)], [0, 'w/a.txt\n']);
    let t0 = Date.now();
    const named = rgn.runRg(['-l', 'needle', 'w/pipe'], ctx);
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(named.status, 2);
    assert.match(rgn.parseRgRefusal(named.stderr).reason, /RG-REFUSE-SPECIAL-FILE/);
    t0 = Date.now();
    const a = await new Promise((res) => rgn.rgExecFile(['-l', 'needle', 'w/pipe'], { cwd: dir }, (e, so, se) => res({ code: e && e.code, se }), 'rg', ctx));
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(a.code, 2);
    assert.match(rgn.parseRgRefusal(a.se).reason, /RG-REFUSE-SPECIAL-FILE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// RG-SPECIAL-FILE (Task 6 re-review N1): a named special path that cannot block is answered as
// native answers it, and never takes the rest of the search down with it. Measured against native
// 2.1.283 (darwin-arm64): `rg -l needle /dev/null` rc 1, nothing; `rg -c -H --null needle /dev/null
// ok.txt` -> `ok.txt\x001\n` rc 0; a unix socket named beside ok.txt -> `rg: sock: Operation not
// supported on socket (os error 102)` on stderr, `ok.txt` answered, rc 2 (the open's error, as for an
// unreadable file; its text is libuv's, BACKLOG). Only a path that can block or never end refuses
// (RG-REFUSE-SPECIAL-FILE): a FIFO, and a device that has bytes or would wait (native reads /dev/zero
// until it is killed: measured, still running at 3 s).
test('RG-SPECIAL-FILE: /dev/null is an empty file, a socket is rg\'s per-path error; only a blocking or endless one refuses (native)', {
  skip: needUgrep.skip || (process.platform === 'win32' ? 'no /dev/null or unix sockets' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-special-')));
  const server = require('node:net').createServer();
  try {
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'needle\n');
    await new Promise((res, rej) => { server.once('error', rej); server.listen(path.join(dir, 'sock'), res); });
    const ctx = { cwd: dir, spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    const viaAsync = (argv) => new Promise((res) => rgn.rgExecFile(argv, { cwd: dir, encoding: 'buffer' },
      (e, so, se) => res({ status: e ? e.code : 0, stdout: so.toString('latin1'), stderr: se.toString('latin1') }), 'rg', ctx));
    const viaSync = (argv) => { const r = rgn.runRg(argv, ctx); return { status: r.status, stdout: Buffer.from(r.stdout).toString('latin1'), stderr: Buffer.from(r.stderr).toString('latin1') }; };
    const sockErr = /^rg: sock: .+ \(os error (\d+)\)\n$/;
    for (const run of [viaSync, viaAsync]) {
      assert.deepStrictEqual(await run(['-l', 'needle', '/dev/null']), { status: 1, stdout: '', stderr: '' });
      // --json: the summary alone, as for any search that found nothing (native, measured)
      const j = await run(['--json', 'needle', '/dev/null']);
      assert.deepStrictEqual([j.status, normalizeRg(Buffer.from(j.stdout, 'latin1'), ['--json'])], [1, '{"data":{"elapsed_total":{},"stats":'
        + '{"bytes_printed":0,"bytes_searched":0,"elapsed":{},"matched_lines":0,"matches":0,"searches":0,"searches_with_match":0}},"type":"summary"}\n']);
      assert.deepStrictEqual(await run(['-c', '-H', '--null', 'needle', '/dev/null', 'ok.txt']), { status: 0, stdout: 'ok.txt\x001\n', stderr: '' });
      const s = await run(['-l', 'needle', 'sock', 'ok.txt']);
      assert.deepStrictEqual([s.status, s.stdout], [2, 'ok.txt\n'], JSON.stringify(s));
      assert.match(s.stderr, sockErr);
      if (process.platform === 'darwin') assert.strictEqual(sockErr.exec(s.stderr)[1], '102');
      assert.strictEqual(rgn.parseRgRefusal(s.stderr), null);
      const z = await run(['-l', 'needle', '/dev/zero', 'ok.txt']);
      assert.strictEqual(z.status, 2);
      assert.match(rgn.parseRgRefusal(z.stderr).reason, /RG-REFUSE-SPECIAL-FILE/);
    }
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
// The same under tjs, where node-shim's Stats answers isFIFO() false for every path: the type is
// read from the mode bits, so a FIFO still refuses at once and /dev/null still answers.
test('RG-SPECIAL-FILE and RG-REFUSE-SPECIAL-FILE under tjs: both twins (native)', {
  skip: needUgrep.skip || (process.platform === 'win32' ? 'no /dev/null, mkfifo or unix sockets' : NO_TJS),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-special-tjs-')));
  const server = require('node:net').createServer();
  try {
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'needle\n');
    assert.strictEqual(cp.spawnSync('mkfifo', [path.join(dir, 'pipe')]).status, 0);
    await new Promise((res, rej) => { server.once('error', rej); server.listen(path.join(dir, 'sock'), res); });
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      const cwd = ${JSON.stringify(dir)};
      const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      const l1 = (b) => Buffer.from(b).toString('latin1');
      (async () => {
        const out = [];
        for (const argv of [['-l', 'needle', '/dev/null'], ['-c', '-H', '--null', 'needle', '/dev/null', 'ok.txt'], ['-l', 'needle', 'sock', 'ok.txt'], ['-l', 'needle', 'pipe', 'ok.txt']]) {
          const s = rgn.runRg(argv, { ...ctx, cwd });
          const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, encoding: 'buffer' }, (e, so, se) => res({ status: e ? e.code : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx));
          out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
        }
        process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 60000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    for (const twin of ['sync', 'async']) {
      const got = JSON.parse(line.slice('PROBE:'.length)).map((r) => r[twin]);
      assert.deepStrictEqual(got[0], { status: 1, stdout: '', stderr: '' }, twin);
      assert.deepStrictEqual(got[1], { status: 0, stdout: 'ok.txt\x001\n', stderr: '' }, twin);
      assert.deepStrictEqual([got[2].status, got[2].stdout], [2, 'ok.txt\n'], twin);
      assert.match(got[2].stderr, /^rg: sock: .+ \(os error \d+\)\n$/, twin);
      // RG-ERROR-TEXT: under tjs the libc's own text, as native prints it (native 2.1.283 on darwin, measured)
      if (process.platform === 'darwin') assert.strictEqual(got[2].stderr, 'rg: sock: Operation not supported on socket (os error 102)\n', twin);
      assert.strictEqual(got[3].status, 2, twin);
      assert.match(rgn.parseRgRefusal(got[3].stderr).reason, /RG-REFUSE-SPECIAL-FILE/, twin);
    }
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// RG-JSON, timed: --json reports EVERY match on a selected line, and the Grep tool's content mode is
// --json, so a minified file (one 5 MB line, 275,822 matches of `from`) must print in linear time.
// Native 2.1.283: ~100 ms, 20,324,168 bytes, its summary below (elapsed blanked, rg-probe.cjs's
// normalization). Selecting each match's line by scanning back from it was quadratic (191 s under
// node); building every piece as its own Buffer took 25 s under tjs. Linear, under tjs on this Mac
// (2026-10-04): ~2.4 s a twin alone, 11 s in a loaded full suite, so linearity is judged by COUNT
// (rgn.searchStats.scannedBack), not wall time; the next test does the same fast, on node.
test('RG-JSON: every match on a 5 MB line prints in linear time under tjs (both twins, native\'s summary)', {
  skip: needUgrep.skip || NO_TJS,
}, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-jsonbig-')));
  try {
    let s = 'import a from b; ';
    for (let i = 0; s.length < 5e6; i++) s += `${i % 7 === 0 ? 'import ' : ''}x${i % 97} = y${i % 13} from z; `;
    fs.writeFileSync(path.join(dir, 'big.js'), s + '\n');
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      const cwd = ${JSON.stringify(dir)}, out = [], argv = ['--json', 'from', 'big.js'];
      const last = (b) => { const t = Buffer.from(b).toString('latin1'); return { len: t.length, summary: t.slice(t.lastIndexOf('\\n', t.length - 2) + 1) }; };
      (async () => {
        let t0 = Date.now();
        const s = rgn.runRg(argv, { ...ctx, cwd });
        out.push({ twin: 'sync', ms: Date.now() - t0, scannedBack: rgn.searchStats.scannedBack, status: s.status, ...last(s.stdout) });
        t0 = Date.now();
        const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, encoding: 'buffer', maxBuffer: 1e9 }, (e, so) => res({ status: e ? (e.code || e.signal) : 0, ...last(so) }), 'rg', ctx));
        out.push({ twin: 'async', ms: Date.now() - t0, scannedBack: rgn.searchStats.scannedBack, ...a });
        process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 120000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    for (const r of JSON.parse(line.slice('PROBE:'.length))) {
      assert.strictEqual(r.status, 0, JSON.stringify(r).slice(0, 300));
      assert.strictEqual(normalizeRg(Buffer.from(r.summary, 'latin1'), ['--json']), '{"data":{"elapsed_total":{},"stats":{"bytes_printed":20323626,'
        + '"bytes_searched":5000007,"elapsed":{},"matched_lines":1,"matches":275822,"searches":1,"searches_with_match":1}},"type":"summary"}\n', r.twin);
      // linear, COUNTED (re-review M1): finding the lines' starts steps over at most the text once
      assert.ok(r.scannedBack <= 5000007, `${r.twin}: stepped back over ${r.scannedBack} bytes of a 5,000,007-byte text`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// THE CALLER'S DESCRIPTORS (Task 7 review I1). A named /dev/stdin, /dev/fd/N or /proc/self/fd/N is the
// rg CHILD's descriptor to native; quaude's rg runs inside its caller, so opening one opens the CALLER's
// (on macOS an O_NONBLOCK open of /dev/fd/0 returns a dup that keeps fd 0's blocking mode, and the read
// held the whole engine: under -p from a terminal quaude froze). And no character device but /dev/null
// is ever read: a nonblocking read of a terminal can eat keystrokes typed ahead into a live TUI. So those
// names, and every other character device, refuse by name at once (RG-REFUSE-SPECIAL-FILE), with
// quaude's own stdin a terminal nothing writes to (the repro: native printed ok.txt, ours never ended).
test('RG-REFUSE-SPECIAL-FILE: /dev/stdin, /dev/fd/0 and /dev/tty refuse at once under a terminal, never read (tjs, both twins)', {
  skip: needUgrep.skip || (!['darwin', 'linux'].includes(process.platform) ? 'needs script(1) for a pty'
    : NO_TJS ? NO_TJS : !fs.existsSync('/usr/bin/script') ? 'no /usr/bin/script' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-tty-')));
  try {
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'needle\n');
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      const cwd = ${JSON.stringify(dir)};
      const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      (async () => {
        const out = [];
        for (const p of ['/dev/stdin', '/dev/fd/0', '/dev/tty', '/dev/null']) {
          const argv = ['-l', 'needle', p, 'ok.txt'];
          const s = rgn.runRg(argv, { ...ctx, cwd });
          const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd }, (e, so, se) => res({ status: e ? e.code : 0, stdout: String(so), stderr: String(se) }), 'rg', ctx));
          out.push({ p, sync: { status: s.status, stdout: String(s.stdout), stderr: String(s.stderr) }, async: a });
        }
        process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
      })();
    `);
    const [cmd, argv] = engineSpawn(['run', LOADER, prog]);
    const quote = (x) => `'${x.replace(/'/g, "'\\''")}'`;
    const [sc, sargs] = process.platform === 'darwin' ? ['/usr/bin/script', ['-q', '/dev/null', cmd, ...argv]]
      : ['/usr/bin/script', ['-qec', [cmd, ...argv].map(quote).join(' '), '/dev/null']];
    // script's stdin stays open and silent (a real pipe from a sleep: macOS script(1) rejects a socket
    // pair, node's 'pipe'), so the pty it hands the engine has nothing to read
    const child = cp.spawn('/bin/sh', ['-c', 'sleep 60 | "$@"', 'sh', sc, ...sargs], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const t0 = Date.now();
    const done = await new Promise((res) => {
      const iv = setInterval(() => { if (out.includes('PROBE:') && out.slice(out.indexOf('PROBE:')).includes('\n')) { clearInterval(iv); res(true); } else if (Date.now() - t0 > 20000) { clearInterval(iv); res(false); } }, 50);
    });
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    assert.ok(done, `the engine under a terminal never answered (${Date.now() - t0} ms): ${out.slice(0, 500)}`);
    const got = JSON.parse(out.slice(out.indexOf('PROBE:') + 6).split(/\r?\n/)[0]);
    for (const r of got) {
      for (const twin of ['sync', 'async']) {
        if (r.p === '/dev/null') { assert.deepStrictEqual([r[twin].status, r[twin].stdout], [0, 'ok.txt\n'], `${twin} ${r.p}`); continue; }
        assert.strictEqual(r[twin].status, 2, `${twin} ${r.p}: ${JSON.stringify(r[twin])}`);
        assert.match(rgn.parseRgRefusal(r[twin].stderr).reason, /RG-REFUSE-SPECIAL-FILE/, `${twin} ${r.p}`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The same count, on node, on a line small enough that the quadratic shape fails in well under a second
// (re-review M1: the 5 MB guard caught it only at its 120 s harness timeout): every match of a 100 KB
// line, through the JSON printer, the -o printer and -c -o, both twins.
test('RG-JSON: finding each match\'s line steps over the text at most once (counted; both twins, three printers)', needUgrep, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-scanback-')));
  try {
    const text = 'import x from "y";'.repeat(5600) + '\n';
    fs.writeFileSync(path.join(dir, 'one.js'), text);
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    for (const argv of [['--json', 'from', 'one.js'], ['-o', 'from', 'one.js'], ['-c', '-o', 'from', 'one.js']]) {
      const s = rgn.runRg(argv, { ...ctx, cwd: dir });
      assert.strictEqual(s.status, 0);
      assert.ok(rgn.searchStats.scannedBack <= text.length, `sync rg ${argv.join(' ')}: stepped back over ${rgn.searchStats.scannedBack} bytes of ${text.length}`);
      await new Promise((res) => rgn.rgExecFile(argv, { cwd: dir, maxBuffer: 1e9 }, (e) => { assert.strictEqual(e, null); res(); }, 'rg', ctx));
      assert.ok(rgn.searchStats.scannedBack <= text.length, `async rg ${argv.join(' ')}: stepped back over ${rgn.searchStats.scannedBack} bytes of ${text.length}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// THE CALLER'S maxBuffer AND ITS EVENT LOOP (Task 7 review I2). The Grep tool runs rg through execFile
// with maxBuffer 20,000,000 and a 20 s timeout; native is killed within ~100 ms of passing it. Ours
// built the whole answer before the child saw any of it, holding the loop the whole time (tjs, this
// Mac: `--json '' lines.txt` 31.7 s total and a 20.3 s block, so the timeout could not fire). Now the
// search STOPS printing once past the caller's maxBuffer, and the async twin hands the loop back while
// it parses ugrep's records and while it prints. Judged by COUNTS, not wall time (re-review I-1: a
// timeout firing, or after-the-fact truncation, looked the same to a wall-clock bound): what the search
// printed (rgn.searchStats.printed) must stay within one slice of a 1 MB maxBuffer, on both twins, and
// every call must end in execFile's maxBuffer error (ENOBUFS for the sync twin), never its timeout.
// The loop's longest gap is the one wall-clock bound left: it is what the review measured.
//
// SLOW IS NOT STALLED (2026-11-19). On c840eb8 the full suite failed the -n -o row: SIGKILL at the probe's
// 20 s timeout, printed 0. Measured with ugrep wrapped to tee its stdout, under 16 CPU hogs and an IO loop
// (reproduced 4 of 4): ugrep wrote all 30.6 MB (1.2M records) and tjs RECEIVED all of it and saw ugrep close
// within 0.9 s every time. The 20 s went to quaude's own work after that: the async twin parses EVERY record
// before printing (14-16 s under that load, 3.2-4.0 s alone) and then prints to the 1 MB maxBuffer (7-12 s
// loaded, 1.8-2.2 s alone). With a timeout that cannot fire, all three loaded runs ended in the maxBuffer error
// at 23.6-28.6 s. So it was load on a cost that scales with ALL matches, not with maxBuffer (BACKLOG: "quaude's
// rg parses every ugrep record before printing"), not a pipe stall. The probe's timeout is therefore NOT the
// Grep tool's 20 s: PROBE_TIMEOUT_MS is 120 s, 4.2x the worst loaded run. And each row now SAYS which it was:
// ugrepClosed records how the ugrep child ended. A stall (bytes ugrep wrote that never reached the tjs reader,
// the Haiku >64 KB write family) leaves the child open until the timeout kills it; a slow search shows it closed
// on its own, with every byte received, long before.
const PROBE_TIMEOUT_MS = 120000;
const MB_SLACK = 512 * 1024;   // one 64 KiB slice of JSON, every byte of it escaped (x6), and change
test('rg stops printing at the caller\'s maxBuffer and the async twin never holds the loop (tjs, counted)', {
  skip: needUgrep.skip || NO_TJS,
}, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-maxbuf-')));
  try {
    let lines = '';
    for (let i = 0; i < 200000; i++) lines += `line ${i} needle here\n`;
    fs.writeFileSync(path.join(dir, 'lines.txt'), lines);
    fs.writeFileSync(path.join(dir, 'lines50k.txt'), lines.slice(0, lines.indexOf('line 50000 ')));
    fs.writeFileSync(path.join(dir, 'line5m.js'), 'var a=1;' + 'import x from "y";'.repeat(270000) + '\n');
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      // Every ugrep search child (not the --version probe): how it ended, and what the tjs reader got from it.
      let kids = [];
      const spawn = (bin, args, o) => {
        const c = cp.spawn(bin, args, o);
        if (args.some((x) => String(x).startsWith('--format'))) {
          const k = { t0: Date.now(), received: 0, closedMs: null, status: null, signal: null };
          kids.push(k);
          c.stdout.on('data', (d) => { k.received += d.length; });
          c.on('close', (status, signal) => { k.closedMs = Date.now() - k.t0; k.status = status; k.signal = signal; });
        }
        return c;
      };
      const ctx = { spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      const cwd = ${JSON.stringify(dir)}, out = [], maxBuffer = 1000000;
      (async () => {
        for (const argv of [['--json', '', 'lines50k.txt'], ['--json', 'needle', 'lines.txt'], ['--json', 'from', 'line5m.js'], ['-n', '-o', 'e', 'lines.txt']]) {
          let last = Date.now(), maxGap = 0;
          kids = [];
          const t0 = Date.now();
          const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
          const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, encoding: 'buffer', maxBuffer, timeout: ${PROBE_TIMEOUT_MS}, killSignal: 'SIGKILL' },
            (e, so) => res({ code: e ? e.code : 0, signal: e ? e.signal : null, timedOut: !!(e && e.killed && e.code === null), bytes: so.length }), 'rg', ctx));
          clearInterval(iv);
          const ugrepClosed = kids.map(({ received, closedMs, status, signal }) => ({ received, closedMs, status, signal }));
          out.push({ argv, twin: 'async', maxGap, printed: rgn.searchStats.printed, ms: Date.now() - t0, ugrepClosed, ...a });
        }
        const s = rgn.runRg(['--json', 'needle', 'lines.txt'], { ...ctx, cwd, maxBuffer });
        out.push({ twin: 'sync', code: s.errorCode || s.status, printed: rgn.searchStats.printed, bytes: s.stdout.length });
        process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 5 * PROBE_TIMEOUT_MS });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    if (process.env.RG_TIMINGS) console.log('RG_TIMINGS ' + JSON.stringify(got));
    for (const r of got) {
      const what = JSON.stringify(r);
      if (r.twin === 'async') {
        // A STALL is only when the probe's OWN timeout fired and a ugrep child was still open (killed, or never closed):
        // its output never reached EOF in the tjs reader. A child ended by a signal otherwise is not one: once the
        // BACKLOG fix streams records and kills ugrep at maxBuffer, SIGPIPE or SIGTERM there is the right outcome.
        const open = r.timedOut ? r.ugrepClosed.filter((k) => k.closedMs === null || k.signal) : [];
        assert.ok(r.ugrepClosed.length && !open.length, `STALL? ugrep's output never reached EOF in the tjs reader before the `
          + `${PROBE_TIMEOUT_MS} ms timeout killed it (received ${open.map((k) => k.received).join(', ')} bytes): ${what}`);
        if (r.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          assert.fail(`SLOW, not stalled: every ugrep child closed on its own (${r.ugrepClosed.map((k) => `${k.received} bytes by ${k.closedMs} ms`).join(', ')}), `
            + `then quaude's own parse and print did not reach maxBuffer in ${r.ms} ms: ${what}`);
        }
      }
      assert.strictEqual(r.code, r.twin === 'sync' ? 'ENOBUFS' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', what);
      assert.ok(r.printed > 1000000 && r.printed <= 1000000 + MB_SLACK, `printed ${r.printed} bytes for a 1 MB maxBuffer: ${what}`);
      if (r.twin === 'async') { const held = judgeHold(r); assert.ok(!held, `${held}: ${what}`); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- rg's binary detection (grep-native Task 8): native's literals ---------------------------------------
// RG-BINARY-QUIT (a walked file: the line buffer's fill that meets a NUL ends the search before it is
// searched), RG-BINARY-CONVERT (stdin, more than 10 paths or a path that is not a regular file, or a BOM:
// a NUL is a line break; the standard printer stops at the NUL's fill), RG-BINARY-MMAP (named regular
// files, at most 10: the NUL stays in its line), RG-MMAP-EVERYWHERE (that, on every host), RG-STDIN-ALL-
// THERE (stdin read as if all of it had arrived), each stated in libexec/rg-native.cjs's "rg's binary
// detection". [rule, argv, the file piped to stdin, rc, stdout] as native 2.1.283's embedded rg printed
// them over P8_FILES in that tree (--json through normalizeRg): P8_NATIVE on this Mac (darwin-arm64) where
// macOS and Linux native agree, P8_NATIVE_LINUX by the linux-x64 native in a node:24.21.0-bookworm
// container (measured 2026-10-04; the generator is in the task-8 report), and P8_MACOS_DIVERGENCE, the
// darwin rows RG-MMAP-EVERYWHERE answers as Linux native does: [rule, argv, input, macOS rc, macOS stdout
// (the record of the divergence), Linux rc, Linux stdout (the expectation)]. Each walk lists one file, and
// rows naming several files use -j1, so no row depends on rg's walk order. The files are built here, byte
// for byte: late.dat (a match at 0, a NUL at 120030, past the first 64 KiB fill), early.dat (a NUL at 19),
// the 3-byte BOM peek's first read (peek1: a newline inside it; peek3: none; peek0: the NUL inside it), a
// UTF-8 BOM, UTF-16 whose decoded U+0000 is the 4,096th code unit or the 4,097th (one decoder read later),
// a line longer than the buffer (it grows), a NUL at exactly 64 KiB (b64k), and m/f0..f10 (late.dat and
// ten files without a match: 10 named paths are mapped, 11 are not).
const cat8 = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const u16le8 = (s) => cat8([0xff, 0xfe], Buffer.from(s, 'utf16le'));
const NUL8 = String.fromCharCode(0);
const P8_BYTES = {
  late: cat8('first needle line\n' + 'filler line\n'.repeat(10000) + 'near needle\n', [0, 0x0a], 'after needle\n'),
  early: cat8('text needle before\n', [0, 1, 2, 0x0a], 'needle after nul\n'),
  peek1: cat8('a\nxyz needle\n', [0], '\nneedle\n'),
  peek3: cat8('abc\nneedle\n', [0], '\n'),
  peek0: cat8('n\n', [0], 'needle\n'),
  bom8: cat8([0xef, 0xbb, 0xbf], 'a\nneedle\n', [0], 'needle z\n'),
  u16a: u16le8('needle\n' + 'x'.repeat(4089) + NUL8 + '\nmore needle\n'),
  u16b: u16le8('needle\n' + 'x'.repeat(4088) + NUL8 + '\nmore needle\n'),
  grow: cat8('needle\n' + 'L'.repeat(200000) + '\nneedle 2\n', [0], '\n'),
  b64k: cat8('needle\n' + 'f'.repeat(65536 - 8) + '\n', [0], '\nneedle 2\n'),
};
const P8_FILES = [
  ['late.dat', P8_BYTES.late], ['early.dat', P8_BYTES.early], ['peek1.dat', P8_BYTES.peek1], ['grow.dat', P8_BYTES.grow],
  ['q/late/late.dat', P8_BYTES.late], ['q/early/early.dat', P8_BYTES.early], ['q/peek1/peek1.dat', P8_BYTES.peek1],
  ['q/peek3/peek3.dat', P8_BYTES.peek3], ['q/peek0/peek0.dat', P8_BYTES.peek0], ['q/bom8/bom8.dat', P8_BYTES.bom8],
  ['q/u16a/u16a.txt', P8_BYTES.u16a], ['q/u16b/u16b.txt', P8_BYTES.u16b], ['q/grow/grow.dat', P8_BYTES.grow], ['b64k.dat', P8_BYTES.b64k],
  ['m/f0.dat', P8_BYTES.late], ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => [`m/f${i}.dat`, 'x\n']),
];
const P8_INPUT = (name) => (name ? Buffer.from(new Map(P8_FILES).get(name)) : undefined);
const P8_NATIVE = [
  ['RG-BINARY-QUIT', ["-c","needle","q/late"], null, 1, ''],
  ['RG-BINARY-QUIT', ["-c","-o","needle","q/late"], null, 1, ''],
  ['RG-BINARY-QUIT', ["-l","needle","q/late"], null, 0, 'q/late/late.dat\n'],
  ['RG-BINARY-QUIT', ["-n","needle","q/late"], null, 0, 'q/late/late.dat:1:first needle line\nq/late/late.dat: WARNING: stopped searching binary file after match (found "\\0" byte around offset 120030)\n'],
  ['RG-BINARY-QUIT', ["-n","-H","--null","needle","q/late"], null, 0, 'q/late/late.dat\x001:first needle line\nq/late/late.dat: WARNING: stopped searching binary file after match (found "\\0" byte around offset 120030)\n'],
  ['RG-BINARY-QUIT', ["--json","needle","q/late"], null, 0, '{"type":"begin","data":{"path":{"text":"q/late/late.dat"}}}\n{"type":"match","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"end","data":{"path":{"text":"q/late/late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":65526,"bytes_printed":257,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":257,"bytes_searched":65526,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-QUIT', ["--json","-C","1","needle","q/late"], null, 0, '{"type":"begin","data":{"path":{"text":"q/late/late.dat"}}}\n{"type":"match","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"context","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"filler line\\n"},"line_number":2,"absolute_offset":18,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"q/late/late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":65502,"bytes_printed":405,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":405,"bytes_searched":65502,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-QUIT', ["--json","-B","1","-A","2","needle","q/late"], null, 0, '{"type":"begin","data":{"path":{"text":"q/late/late.dat"}}}\n{"type":"match","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"context","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"filler line\\n"},"line_number":2,"absolute_offset":18,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"filler line\\n"},"line_number":3,"absolute_offset":30,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"q/late/late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":65490,"bytes_printed":553,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":553,"bytes_searched":65490,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-QUIT', ["-l","needle","q/early"], null, 1, ''],
  ['RG-BINARY-QUIT', ["--json","needle","q/early"], null, 1, '{"data":{"elapsed_total":{},"stats":{"bytes_printed":0,"bytes_searched":0,"elapsed":{},"matched_lines":0,"matches":0,"searches":0,"searches_with_match":0}},"type":"summary"}\n'],
  ['RG-BINARY-QUIT', ["-n","[an]","q/peek1"], null, 0, 'q/peek1/peek1.dat:1:a\nq/peek1/peek1.dat: WARNING: stopped searching binary file after match (found "\\0" byte around offset 13)\n'],
  ['RG-BINARY-QUIT', ["-n","[an]","q/peek3"], null, 1, ''],
  ['RG-BINARY-QUIT', ["-l","needle","q/peek0"], null, 1, ''],
  ['RG-BINARY-QUIT', ["-n","needle","q/bom8"], null, 1, ''],
  ['RG-BINARY-QUIT', ["-n","needle","q/u16a"], null, 0, 'q/u16a/u16a.txt:1:needle\nq/u16a/u16a.txt: WARNING: stopped searching binary file after match (found "\\0" byte around offset 4096)\n'],
  ['RG-BINARY-QUIT', ["-n","needle","q/u16b"], null, 1, ''],
  ['RG-BINARY-QUIT', ["--json","needle","q/u16a"], null, 0, '{"type":"begin","data":{"path":{"text":"q/u16a/u16a.txt"}}}\n{"type":"match","data":{"path":{"text":"q/u16a/u16a.txt"},"lines":{"text":"needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"q/u16a/u16a.txt"},"binary_offset":4096,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":7,"bytes_printed":245,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":245,"bytes_searched":7,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-QUIT', ["-n","needle","q/grow"], null, 0, 'q/grow/grow.dat:1:needle\nq/grow/grow.dat: WARNING: stopped searching binary file after match (found "\\0" byte around offset 200017)\n'],
  ['RG-BINARY-CONVERT', ["-n","needle","early.dat"], null, 0, 'binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-CONVERT', ["-n","-H","needle","early.dat"], null, 0, 'early.dat: binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-CONVERT', ["-n","-H","--null","needle","early.dat"], null, 0, 'early.dat: binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-CONVERT', ["-c","needle","early.dat"], null, 0, '2\n'],
  ['RG-BINARY-CONVERT', ["-l","needle","early.dat"], null, 0, 'early.dat\n'],
  ['RG-BINARY-CONVERT', ["-c","-e","^n","early.dat"], null, 0, '1\n'],
  ['RG-BINARY-CONVERT', ["-c","needle","late.dat"], null, 0, '3\n'],
  ['RG-BINARY-CONVERT', ["-n","needle","-"], 'early.dat', 0, 'binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-CONVERT', ["--json","needle","-"], 'early.dat', 0, '{"type":"begin","data":{"path":{"text":"<stdin>"}}}\n{"type":"match","data":{"path":{"text":"<stdin>"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"<stdin>"},"lines":{"text":"needle after nul\\n"},"line_number":4,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"<stdin>"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":40,"bytes_printed":430,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":430,"bytes_searched":40,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
];
const P8_NATIVE_LINUX = [
  ['RG-BINARY-MMAP', ["-n","needle","early.dat"], null, 0, 'binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-MMAP', ["-n","-H","needle","early.dat"], null, 0, 'early.dat: binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-MMAP', ["--json","needle","early.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"early.dat"}}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"needle after nul\\n"},"line_number":3,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"early.dat"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":19,"bytes_printed":436,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":436,"bytes_searched":19,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-MMAP', ["--json","-C","1","needle","early.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"early.dat"}}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"context","data":{"path":{"text":"early.dat"},"lines":{"text":"\\u0000\\u0001\\u0002\\n"},"line_number":2,"absolute_offset":19,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"needle after nul\\n"},"line_number":3,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"early.dat"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":19,"bytes_printed":585,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":585,"bytes_searched":19,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-MMAP', ["-c","needle","early.dat"], null, 0, '2\n'],
  ['RG-BINARY-MMAP', ["-c","-e","^n","early.dat"], null, 0, '1\n'],
  ['RG-BINARY-MMAP', ["-l","needle","early.dat"], null, 0, 'early.dat\n'],
  ['RG-BINARY-MMAP', ["-n","needle","late.dat"], null, 0, '1:first needle line\n10002:near needle\n10004:after needle\n'],
  ['RG-BINARY-MMAP', ["--json","needle","late.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"late.dat"}}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"near needle\\n"},"line_number":10002,"absolute_offset":120018,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"after needle\\n"},"line_number":10004,"absolute_offset":120032,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"end","data":{"path":{"text":"late.dat"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":120045,"bytes_printed":630,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":630,"bytes_searched":120045,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-MMAP', ["-n","-C","1","needle","late.dat"], null, 0, '1:first needle line\n2-filler line\n--\n10001-filler line\n10002:near needle\nbinary file matches (found "\\0" byte around offset 120030)\n'],
  ['RG-BINARY-MMAP', ["--json","-C","1","needle","late.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"late.dat"}}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"context","data":{"path":{"text":"late.dat"},"lines":{"text":"filler line\\n"},"line_number":2,"absolute_offset":18,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"late.dat"},"lines":{"text":"filler line\\n"},"line_number":10001,"absolute_offset":120006,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"near needle\\n"},"line_number":10002,"absolute_offset":120018,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"context","data":{"path":{"text":"late.dat"},"lines":{"text":"\\u0000\\n"},"line_number":10003,"absolute_offset":120030,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"after needle\\n"},"line_number":10004,"absolute_offset":120032,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"end","data":{"path":{"text":"late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":120030,"bytes_printed":1064,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":1064,"bytes_searched":120030,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-MMAP', ["-n","[an]","peek1.dat"], null, 0, 'binary file matches (found "\\0" byte around offset 13)\n'],
  ['RG-BINARY-MMAP', ["-j1","-n","needle","early.dat","late.dat"], null, 0, 'early.dat: binary file matches (found "\\0" byte around offset 19)\nlate.dat:1:first needle line\nlate.dat:10002:near needle\nlate.dat:10004:after needle\n'],
  ['RG-BINARY-MMAP', ["-n","needle","grow.dat"], null, 0, '1:needle\n3:needle 2\n'],
  ['RG-BINARY-MMAP', ["-n","needle","q/bom8/bom8.dat"], null, 0, 'binary file matches (found "\\0" byte around offset 9)\n'],
  ['RG-BINARY-MMAP', ["--json","needle","late.dat","q/early"], null, 0, '{"type":"begin","data":{"path":{"text":"late.dat"}}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"near needle\\n"},"line_number":10002,"absolute_offset":120018,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"after needle\\n"},"line_number":10005,"absolute_offset":120032,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"end","data":{"path":{"text":"late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":120045,"bytes_printed":630,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":630,"bytes_searched":120045,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-MMAP', ["-n","needle","-"], 'early.dat', 0, 'binary file matches (found "\\0" byte around offset 19)\n'],
  ['RG-BINARY-QUIT', ["-c","needle","q/late"], null, 1, ''],
  ['RG-BINARY-QUIT', ["--json","-C","1","needle","q/late"], null, 0, '{"type":"begin","data":{"path":{"text":"q/late/late.dat"}}}\n{"type":"match","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"context","data":{"path":{"text":"q/late/late.dat"},"lines":{"text":"filler line\\n"},"line_number":2,"absolute_offset":18,"submatches":[]}}\n{"type":"end","data":{"path":{"text":"q/late/late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":65502,"bytes_printed":405,"matched_lines":1,"matches":1}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":405,"bytes_searched":65502,"elapsed":{},"matched_lines":1,"matches":1,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-BINARY-QUIT', ["-n","[an]","q/peek1"], null, 0, 'q/peek1/peek1.dat:1:a\nq/peek1/peek1.dat: WARNING: stopped searching binary file after match (found "\\0" byte around offset 13)\n'],
  ['RG-BINARY-QUIT', ["-n","needle","q/u16a"], null, 0, 'q/u16a/u16a.txt:1:needle\nq/u16a/u16a.txt: WARNING: stopped searching binary file after match (found "\\0" byte around offset 4096)\n'],
  ['RG-BINARY-MMAP', ["-j1","-n","needle","m/f0.dat","m/f1.dat","m/f2.dat","m/f3.dat","m/f4.dat","m/f5.dat","m/f6.dat","m/f7.dat","m/f8.dat","m/f9.dat"], null, 0, 'm/f0.dat:1:first needle line\nm/f0.dat:10002:near needle\nm/f0.dat:10004:after needle\n'],
  ['RG-BINARY-CONVERT', ["-j1","-n","needle","m/f0.dat","m/f1.dat","m/f2.dat","m/f3.dat","m/f4.dat","m/f5.dat","m/f6.dat","m/f7.dat","m/f8.dat","m/f9.dat","m/f10.dat"], null, 0, 'm/f0.dat:1:first needle line\nm/f0.dat: binary file matches (found "\\0" byte around offset 120030)\n'],
  ['RG-BINARY-CONVERT', ["-j1","-n","needle","late.dat","-"], null, 0, 'late.dat:1:first needle line\nlate.dat: binary file matches (found "\\0" byte around offset 120030)\n'],
];
const P8_MACOS_DIVERGENCE = [
  ['RG-MMAP-EVERYWHERE', ["--json","needle","early.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"early.dat"}}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"needle after nul\\n"},"line_number":4,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"early.dat"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":40,"bytes_printed":436,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":436,"bytes_searched":40,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n', 0, '{"type":"begin","data":{"path":{"text":"early.dat"}}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"needle after nul\\n"},"line_number":3,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"early.dat"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":19,"bytes_printed":436,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":436,"bytes_searched":19,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-MMAP-EVERYWHERE', ["--json","-C","1","needle","early.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"early.dat"}}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"context","data":{"path":{"text":"early.dat"},"lines":{"text":"\\n"},"line_number":2,"absolute_offset":19,"submatches":[]}}\n{"type":"context","data":{"path":{"text":"early.dat"},"lines":{"text":"\\u0001\\u0002\\n"},"line_number":3,"absolute_offset":20,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"needle after nul\\n"},"line_number":4,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"early.dat"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":40,"bytes_printed":710,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":710,"bytes_searched":40,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n', 0, '{"type":"begin","data":{"path":{"text":"early.dat"}}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"text needle before\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"context","data":{"path":{"text":"early.dat"},"lines":{"text":"\\u0000\\u0001\\u0002\\n"},"line_number":2,"absolute_offset":19,"submatches":[]}}\n{"type":"match","data":{"path":{"text":"early.dat"},"lines":{"text":"needle after nul\\n"},"line_number":3,"absolute_offset":23,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\n{"type":"end","data":{"path":{"text":"early.dat"},"binary_offset":19,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":19,"bytes_printed":585,"matched_lines":2,"matches":2}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":585,"bytes_searched":19,"elapsed":{},"matched_lines":2,"matches":2,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-MMAP-EVERYWHERE', ["-n","needle","late.dat"], null, 0, '1:first needle line\nbinary file matches (found "\\0" byte around offset 120030)\n', 0, '1:first needle line\n10002:near needle\n10004:after needle\n'],
  ['RG-MMAP-EVERYWHERE', ["--json","needle","late.dat"], null, 0, '{"type":"begin","data":{"path":{"text":"late.dat"}}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"near needle\\n"},"line_number":10002,"absolute_offset":120018,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"after needle\\n"},"line_number":10005,"absolute_offset":120032,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"end","data":{"path":{"text":"late.dat"},"binary_offset":120030,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":120045,"bytes_printed":630,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":630,"bytes_searched":120045,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n', 0, '{"type":"begin","data":{"path":{"text":"late.dat"}}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"first needle line\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"near needle\\n"},"line_number":10002,"absolute_offset":120018,"submatches":[{"match":{"text":"needle"},"start":5,"end":11}]}}\n{"type":"match","data":{"path":{"text":"late.dat"},"lines":{"text":"after needle\\n"},"line_number":10004,"absolute_offset":120032,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n{"type":"end","data":{"path":{"text":"late.dat"},"binary_offset":null,"stats":{"elapsed":{},"searches":1,"searches_with_match":1,"bytes_searched":120045,"bytes_printed":630,"matched_lines":3,"matches":3}}}\n{"data":{"elapsed_total":{},"stats":{"bytes_printed":630,"bytes_searched":120045,"elapsed":{},"matched_lines":3,"matches":3,"searches":1,"searches_with_match":1}},"type":"summary"}\n'],
  ['RG-MMAP-EVERYWHERE', ["-n","[an]","peek1.dat"], null, 0, '1:a\nbinary file matches (found "\\0" byte around offset 13)\n', 0, 'binary file matches (found "\\0" byte around offset 13)\n'],
  ['RG-MMAP-EVERYWHERE', ["-j1","-n","needle","early.dat","late.dat"], null, 0, 'early.dat: binary file matches (found "\\0" byte around offset 19)\nlate.dat:1:first needle line\nlate.dat: binary file matches (found "\\0" byte around offset 120030)\n', 0, 'early.dat: binary file matches (found "\\0" byte around offset 19)\nlate.dat:1:first needle line\nlate.dat:10002:near needle\nlate.dat:10004:after needle\n'],
  ['RG-MMAP-EVERYWHERE', ["-n","needle","grow.dat"], null, 0, '1:needle\nbinary file matches (found "\\0" byte around offset 200017)\n', 0, '1:needle\n3:needle 2\n'],
];
// RG-STDIN-ALL-THERE's named macOS PIPE-CAPACITY divergence (libexec/rg-native.cjs states it): quaude's rg
// reads stdin as if all of it had arrived, which is Linux native's answer (40 of 40), where a macOS pipe
// holds 64 KiB and native's first fill there ends at it (one-shot writers: 20 of 20 in Task 8's re-review,
// 15 and 18 of 20 re-measured 2026-10-04 under spawnSync, the rest whole). [rule, argv, input, macOS rc,
// macOS stdout (the record of the divergence: its modal answer), Linux rc, Linux stdout (the expectation)].
const P8_MACOS_PIPE_DIVERGENCE = [
  ['RG-STDIN-ALL-THERE', ["-n","-C","1","needle","-"], 'b64k.dat',
    0, `1:needle\n2-${'f'.repeat(65528)}\n--\nbinary file matches (found "\\0" byte around offset 65536)\n`,
    0, '1:needle\nbinary file matches (found "\\0" byte around offset 65536)\n'],
];
// Every row, as one host answers it now (RG-MMAP-EVERYWHERE and RG-STDIN-ALL-THERE: a divergence row
// expects Linux native's).
const P8_ROWS = [...P8_NATIVE, ...P8_NATIVE_LINUX, ...[...P8_MACOS_DIVERGENCE, ...P8_MACOS_PIPE_DIVERGENCE].map(([rule, argv, input, , , rc, out]) => [rule, argv, input, rc, out])]
  .map((r) => [r]);
async function withP8(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-p8-')));
  try {
    for (const [rel, data] of P8_FILES) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
    return await fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const P8_NAMES_DIR = (argv) => argv.some((a) => /^q\/[a-z0-9]+$/.test(a));
function p8Sync(root, [, argv, input], { alone = false } = {}) {
  const r = rgn.runRg(argv, {
    cwd: root, input: P8_INPUT(input), spawnSync: cp.spawnSync,
    ugrep: () => (alone ? null : UGREP), matchFiles: alone ? rgn.matchFilesAlone : undefined,
  });
  return { status: r.status, stdout: Buffer.from(r.stdout).toString('latin1'), stderr: Buffer.from(r.stderr).toString('latin1') };
}
function p8Async(root, [, argv, input]) {
  return new Promise((resolve) => {
    const child = rgn.rgExecFile(argv, { cwd: root, encoding: 'buffer' }, (err, so, se) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: so.toString('latin1'), stderr: se.toString('latin1') });
    }, 'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP });
    if (input) child.stdin.end(P8_INPUT(input)); else if (child.stdin) child.stdin.end();
  });
}
for (const rule of ['RG-BINARY-QUIT', 'RG-BINARY-CONVERT', 'RG-BINARY-MMAP', 'RG-MMAP-EVERYWHERE', 'RG-STDIN-ALL-THERE']) {
  test(`${rule}: runRg prints what native prints (native, over ugrep)`, needUgrep, () => withP8((root) => {
    const rows = P8_ROWS.filter(([r]) => r[0] === rule);
    assert.ok(rows.length >= 1, rule);
    for (const [row] of rows) p6Check(root, row, p8Sync(root, row), false);
  }));
}
// RG-MMAP-EVERYWHERE is ONE written exception, stated once (scripts/lib/rg-probe.cjs MMAP_EVERYWHERE): its
// rows are exactly the darwin rows where macOS native and Linux native differ, each a named file it maps.
test('RG-MMAP-EVERYWHERE: a divergence row is one where macOS and Linux native differ, and it is the one rule', () => {
  assert.strictEqual(require('../scripts/lib/rg-probe.cjs').MMAP_EVERYWHERE.rule, 'RG-MMAP-EVERYWHERE');
  for (const [rule, argv, input, mrc, mout, lrc, lout] of P8_MACOS_DIVERGENCE) {
    assert.strictEqual(rule, 'RG-MMAP-EVERYWHERE');
    assert.ok(mrc !== lrc || mout !== lout, `${argv.join(' ')}: macOS and Linux agree, so it needs no exception`);
    assert.ok(!input && !argv.includes('-') && argv.filter((a) => /\.dat$/.test(a)).length <= 10, `${argv.join(' ')}: not a mapped named file`);
  }
});
// RG-STDIN-ALL-THERE's macOS pipe-capacity divergence is its own named record: stdin rows only, each one
// where macOS and Linux native differ.
test('RG-STDIN-ALL-THERE: a pipe-capacity divergence row reads stdin, and macOS and Linux native differ there', () => {
  assert.ok(P8_MACOS_PIPE_DIVERGENCE.length >= 1);
  for (const [rule, argv, input, mrc, mout, lrc, lout] of P8_MACOS_PIPE_DIVERGENCE) {
    assert.strictEqual(rule, 'RG-STDIN-ALL-THERE');
    assert.ok(input && argv.includes('-'), `${argv.join(' ')}: not a stdin row`);
    assert.ok(mrc !== lrc || mout !== lout, `${argv.join(' ')}: macOS and Linux agree, so it needs no record`);
  }
});
// The record is kept honest where it can be measured: on macOS, native fed by one write (spawnSync's)
// prints only its recorded macOS answer or Linux's, and its recorded one at least once in 10 runs. A
// change in macOS native (or in macOS pipes) fails here, naming the record to re-measure.
const NATIVE_BIN = require('./provider-resolve.cjs').rgOracle(process.env);
test('RG-STDIN-ALL-THERE: macOS native still prints its recorded pipe-capacity answer (native, macOS)',
  { skip: process.platform !== 'darwin' ? 'macOS only' : !NATIVE_BIN ? require('./provider-resolve.cjs').rgOracleSkip(process.env) : false }, () => withP8((root) => {
    for (const [, argv, input, mrc, mout, lrc, lout] of P8_MACOS_PIPE_DIVERGENCE) {
      let recorded = 0;
      for (let i = 0; i < 10; i++) {
        const r = cp.spawnSync(NATIVE_BIN, ['--no-config', ...argv], { cwd: root, argv0: 'rg', input: P8_INPUT(input), env: { HOME: root }, maxBuffer: 1 << 24 });
        const out = Buffer.from(r.stdout).toString('latin1');
        const isMac = r.status === mrc && out === mout, isLinux = r.status === lrc && out === lout;
        assert.ok(isMac || isLinux, `${argv.join(' ')}: macOS native printed neither recorded answer (rc ${r.status}, ${out.length} bytes): re-measure RG-STDIN-ALL-THERE`);
        if (isMac) recorded++;
      }
      assert.ok(recorded >= 1, `${argv.join(' ')}: macOS native never printed its recorded pipe-capacity answer in 10 runs: re-measure RG-STDIN-ALL-THERE`);
    }
  }));
test('RG-BINARY-*: with the matcher alone deciding every file, native\'s rows that name no directory', () => withP8((root) => {
  let n = 0;
  for (const [row] of P8_ROWS.filter(([r]) => !P8_NAMES_DIR(r[1]))) { p6Check(root, row, p8Sync(root, row, { alone: true }), false); n++; }
  assert.ok(n >= 30, `${n} rows`);
}));
test('RG-BINARY-*: the async twin prints every row the sync one does (rgExecFile, native)', needUgrep, () => withP8(async (root) => {
  for (const [row] of P8_ROWS) p6Check(root, row, await p8Async(root, row), false);
}));
test('RG-BINARY-*: under tjs, both twins, every row (native)', { skip: needUgrep.skip || NO_TJS }, () => withP8((root) => {
  const prog = path.join(root, '..', path.basename(root) + '-probe.cjs');
  fs.writeFileSync(prog, `
    const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
    const cp = require('child_process');
    const root = ${JSON.stringify(root)}, UGREP = ${JSON.stringify(UGREP)};
    const rows = ${JSON.stringify(P8_ROWS.map(([r]) => [r[1], r[2] ? P8_INPUT(r[2]).toString('base64') : null]))};
    const l1 = (b) => Buffer.from(b).toString('latin1');
    (async () => {
      const out = [];
      for (const [argv, input] of rows) {
        const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
        const inp = input ? Buffer.from(input, 'base64') : undefined;
        const s = rgn.runRg(argv, { ...ctx, cwd: root, input: inp });
        const a = await new Promise((res) => {
          const c = rgn.rgExecFile(argv, { cwd: root, encoding: 'buffer' }, (err, so, se) => res({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx);
          if (inp) c.stdin.end(inp); else if (c.stdin) c.stdin.end();
        });
        out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
      }
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `);
  try {
    const res = runLoader(prog, [], { timeout: 180000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    assert.strictEqual(got.length, P8_ROWS.length);
    P8_ROWS.forEach(([row], i) => { p6Check(root, row, got[i].sync, false); p6Check(root, row, got[i].async, false); });
  } finally { fs.rmSync(prog, { force: true }); }
}));
// The line buffer's fills are found as rg finds them: each read steps back from its end to its last
// newline over its own bytes only, and each roll steps back over the max(-A, -B) + 1 lines it keeps. So a
// byte is stepped over at most once by the reads and by at most max(-A, -B) + 1 rolls: linear, at most
// (max(-A, -B) + 2) times the text (searchStats.scannedBack, the counted instrument). Measured (Task 8
// review M2) over 90 shapes of line length, context and size: worst 1.98 times, at 33,000-byte lines and
// -C 1, flat as the text grows fourfold. Shapes: 2.4 MB with a NUL at its end, a 3 MB line the buffer
// grows for, and that worst one, walked and named, with context, both twins.
test('RG-BINARY-*: the line buffer\'s fills step over the text a bounded number of times (counted; both twins)', needUgrep, async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-p8lin-')));
  try {
    let s = '';
    for (let i = 0; i < 200000; i++) s += (i % 1000 === 0 ? 'needle ' : 'filler ') + 'line\n';
    const big = cat8(s, [0], '\n'), long = cat8('needle\n' + 'x'.repeat(3000000) + '\n', [0], 'needle\n');
    let worst = '';
    for (let i = 0; i < 182; i++) worst += (i % 2 === 0 ? 'needle' : 'xxxxxx') + 'y'.repeat(33000 - 7) + '\n';
    const wb = cat8(worst, [0, 0x0a]);
    for (const [rel, b] of [['w/big.dat', big], ['big.dat', big], ['w2/long.dat', long], ['long.dat', long], ['w3/worst.dat', wb]]) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), b);
    }
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    for (const [argv, len, C] of [[['-n', '-C', '2', 'needle', 'w'], big.length, 2], [['--json', '-C', '2', 'needle', 'big.dat'], big.length, 2],
      [['-n', '-C', '1', 'needle', 'w2'], long.length, 1], [['-n', 'needle', 'long.dat'], long.length, 0], [['-n', '-C', '1', 'needle', 'w3'], wb.length, 1]]) {
      const bound = (C + 2) * len;
      rgn.runRg(argv, { ...ctx, cwd: d });
      assert.ok(rgn.searchStats.scannedBack <= bound, `sync ${argv.join(' ')}: stepped back over ${rgn.searchStats.scannedBack} bytes of ${len}`);
      await new Promise((res) => rgn.rgExecFile(argv, { cwd: d, encoding: 'buffer' }, () => res(), 'rg', ctx));
      assert.ok(rgn.searchStats.scannedBack <= bound, `async ${argv.join(' ')}: stepped back over ${rgn.searchStats.scannedBack} bytes of ${len}`);
      if (process.env.RG_TIMINGS) console.log(argv.join(' '), (rgn.searchStats.scannedBack / len).toFixed(3));
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// RG-BINARY-QUIT's fills over a minified bundle with a NUL at its end (Task 8 review I-2, a 59 MB one): each read scans
// back to its last newline and each roll back over the context lines it keeps, and a byte loop in JS
// over 55 MB of 500 KB lines held the event loop 761-1011 ms under tjs. The async twin must keep handing the loop back:
// walked, with context, and -l. COUNTED, not timed (Task 10b fix round: a 600 ms wall-clock bound failed at 668 ms
// under load): each stage that loops hands control back at a stated rate, searchStats.ticks counts it, and the test
// holds the count to the work done: the fills once per FILL_TICK_BYTES they read (or 64 reads), the selected lines
// once per 4096 matches (measured here: 335 for -n -C 2, stopped at maxBuffer). Removing either yield fails it.
test('RG-BINARY-QUIT: the async twin keeps handing the loop back over a 55 MB file of long lines with a NUL at its end (counted; tjs)', {
  skip: needUgrep.skip || NO_TJS,
}, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-p8gap-')));
  try {
    let line = '';
    while (line.length < 500000) line += 'var a=b.c(d,e)||function(x){return x+1};';
    fs.mkdirSync(path.join(dir, 'w'));
    fs.writeFileSync(path.join(dir, 'w', 'bundle.js'), cat8((line + '\n').repeat(110), [0, 0x0a]));
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      const cwd = ${JSON.stringify(dir)}, out = [];
      (async () => {
        for (const argv of [['-n', '-C', '2', 'function', 'w'], ['-l', 'function', 'w']]) {
          let last = Date.now(), maxGap = 0;
          const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
          const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, encoding: 'buffer', maxBuffer: 1000000, timeout: 60000, killSignal: 'SIGKILL' },
            (e, so) => res({ code: e ? e.code : 0, bytes: so.length }), 'rg', ctx));
          clearInterval(iv);
          out.push({ argv, maxGap, ticks: { ...rgn.searchStats.ticks }, filled: rgn.searchStats.filled, ...a });
        }
        process.stdout.write('PROBE:' + JSON.stringify({ out, FILL_TICK_BYTES: rgn.FILL_TICK_BYTES }) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 180000 });
    const probe = JSON.parse(((res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:')) || 'PROBE:null').slice(6));
    assert.ok(probe, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = probe.out;
    if (process.env.RG_TIMINGS) console.log(JSON.stringify(probe));
    assert.strictEqual(got[0].code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', JSON.stringify(got[0]));
    assert.deepStrictEqual([got[1].code, got[1].bytes], [0, 12], JSON.stringify(got[1]));
    const [ctxRun] = got;
    assert.ok(probe.FILL_TICK_BYTES > 0 && ctxRun.filled >= 8 * probe.FILL_TICK_BYTES, `the fills read ${ctxRun.filled} bytes: the case no longer exercises them`);
    // a tick covers at most FILL_TICK_BYTES plus the read that crossed it, and no read here exceeds FILL_TICK_BYTES (the
    // buffer grows to about twice a 500 KB line): at least one tick per 2 x FILL_TICK_BYTES (measured: 37 over 55 MB)
    assert.ok(ctxRun.ticks.fill >= Math.floor(ctxRun.filled / (2 * probe.FILL_TICK_BYTES)),
      `the fills handed the loop back ${ctxRun.ticks.fill} times over ${ctxRun.filled} bytes (one per ${2 * probe.FILL_TICK_BYTES} at least)`);
    assert.ok(ctxRun.ticks.select >= 100, `the selected lines handed the loop back ${ctxRun.ticks.select} times (335 measured)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// -l of a walked file reads only up to the fill that answers it (Task 8 review I-1): a file larger than a
// Buffer may be (sparse, 2.5 GiB of zeros after `needle\n`: the NUL is in the first fill, so native lists
// nothing, rc 1; reading it whole failed, rc 2), and a 20 MB log with its NUL at the end and a match on
// its first line (native lists it after one fill), counted by searchStats.read. Both twins.
const RG_FILL = 64 * 1024;
test('RG-BINARY-QUIT: -l reads a walked file only as far as rg\'s fills decide (counted; both twins)', {
  skip: needUgrep.skip || (process.platform === 'win32' ? 'sparse files' : false),
}, async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-p8l-')));
  try {
    fs.mkdirSync(path.join(d, 'big')); fs.mkdirSync(path.join(d, 'log'));
    fs.writeFileSync(path.join(d, 'big', 's.bin'), 'needle\n');
    fs.truncateSync(path.join(d, 'big', 's.bin'), 2.5 * 1024 ** 3);
    fs.writeFileSync(path.join(d, 'log', 'app.log'), cat8('needle first\n' + 'log line of filler text\n'.repeat(850000), [0, 0x0a]));
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    for (const [target, status, out] of [['big', 1, ''], ['log', 0, 'log/app.log\n']]) {
      const s = rgn.runRg(['-l', 'needle', target], { ...ctx, cwd: d });
      assert.deepStrictEqual([s.status, String(s.stdout), String(s.stderr)], [status, out, ''], `sync -l ${target}`);
      assert.ok(rgn.searchStats.read <= 4 * RG_FILL, `sync -l ${target} read ${rgn.searchStats.read} bytes`);
      const a = await new Promise((res) => rgn.rgExecFile(['-l', 'needle', target], { cwd: d, encoding: 'buffer' },
        (e, so, se) => res([e ? e.code : 0, String(so), String(se)]), 'rg', ctx));
      assert.deepStrictEqual(a, [status, out, ''], `async -l ${target}`);
      assert.ok(rgn.searchStats.read <= 4 * RG_FILL, `async -l ${target} read ${rgn.searchStats.read} bytes`);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// RG-SPAWN-CWD (grep-native Task 11, found by the Linux end to end): the 2.1.283 bundle on Linux spawns its Grep's rg
// with cwd `/proc/self/fd/N`, a directory it holds open. A spawned rg never sees that name: the child chdir()s there
// before exec, while fd N is still the caller's, and rg's own working directory is that directory. quaude's rg runs
// inside the caller, where N names the same directory now, so the search resolves the name once, up front, and then
// searches as rg would from there; it used to take the cwd at its word and refuse the target `.` as a descriptor path
// (RG-REFUSE-SPECIAL-FILE), failing every Grep on Linux.
test('RG-SPAWN-CWD: a cwd naming a descriptor is the directory it resolves to; any other cwd is taken as given', () => {
  const calls = [];
  const realpath = (p) => { calls.push(p); return '/real/dir'; };
  for (const cwd of ['/proc/self/fd/17', '/proc/thread-self/fd/3', '/proc/4242/fd/9', '/dev/fd/9']) {
    assert.strictEqual(rgn.rgSpawnCwd(cwd, { realpath }), '/real/dir', cwd);
  }
  calls.length = 0;
  for (const cwd of ['/tmp/x', '/proc/self/cwd', '/dev/fdx/1', undefined]) assert.strictEqual(rgn.rgSpawnCwd(cwd, { realpath }), cwd, String(cwd));
  assert.deepStrictEqual(calls, [], 'only a descriptor cwd is resolved');
  // a name that does not resolve, or resolves to another descriptor, is left as it was (and refused as before)
  assert.strictEqual(rgn.rgSpawnCwd('/proc/self/fd/17', { realpath: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), '/proc/self/fd/17');
  assert.strictEqual(rgn.rgSpawnCwd('/proc/self/fd/17', { realpath: () => '/dev/fd/0' }), '/proc/self/fd/17');
  // ...and so does one that resolves to no absolute path (review M4): a relative answer would move the search
  assert.strictEqual(rgn.rgSpawnCwd('/proc/self/fd/17', { realpath: () => 'relative/dir' }), '/proc/self/fd/17');
  assert.strictEqual(rgn.rgSpawnCwd('/proc/self/fd/17', { realpath: () => '' }), '/proc/self/fd/17');
});
test('RG-SPAWN-CWD: rg spawned with cwd /proc/self/fd/N searches that directory, as the 2.1.283 bundle on Linux spawns it (both twins)', {
  skip: needUgrep.skip || (!fs.existsSync('/proc/self/fd') ? 'no /proc/self/fd on this host (the bundle passes such a cwd on Linux only)' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-spawn-cwd-')));
  const fd = fs.openSync(dir, 'r');
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'a needle\n');
    const cwd = `/proc/self/fd/${fd}`;
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    for (const argv of [['-l', '--null', 'needle', '.'], ['--json', 'needle', '.'], ['--files', '.']]) {
      const want = rgn.runRg(argv, { ...ctx, cwd: dir });
      const s = rgn.runRg(argv, { ...ctx, cwd });
      assert.deepStrictEqual([s.status, normalizeRg(s.stdout, argv)], [want.status, normalizeRg(want.stdout, argv)], `sync ${argv.join(' ')}: ${s.stderr}`);
      const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, encoding: 'buffer' }, (e, so, se) => res({ status: e ? e.code : 0, stdout: so, stderr: String(se) }), 'rg', ctx));
      assert.deepStrictEqual([a.status, normalizeRg(a.stdout, argv)], [want.status, normalizeRg(want.stdout, argv)], `async ${argv.join(' ')}: ${a.stderr}`);
    }
  } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
});

// RG-PID-FD (grep-native Task 11, found by the Linux end to end): for a single FILE, the 2.1.283 bundle on Linux names
// the file it holds open as `/proc/<its pid>/fd/N` (its Grep's content and count modes over src/app.js). That name is
// the same open file to every process that opens it, rg's child included, so it is a path like any other: classified
// by what it is (a regular file or a directory is searched; a FIFO, a terminal or a socket still refuses, by
// RG-SPECIAL-FILE). Only the names that are each process's OWN descriptors (/dev/stdin, /dev/fd/N,
// /proc/self/fd/N, /proc/thread-self/fd/N) stay refused by name: to native they are rg's child's own, to quaude's rg
// its caller's.
test('RG-PID-FD: /proc/<pid>/fd/N is classified by what it is; a process\'s own descriptor names refuse by name', () => {
  for (const p of ['/dev/stdin', '/dev/stdout', '/dev/fd/0', '/dev/fd/17', '/proc/self/fd/17', '/proc/thread-self/fd/3']) {
    assert.strictEqual(rgn.descriptorRefused(p), true, p);
  }
  for (const p of ['/proc/4242/fd/17', '/proc/1/fd/0', '/tmp/x', '/proc/4242/fdinfo/17']) assert.strictEqual(rgn.descriptorRefused(p), false, p);
});
test('RG-PID-FD: a file named /proc/<our pid>/fd/N is searched as the file it is, both twins (Linux)', {
  skip: needUgrep.skip || (!fs.existsSync(`/proc/${process.pid}/fd`) ? 'no /proc/<pid>/fd on this host (the bundle names files that way on Linux only)' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-pid-fd-')));
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, "const a = 1;\nreturn 'needle one';\n");
  const fd = fs.openSync(file, 'r');
  try {
    const named = `/proc/${process.pid}/fd/${fd}`;
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
    // -n and -c over one file print no path; --json's records name the path as given, so they are compared by
    // their matches (bytes_printed counts the path's own bytes)
    const view = (argv, b) => (argv[0] !== '--json' ? String(b) : String(b).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((m) => m.type === 'match').map((m) => ({ path: m.data.path.text, line: m.data.line_number, text: m.data.lines.text, sub: m.data.submatches })));
    for (const argv of [['-n', 'needle', named], ['-c', 'needle', named], ['--json', 'needle', named]]) {
      const real = argv.map((a) => (a === named ? file : a));
      const want = rgn.runRg(real, { ...ctx, cwd: dir });
      const wv = view(real, want.stdout);
      const expect = Array.isArray(wv) ? wv.map((m) => ({ ...m, path: named })) : wv;
      assert.ok(want.status === 0 && (Array.isArray(wv) ? wv.length === 1 : wv.length > 0), `the real path answers: ${want.stderr}`);
      const s = rgn.runRg(argv, { ...ctx, cwd: dir });
      assert.deepStrictEqual([s.status, view(argv, s.stdout)], [0, expect], `sync ${argv.join(' ')}: ${s.stderr}`);
      const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd: dir, encoding: 'buffer' }, (e, so, se) => res({ status: e ? e.code : 0, stdout: so, stderr: String(se) }), 'rg', ctx));
      assert.deepStrictEqual([a.status, view(argv, a.stdout)], [0, expect], `async ${argv.join(' ')}: ${a.stderr}`);
    }
    assert.strictEqual(rgn.runRg(['needle', `/proc/self/fd/${fd}`], { ...ctx, cwd: dir }).status, 2, '/proc/self/fd/N still refuses');
  } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
});

// 2.1.330's Grep/Glob consumer, on an rc-2 run with no output whose stderr passes its usage-error regex, runs the
// SAME argv again with --no-messages first, and throws its usage error only if that retry's stderr matches at
// offset 0 (rg-probe-gates reads both rules from the carve). So quaude's refusal must survive --no-messages
// unchanged: a refusal it silenced would turn the retry into "no results".
test('a refusal survives the consumer\'s --no-messages retry, byte for byte, still at offset 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-nomsg-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    for (const argv of [['--hidden', '--no-follow', '--null', '-l', '--pcre2', 'x', '.'], ['--files', '--null', '--glob', '[', '.']]) {
      const first = rgn.runRg(argv, { cwd: dir });
      const retry = rgn.runRg(['--no-messages', ...argv], { cwd: dir });
      assert.strictEqual(first.status, 2, argv.join(' '));
      assert.strictEqual(retry.status, 2, argv.join(' '));
      assert.strictEqual(String(retry.stderr), String(first.stderr), argv.join(' '));
      assert.match(String(retry.stderr), /^rg: error parsing (?:flag|glob)/, argv.join(' '));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
