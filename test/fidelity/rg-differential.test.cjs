'use strict';
// rg-differential: quaude's rg judged BYTE FOR BYTE against native Claude Code's EMBEDDED rg.
//
// WHAT IS JUDGED. Every argv upstream's Grep and Glob tools build (scripts/lib/rg-probe.cjs
// RG_MATRIX: 3 Grep output modes x their variants x both target forms, and Glob), over
// generated fixture trees that hold every class report-grep.md measured (makeRgTree: `root`, a
// git repo; `nogit`, ignore files without a repo; `bin2`, a NUL past rg's first 64 KiB read).
// Each cell runs twice:
//   native  the pinned provider's embedded rg, reached as upstream reaches it: the claude
//           binary spawned with argv0 `rg` and `--no-config` (runNativeRg)
//   ours    quaude's rg under tjs, THROUGH THE SAME INTERCEPTION THE BUNDLE HITS: bun-shim
//           loaded, `child_process.execFile(Bun.which('rg') ?? 'rg', argv, ...)` (runOursRg)
// and the two are compared on stdout bytes and exit code (compareRg), after exactly the three
// named normalizations compareRg owns (rg's nondeterministic parallel walk ORDER, the elapsed
// times in --json, and on x86_64 only `rg --version`'s CPU-read simd(runtime) line). Nothing else
// is forgiven.
//
// THE ONE WRITTEN PLATFORM DIVERGENCE (RG-MMAP-EVERYWHERE, user ruling 2026-10-04; stated once in
// scripts/lib/rg-probe.cjs MMAP_EVERYWHERE): quaude's rg answers a named binary as rg searching a memory
// map does on every host, where native rg on macOS reads it instead (a clause its own source calls a
// guess). On macOS the few cells where that differs (bin2's early.dat named, content mode) are judged
// against Linux native's recorded answer, and macOS native must still print its own recorded one; any
// other difference in them is a finding, as everywhere (the control plants both).
//
// THE ONE WRITTEN DIVERGENCE IN SCOPE. Rust regex and ugrep's regex dialect cannot be equal in
// general, so the matrix's patterns (`needle`, `one.beta`) come from the dialect both read the
// same way. A pattern the emulation can tell they would read differently is refused honestly
// (rc 2, the reason on stderr), never answered differently.
//
// RED BY DESIGN until the plan's Tasks 7-10 landed (green since Task 10, below). Task 4's baseline (2026-10-03, native 2.1.283 /
// ripgrep 14.1.1, darwin-arm64, ugrep 7.8.2): all 178 cells differed, 177 of them refused (--max-columns
// 76, --json 69, Glob's --null 18, --type 14) and rg --version answered by ugrep's own version.
// After Task 6 (quaude's rg answers -l, -c and the standard printer itself), measured the same way:
// 150 differ. Of the 90 files/count cells 28 are equal (none were); the 62 left are each in a later
// task's class: refused --type 14 and -U 16 (Tasks 9, 10), and answered differently 32, every one a
// walk or binary class report-grep measured (.git searched 8, .gitignore/.ignore precedence outside a
// repo 12, whitelist glob over .gitignore 4, brace glob 4: Task 9; a binary whose NUL lies past rg's
// first read, counted 4: Task 8). Glob (Task 10) is still refused, and --version still ugrep's (Task 9).
// After Task 7 (quaude's rg prints --json itself), measured the same way: 139 differ. Of the 69 content
// cells 11 are equal (none were); in each of the 58 left, every file record both sides print is
// byte-identical (stats included) except a binary's, and each differs only by a later task's class:
// .git searched 10, .gitignore/.ignore precedence 10, whitelist glob 4, brace glob 2, refused --type 7
// (Task 9); late.dat's binary quit 10, early.dat's convert mode 7 (Task 8); refused -U 8 (Task 10).
// After Task 8 (rg's binary detection): 118 differ. After Task 9 (rg's walk in JS: ignore rules, glob
// dialect, --type, order; --version from native), measured the same way: 42 of 184 differ (the six new
// cells are the -j1 walk cells, all equal), and every one is Task 10's: -U refused (8 files, 8 count, 8
// content) and Glob's --null refused (18). files 29 -> 8, count 29 -> 8, content 41 -> 8, --version 1 -> 0.
// After Task 10 (rg's multi-line searcher under -U, rg's own error for a \n without it, and --files with
// --sort=modified through rg's walk), measured the same way: 0 of 184 differ, ours refused none: GREEN, with only
// the named normalizations. Proved to bite (in place, restored byte for byte): a listing left unsorted names the
// 10 Glob cells whose order the sort decides; --multiline-dotall ignored names the 9 -U cells.
// The note tallies what ours refused, so each task's progress is visible in the verdict itself.
//
// WHERE IT RUNS: wherever a native provider, tjs and ugrep all exist. Otherwise it SKIPS
// naming which is missing (CI wiring is the plan's Task 11).
//
// FLOORS: cells per tree kind (KIND_FLOORS), each measured as the matrix stood when this was
// written; a kind under its floor makes the gate BROKEN naming the kind, because a verdict
// over a matrix missing a tree says nothing about what that tree is in it to judge. And cells
// NATIVE ANSWERED per kind (ANSWERED_FLOORS): a cell native leaves unanswered judges little.
// TRIPWIRE: an rg first on the PATH ours sees; a cell it answered is a finding of its own, and
// ours must have resolved rg to it (the absolute-path route).
// CONTROL: the full matrix, every pair equal, with ONE planted differing byte and ONE cell the
// tripwire answered.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const P = require('../../scripts/lib/rg-probe.cjs');
const { parseRgRefusal } = require('../../libexec/rg-native.cjs');
const { providerBin } = require('../provider-resolve.cjs');
const { tjsPath, resolveBin } = require('../node-shim-helper.cjs');

