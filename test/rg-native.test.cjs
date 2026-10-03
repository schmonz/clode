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
const { makeRgTree } = require('../scripts/lib/rg-probe.cjs');
const { tjsPath, runLoader } = require('./node-shim-helper.cjs');

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

test('ugrepMatches: ugrep failing (exit >= 2) is an error carrying its status and stderr, never "no matches"', needUgrep, () => {
  withTree('root', (dir) => {
    assert.throws(() => rgn.ugrepMatches(['a.txt', 'no-such-file.txt'], 'needle', { ugrep: UGREP, cwd: dir }),
      (e) => e.name === 'UgrepError' && e.status === 2 && /no-such-file/.test(e.stderr) && e.matches.get('a.txt').length === 4);
  });
});

test('parseUgrepRanges: path NUL start SP end LF records, linear, any bytes in the path', () => {
  const rec = (p, a, b) => Buffer.concat([Buffer.from(p), Buffer.from([0]), Buffer.from(`${a} ${b}\n`)]);
  const buf = Buffer.concat([rec('a', 1, 2), rec('x\ny', 0, 0), rec('a', 5, 9), rec('a', 9, 9), rec('a', 12, 12)]);
  const got = rgn.parseUgrepRanges(buf);
  assert.deepStrictEqual(asObj(got), { a: [[1, 2], [5, 9], [12, 12]], 'x\ny': [[0, 0]] });
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

// ---- the async twin, and the same plumbing under tjs -----------------------------------------
test('ugrepMatchesAsync answers what ugrepMatches does, and rejects as it throws', needUgrep, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-native-'));
  try {
    const dir = makeRgTree(path.join(base, 'root'), 'root');
    const sync = rgn.ugrepMatches(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir });
    const asyncGot = await rgn.ugrepMatchesAsync(ROOT_FILES, 'needle', { ugrep: UGREP, cwd: dir, argvBudget: 1 });
    assert.deepStrictEqual(asObj(asyncGot), asObj(sync));
    await assert.rejects(rgn.ugrepMatchesAsync(['a.txt', 'no-such-file.txt'], 'needle', { ugrep: UGREP, cwd: dir }),
      (e) => e.name === 'UgrepError' && e.status === 2);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('ugrepMatches and ugrepMatchesAsync under tjs: native\'s ranges', {
  skip: needUgrep.skip || (!tjsPath() ? 'no tjs engine' : false),
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