// Measured: RG_MATRIX's cells per tree kind: 21 Grep argv x 2 directory target forms plus 3
// Glob argv x 2 (2026-09-28); for bin2 the 21 Grep argv once more naming early.dat; for root
// the 12 stdin-branch argv and rg --version (2026-10-03); and in each, the two -j1 walk cells
// (RG-WALK-ORDER, 2026-10-04).
const KIND_FLOORS = { root: 63, nogit: 50, bin2: 71 };
const FLOOR = Object.values(KIND_FLOORS).reduce((a, b) => a + b, 0);
// ANSWERED FLOORS: per kind, the cells NATIVE answered: rc 0 with output (rg's "found"). A cell
// native answers rc 1 judges only that ours found nothing too (with --json that is a lone
// summary line), so a verdict needs enough answered cells to say anything about the bytes.
// Measured 2026-10-03 against native 2.1.283 on darwin-arm64, twice, the same both times: 123
// of the 178 cells (root's 47 = 34 + the 12 stdin cells + --version); with the -j1 walk cells
// (2026-10-04) 128 of 184 (root's -l and -c, nogit's -l and -c, bin2's -l: its -c counts nothing,
// a NUL squashing late.dat's count and early.dat holding no match before its NUL's fill).
const ANSWERED_FLOORS = { root: 49, nogit: 44, bin2: 35 };

// THE TRIPWIRE: an `rg` placed FIRST on the PATH ours sees, which prints this and exits 99.
// Bun.which('rg') then answers its absolute path, which is exactly the route on a host with
// ripgrep installed; if any call escaped quaude's rg, this mark shows. Native is the claude
// binary run by its own path, so the PATH entry never reaches it.
const TRIPWIRE_MARK = 'RG-DIFFERENTIAL-TRIPWIRE-HOST-RG-RAN';
const TRIPWIRE_RC = 99;

const res = (argv, stdout, status = 0) => ({ argv, status, signal: null, stdout: Buffer.from(stdout, 'latin1'), stderr: Buffer.alloc(0) });
const FILES = ['--hidden', '-l', '--null', 'needle', '.'];
const COUNT = ['--hidden', '-c', '-H', '--null', 'needle', '.'];
const JSON_ARGV = ['--hidden', '--json', '-n', 'needle', '.'];
const GLOB = ['--files', '--null', '--glob', '**/*.txt', '--sort=modified', '--no-ignore', '--hidden', '.'];

// Two --json runs of rg over the same tree, as native printed them (the shape of
// report-grep's native-evidence.txt): files in a different walk order, different elapsed.
const J1 = [
  '{"type":"begin","data":{"path":{"text":"./a.txt"}}}',
  '{"type":"match","data":{"path":{"text":"./a.txt"},"lines":{"text":"a needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}',
  '{"type":"end","data":{"path":{"text":"./a.txt"},"binary_offset":null,"stats":{"elapsed":{"secs":0,"nanos":11111,"human":"0.000011s"},"searches":1,"searches_with_match":1,"bytes_searched":9,"bytes_printed":245,"matched_lines":1,"matches":1}}}',
  '{"type":"begin","data":{"path":{"text":"./b.txt"}}}',
  '{"type":"match","data":{"path":{"text":"./b.txt"},"lines":{"text":"b needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}',
  '{"type":"end","data":{"path":{"text":"./b.txt"},"binary_offset":null,"stats":{"elapsed":{"secs":0,"nanos":22222,"human":"0.000022s"},"searches":1,"searches_with_match":1,"bytes_searched":9,"bytes_printed":245,"matched_lines":1,"matches":1}}}',
  '{"data":{"elapsed_total":{"human":"0.001339s","nanos":1339000,"secs":0},"stats":{"bytes_printed":490,"bytes_searched":18,"elapsed":{"human":"0.000033s","nanos":33333,"secs":0},"matched_lines":2,"matches":2,"searches":2,"searches_with_match":2}},"type":"summary"}',
];
const J2 = [J1[3], J1[4], J1[5].replace('22222', '99').replace('0.000022s', '0.000000s'), J1[0], J1[1], J1[2],
  J1[6].replace('1339000', '7').replace('0.001339s', '0.000000s')];
const lines = (a) => a.join('\n') + '\n';

test('compareRg: identical runs are the same', () => {
  assert.strictEqual(P.compareRg(res(FILES, 'a.txt\0b.txt\0'), res(FILES, 'a.txt\0b.txt\0')).same, true);
});

test('compareRg flags ONE differing byte', () => {
  const c = P.compareRg(res(FILES, 'a.txt\0b.txt\0'), res(FILES, 'a.txt\0c.txt\0'));
  assert.strictEqual(c.same, false);
  assert.match(c.why, /stdout differs at byte 6/);
});

test('compareRg flags a differing exit code, even with equal stdout', () => {
  const c = P.compareRg(res(FILES, '', 1), res(FILES, '', 2));
  assert.strictEqual(c.same, false);
  assert.match(c.why, /exit 1 vs 2/);
});

test('compareRg forgives rg\'s walk ORDER (named normalization 1): -l, -c and --json', () => {
  assert.strictEqual(P.compareRg(res(FILES, 'a.txt\0b.txt\0'), res(FILES, 'b.txt\0a.txt\0')).same, true);
  assert.strictEqual(P.compareRg(res(COUNT, 'a.txt\x003\nb.txt\x001\n'), res(COUNT, 'b.txt\x001\na.txt\x003\n')).same, true);
  assert.strictEqual(P.compareRg(res(JSON_ARGV, lines(J1)), res(JSON_ARGV, lines(J2))).same, true);
});

test('compareRg forgives elapsed times in --json (named normalization 2), and nothing else in a summary', () => {
  assert.strictEqual(P.compareRg(res(JSON_ARGV, lines(J1)), res(JSON_ARGV, lines(J2))).same, true);
  const otherStat = J2.slice(); otherStat[6] = otherStat[6].replace('"matches":2', '"matches":3');
  assert.strictEqual(P.compareRg(res(JSON_ARGV, lines(J1)), res(JSON_ARGV, lines(otherStat))).same, false);
});

// The last of --json, -l and -c is what rg prints (RG-ARGV): `--json -l` prints paths, so their order
// is forgiven as -l's, not looked for as JSON records (Task 7 review M2).
test('compareRg reads the printer from the LAST of --json, -l and -c', () => {
  assert.strictEqual(P.compareRg(res(['--json', '-l', 'needle', '.'], './a.txt\n./b.txt\n'), res(['--json', '-l', 'needle', '.'], './b.txt\n./a.txt\n')).same, true);
  assert.strictEqual(P.compareRg(res(['--json', '-c', 'needle', '.'], './a.txt:1\n./b.txt:2\n'), res(['--json', '-c', 'needle', '.'], './b.txt:2\n./a.txt:1\n')).same, true);
  assert.strictEqual(P.compareRg(res(['-l', '--json', 'needle', '.'], lines(J1)), res(['-l', '--json', 'needle', '.'], lines(J2))).same, true);
});

test('compareRg does not forgive order where rg promised one (--sort=modified)', () => {
  const c = P.compareRg(res(GLOB, 'a.txt\0b.txt\0'), res(GLOB, 'b.txt\0a.txt\0'));
  assert.strictEqual(c.same, false);
});

// RG-WALK-ORDER (ruling G15): rg on one thread walks depth first in readdir order, 20 of 20 on APFS and on
// overlayfs (grep-native Task 9), and quaude's rg walks the same; so under -j1 (in any spelling) order is
// judged, never forgiven.
test('compareRg does not forgive order where rg walks on one thread (-j1, -j 1, --threads=1, --threads 1)', () => {
  for (const j of [['-j1'], ['-j', '1'], ['--threads=1'], ['--threads', '1']]) {
    const argv = [...j, ...FILES];
    assert.strictEqual(P.compareRg(res(argv, 'a.txt\0b.txt\0'), res(argv, 'b.txt\0a.txt\0')).same, false, j.join(' '));
    assert.strictEqual(P.compareRg(res(argv, 'a.txt\0b.txt\0'), res(argv, 'a.txt\0b.txt\0')).same, true, j.join(' '));
  }
  // -j2 and -j0 (rg's default count) walk in parallel: still forgiven
  for (const j of [['-j2'], ['-j', '0']]) assert.strictEqual(P.compareRg(res([...j, ...FILES], 'a.txt\0b.txt\0'), res([...j, ...FILES], 'b.txt\0a.txt\0')).same, true, j.join(' '));
});

// NAMED NORMALIZATION 3 (controller ruling 2026-10-04, under the user's doctrine): `rg --version`'s
// simd(runtime) line on x86_64 ONLY (RG-VERSION-SIMD, libexec/rg-types.cjs: native reads the CPU there). The
// control: on x86_64 any other byte of --version still differs, and on aarch64 the runtime line is judged.
const VX = (runtime, head = 'ripgrep 14.1.1 (rev 7c1d0ed28a)') => `${head}\n\nfeatures:+pcre2\nsimd(compile):+SSE2,+SSSE3,-AVX2\nsimd(runtime):${runtime}\n\nPCRE2 10.45 is available (JIT is available)\n`;
test('compareRg forgives ONLY --version\'s simd(runtime) line, and only on x86_64 (named normalization 3)', () => {
  const V = ['--version'];
  assert.strictEqual(P.compareRg(res(V, VX('+SSE2,+SSSE3,+AVX2')), res(V, VX('+SSE2,+SSSE3,-AVX2')), { arch: 'x64' }).same, true);
  assert.strictEqual(P.compareRg(res(V, VX('+SSE2,+SSSE3,+AVX2', 'ripgrep 14.1.2 (rev 7c1d0ed28a)')), res(V, VX('+SSE2,+SSSE3,-AVX2')), { arch: 'x64' }).same, false);
  assert.strictEqual(P.compareRg(res(V, VX('+SSE2,+SSSE3,+AVX2').replace('-AVX2\nsimd(runtime)', '+AVX2\nsimd(runtime)')), res(V, VX('+SSE2,+SSSE3,-AVX2')), { arch: 'x64' }).same, false);
  assert.strictEqual(P.compareRg(res(V, VX('+NEON')), res(V, VX('-NEON')), { arch: 'arm64' }).same, false);
  // not --version: the same text in a search's output is judged
  assert.strictEqual(P.compareRg(res(['needle', '-'], VX('+AVX2')), res(['needle', '-'], VX('-AVX2')), { arch: 'x64' }).same, false);
});

test('compareRg: a record set that differs only by a MISSING record is not forgiven by the order normalization', () => {
  assert.strictEqual(P.compareRg(res(FILES, 'a.txt\0b.txt\0'), res(FILES, 'a.txt\0')).same, false);
  assert.strictEqual(P.compareRg(res(FILES, 'a.txt\0a.txt\0'), res(FILES, 'a.txt\0')).same, false);
});

// ---- the gate -------------------------------------------------------------------------------

function readCells() {
  if (!tjsPath()) return { skip: 'no tjs engine (set CLODE_TJS): ours runs under the engine quaude ships' };
  const bin = providerBin(process.env);
  if (!bin) {
    return { skip: 'no native Claude Code provider (CLODE_PROVIDER_BIN, or UPSTREAM_PIN\'s pinned version in the '
      + 'provider store): its embedded rg is the oracle' };
  }
  const version = P.nativeRgVersion(bin);
  if (!version) return { skip: `the provider ${bin} did not answer as rg (argv0 rg, --version): not runnable on this host` };
  const ugrep = process.env.CLODE_UGREP || resolveBin('ugrep');
  if (!ugrep) return { skip: 'no ugrep (CLODE_UGREP or PATH): quaude answers rg with the host ugrep, so there is no ours to judge' };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-differential-')));
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const trees = {};
    for (const kind of P.RG_TREE_KINDS) { trees[kind] = path.join(root, kind); P.makeRgTree(trees[kind], kind); }
    const trip = path.join(root, 'tripwire');
    fs.mkdirSync(trip);
    const tripRg = path.join(trip, 'rg');
    fs.writeFileSync(tripRg, `#!/bin/sh\necho ${TRIPWIRE_MARK} "$@"\nexit ${TRIPWIRE_RC}\n`, { mode: 0o755 });
    // Both sides get the same environment: a throwaway HOME (so no global gitignore or rg config
    // of this box's owner can reach either side), and a PATH that is the tripwire, then this
    // PATH (where ugrep lives).
    const env = { PATH: `${trip}${path.delimiter}${process.env.PATH}`, HOME: home };
    const cells = P.RG_MATRIX.map((c) => ({ ...c, cwd: trees[c.kind], argv: P.cellArgv(c, trees[c.kind]), input: P.cellInput(c) }));
    const native = cells.map((c) => P.runNativeRg(bin, c.argv, c.cwd, { env, input: c.input }));
    const ours = P.runOursRgBatch(cells.map((c) => ({ argv: c.argv, cwd: c.cwd, input: c.input })), { env });
    return {
      cells: cells.map((c, i) => ({ id: c.id, kind: c.kind, tree: c.cwd, argv: c.argv, native: native[i], ours: ours[i] })),
      platform: process.platform,
      floors: KIND_FLOORS, answeredFloors: ANSWERED_FLOORS, tripwire: tripRg, rgPath: ours.length ? ours[0].rgPath : null,
      what: `native ${bin} (${version.split('\n')[0]}) vs ours under tjs over ${ugrep}`,
    };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// What ours refused, tallied by the flag its refusal named, or by what the applet said when it
// rejected the translation (`ugrep: invalid option --max-columns`): the progress meter the later
// tasks read off the verdict. Refusals are on ours' stderr in rgRefusal's spelling.
function refusalTally(cells) {
  const t = new Map();
  for (const c of cells) {
    const m = parseRgRefusal(c.ours.stderr);
    if (!m) continue;
    const said = /rejected this search \((?:\w+: )?([^,)]*)/.exec(m.reason);
    const key = m.flag ? m.flag : said ? `rejected: ${said[1].trim()}` : m.reason.replace(/[;(].*$/, '').trim();
    t.set(key, (t.get(key) || 0) + 1);
  }
  return [...t].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', ') || 'none';
}

function scanCells({ cells, floors, answeredFloors, tripwire, rgPath, what, platform }) {
  const per = {}, answered = {};
  for (const c of cells) {
    per[c.kind] = (per[c.kind] || 0) + 1;
    if (c.native.status === 0 && c.native.stdout && c.native.stdout.length) answered[c.kind] = (answered[c.kind] || 0) + 1;
  }
  const short = [
    ...Object.entries(floors).filter(([k, f]) => (per[k] || 0) < f)
      .map(([k, f]) => `the ${k} tree has ${per[k] || 0} cells, under its floor of ${f}`),
    ...Object.entries(answeredFloors).filter(([k, f]) => (answered[k] || 0) < f)
      .map(([k, f]) => `the ${k} tree has ${answered[k] || 0} cells native answered, under its floor of ${f}`),
  ];
  if (short.length) return { examined: 0, findings: short, note: `${what}; ${short.join('; ')}` };
  const findings = [];
  if (rgPath !== tripwire) {
    findings.push(`Bun.which('rg') answered ${JSON.stringify(rgPath)}, not the tripwire ${tripwire}: the absolute-path route a `
      + 'host with ripgrep takes went unexercised');
  }
  for (const c of cells) {
    const said = Buffer.concat([c.ours.stdout || Buffer.alloc(0), c.ours.stderr || Buffer.alloc(0)]).toString('latin1');
    if (said.includes(TRIPWIRE_MARK) || c.ours.status === TRIPWIRE_RC) {
      findings.push(`${c.id}: ours ran a HOST rg (the tripwire answered, rc ${c.ours.status}), not quaude's rg`);
      continue;
    }
    // RG-MMAP-EVERYWHERE: on macOS, the excepted cells are judged against Linux native's recorded answer.
    const ex = P.mmapEverywhere(c.id, c.native, c.argv || c.native.argv || [], c.tree, platform);
    if (ex && ex.stale) findings.push(`${c.id}: ${ex.stale}`);
    const d = P.compareRg(ex ? ex.expected : c.native, c.ours);
    if (!d.same) findings.push(`${c.id}: ${d.why}${ex ? ` (${P.MMAP_EVERYWHERE.rule}: judged against Linux native's answer)` : ''}`);
  }
  const kinds = Object.keys(floors).map((k) => `${k} ${per[k]} (native answered ${answered[k] || 0})`).join(', ');
  return { examined: cells.length, findings,
    note: `${what}; ${cells.length} cells (${kinds}); ${findings.length} differ; ours refused: ${refusalTally(cells)}` };
}

// The full matrix on macOS, every pair equal (an RG-MMAP-EVERYWHERE cell: native printing its recorded
// macOS answer, ours Linux native's) and ours resolved to the tripwire; then (`defects`) ONE byte of one
// cell's stdout changed, one other cell answered by the tripwire (a host rg), and in the excepted cells
// one byte of ours changed and native printing other than its recorded answer: what the exception must
// never hide.
const EXCEPTED = Object.keys(P.MMAP_EVERYWHERE.cells);
function controlCells({ defects = true } = {}) {
  const cells = P.RG_MATRIX.map((c) => {
    const argv = P.cellArgv(c, '/tree'), rec = P.MMAP_EVERYWHERE.cells[c.id];
    if (rec) {
      const at = (r) => ({ argv, status: r.status, signal: null, stdout: P.inTree(r.stdout, '/tree'), stderr: Buffer.alloc(0) });
      return { id: c.id, kind: c.kind, tree: '/tree', argv, native: at(rec.macos), ours: at(rec.linux) };
    }
    const r = res(argv, 'a.txt\0');
    return { id: c.id, kind: c.kind, tree: '/tree', argv, native: r, ours: { ...r } };
  });
  const base = { cells, floors: KIND_FLOORS, answeredFloors: ANSWERED_FLOORS, tripwire: '/trip/rg', rgPath: '/trip/rg', what: 'synthetic control', platform: 'darwin' };
  if (!defects) return base;
  const plain = cells.filter((x) => !P.MMAP_EVERYWHERE.cells[x.id]);
  const k = plain[Math.floor(plain.length / 2)];
  const planted = Buffer.from(k.ours.stdout); planted[0] ^= 1;
  k.ours = { ...k.ours, stdout: planted };
  plain[1].ours = { ...plain[1].ours, status: TRIPWIRE_RC, stdout: Buffer.from(`${TRIPWIRE_MARK} --hidden\n`) };
  const [e1, e2] = EXCEPTED.map((id) => cells.find((x) => x.id === id));
  const o = Buffer.from(e1.ours.stdout); o[o.length - 2] ^= 1;
  e1.ours = { ...e1.ours, stdout: o };
  e2.native = { ...e2.native, stdout: Buffer.concat([e2.native.stdout, Buffer.from('x')]) };
  return base;
}

const guard = defineGuard({ name: 'rg-differential', floor: FLOOR, read: readCells, scan: scanCells, control: controlCells });
guardTests(guard);

test('a tree kind under its floor makes rg-differential BROKEN, naming the kind', () => {
  const r = checkGate({ name: 'floor-probe', floor: guard.floor,
    read: () => { const c = controlCells(); c.cells = c.cells.filter((x) => x.kind !== 'bin2'); return c; },
    scan: scanCells });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, /the bin2 tree has 0 cells, under its floor of 71/);
});

test('RG_MATRIX holds every kind at or above its floor, and each cell id once', () => {
  const per = {};
  for (const c of P.RG_MATRIX) per[c.kind] = (per[c.kind] || 0) + 1;
  assert.deepStrictEqual(Object.keys(per).sort(), Object.keys(KIND_FLOORS).sort());
  for (const [k, f] of Object.entries(KIND_FLOORS)) assert.ok(per[k] >= f, `${k}: ${per[k]} cells, floor ${f}`);
  assert.strictEqual(new Set(P.RG_MATRIX.map((c) => c.id)).size, P.RG_MATRIX.length);
});

// THE TRIPWIRE. Ours sees a PATH whose first entry holds an `rg` that prints TRIPWIRE_MARK and
// exits 99, so Bun.which('rg') answers its ABSOLUTE path (the route a host with ripgrep takes)
// and any rg call that escaped quaude's rg would show the mark. A cell where it shows is its own
// finding, whatever native printed.
test('a cell where the tripwire rg ran is a finding naming it, even when the bytes happen to agree', () => {
  const c = controlCells({ defects: false });
  const k = 3;
  c.cells[k].ours = { ...c.cells[k].ours, status: TRIPWIRE_RC, stderr: Buffer.from(`${TRIPWIRE_MARK} --hidden\n`) };
  const r = scanCells(c);
  assert.deepStrictEqual(r.findings, [`${c.cells[k].id}: ours ran a HOST rg (the tripwire answered, rc 99), not quaude's rg`]);
});

test('ours that did not resolve rg to the tripwire is a finding: the absolute-path route went unexercised', () => {
  const c = controlCells({ defects: false });
  c.rgPath = 'rg';
  const r = scanCells(c);
  assert.ok(r.findings.some((f) => /Bun\.which\('rg'\) answered "rg", not the tripwire/.test(f)), r.findings.join('\n'));
});

test('the control plants one differing byte AND one tripwire hit, and the gate names both', () => {
  const r = scanCells(controlCells());
  assert.strictEqual(r.findings.length, 4, r.findings.join('\n'));
  assert.ok(r.findings.some((f) => /stdout differs at byte 0/.test(f)));
  assert.ok(r.findings.some((f) => /ours ran a HOST rg \(the tripwire answered/.test(f)));
});

// RG-MMAP-EVERYWHERE hides nothing else: with every pair equal the matrix is clean on macOS; one byte of
// ours off Linux native's answer in an excepted cell is a finding, and so is macOS native drifting from its
// recorded answer; off macOS nothing is excepted (ours is judged against native as it ran).
test('RG-MMAP-EVERYWHERE: equal pairs are clean; a byte off in ours, or native off its record, is a finding', () => {
  assert.deepStrictEqual(scanCells(controlCells({ defects: false })).findings, []);
  const r = scanCells(controlCells());
  assert.ok(r.findings.some((f) => f.startsWith(`${EXCEPTED[0]}: stdout differs at byte`) && /RG-MMAP-EVERYWHERE: judged against Linux native/.test(f)), r.findings.join('\n'));
  assert.ok(r.findings.some((f) => f.startsWith(`${EXCEPTED[1]}: RG-MMAP-EVERYWHERE's record of native macOS no longer holds`)), r.findings.join('\n'));
  const lin = controlCells({ defects: false });
  lin.platform = 'linux';
  assert.deepStrictEqual(scanCells(lin).findings.map((f) => f.split(':')[0]).sort(), EXCEPTED.slice().sort());
});

// inTree spells a recorded literal in a real tree as native would print it there: the path JSON-escaped
// (serde: `"` and `\` escaped, non-ASCII as its UTF-8 bytes) and bytes_printed counted in BYTES. A tree
// whose path holds a quote or a non-ASCII letter must not make a false finding (Task 8 re-review nit).
const ODD_TREE = `/tmp/caf${String.fromCodePoint(0xe9)} "q\\x`;
test('RG-MMAP-EVERYWHERE: inTree JSON-escapes the tree and counts bytes_printed in bytes', () => {
  for (const id of EXCEPTED) {
    for (const side of ['macos', 'linux']) {
      const lines = P.inTree(P.MMAP_EVERYWHERE.cells[id][side].stdout, ODD_TREE).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      let printed = 0;
      const raw = P.inTree(P.MMAP_EVERYWHERE.cells[id][side].stdout, ODD_TREE);
      const rawLines = raw.toString('latin1').split('\n');
      lines.forEach((m, i) => {
        if (m.type === 'begin' || m.type === 'match' || m.type === 'context') {
          assert.strictEqual(m.data.path.text, `${ODD_TREE}/early.dat`, `${id} ${side}`);
          printed += rawLines[i].length + 1;     // latin1: one char per BYTE
        }
        if (m.type === 'end') assert.strictEqual(m.data.stats.bytes_printed, printed, `${id} ${side}: bytes_printed`);
        if (m.type === 'summary') assert.strictEqual(m.data.stats.bytes_printed, printed, `${id} ${side}: summary bytes_printed`);
      });
    }
  }
});
// ...and native agrees: macOS native over bin2 in such a tree prints exactly its record spelled there.
test('RG-MMAP-EVERYWHERE: macOS native in a tree with a quote and a non-ASCII letter prints its record as inTree spells it (native, macOS)',
  { skip: process.platform !== 'darwin' ? 'macOS only' : !providerBin(process.env) ? 'no native provider' : false }, () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-intree-')));
    try {
      const tree = path.join(base, `caf${String.fromCodePoint(0xe9)} "q\\x`);
      P.makeRgTree(tree, 'bin2');
      const id = EXCEPTED[0], cell = P.RG_MATRIX.find((c) => c.id === id);
      const argv = P.cellArgv(cell, tree);
      const native = P.runNativeRg(providerBin(process.env), argv, tree, { env: { HOME: base } });
      const ex = P.mmapEverywhere(id, native, argv, tree, 'darwin');
      assert.strictEqual(ex.stale, null);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

test('RG-MMAP-EVERYWHERE excepts only RG_MATRIX cells, only named-binary content cells, and only where macOS and Linux differ', () => {
  const ids = new Set(P.RG_MATRIX.map((c) => c.id));
  assert.ok(EXCEPTED.length >= 1);
  for (const id of EXCEPTED) {
    assert.ok(ids.has(id), `${id} is not a cell`);
    assert.match(id, /^bin2 Grep content .* early\.dat$/);
    const rec = P.MMAP_EVERYWHERE.cells[id];
    assert.notDeepStrictEqual(rec.macos, rec.linux, `${id}: macOS and Linux agree, so it needs no exception`);
  }
});

// ANSWERED FLOORS. A cell where native printed nothing (rc 1) judges only that ours printed
// nothing too; a matrix whose cells mostly go unanswered says little about the bytes.
test('a tree kind with too few cells native ANSWERED makes rg-differential BROKEN, naming the kind', () => {
  const c = controlCells();
  for (const x of c.cells) if (x.kind === 'nogit') { x.native = { ...x.native, stdout: Buffer.alloc(0), status: 1 }; x.ours = { ...x.native }; }
  const r = checkGate({ name: 'answered-probe', floor: guard.floor, read: () => c, scan: scanCells });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, /the nogit tree has 0 cells native answered, under its floor of \d+/);
});

// THE STDIN BRANCH. For a task-output file the Grep tool searches target `-` and pipes the file
// into rg's stdin, after dropping every --glob (2.1.283's `_In`: `zOt`, `Tan`, the --glob splice);
// a --glob or --type parameter makes it skip the search, so only the other variants reach rg.
test('RG_MATRIX carries the stdin branch: target -, no --glob, the input bytes, every mode', () => {
  const stdin = P.RG_MATRIX.filter((c) => c.target === 'STDIN');
  assert.ok(stdin.length >= 12, `${stdin.length} stdin cells`);
  assert.deepStrictEqual([...new Set(stdin.map((c) => c.spec.mode))].sort(), ['content', 'count', 'files_with_matches']);
  for (const c of stdin) {
    const argv = P.cellArgv(c, '/tree');
    assert.strictEqual(argv[argv.length - 1], '-', c.id);
    assert.ok(!argv.includes('--glob') && !argv.includes('--type'), `${c.id}: ${argv.join(' ')}`);
    assert.ok(Buffer.isBuffer(P.cellInput(c)) && P.cellInput(c).length > 0, c.id);
  }
});

// rg --version: the bundle's first-use probe reads it (startsWith('ripgrep ')) for /doctor.
test('RG_MATRIX carries rg --version', () => {
  assert.ok(P.RG_MATRIX.some((c) => P.cellArgv(c, '/tree').join(' ') === '--version'));
});

// rg reads ignore rules from a tree's ANCESTORS too (a .git dir makes it a repo; .ignore and
// .rgignore apply from above), so a fixture written under one (a tmpdir inside a checkout)
// would measure something else. makeRgTree refuses such a place, naming what it found.
test('makeRgTree refuses a tree whose ancestor holds .git, .ignore or .rgignore', () => {
  for (const marker of ['.git', '.ignore', '.rgignore']) {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ancestor-')));
    try {
      if (marker === '.git') fs.mkdirSync(path.join(d, marker)); else fs.writeFileSync(path.join(d, marker), 'x\n');
      assert.throws(() => P.makeRgTree(path.join(d, 'deep', 'nogit'), 'nogit'), new RegExp(marker.replace('.', '\\.')));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

module.exports = { readCells, scanCells, controlCells, KIND_FLOORS, ANSWERED_FLOORS };
