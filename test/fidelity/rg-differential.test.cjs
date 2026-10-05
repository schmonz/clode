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
// general, so the matrix's patterns (`needle`, `one.beta`, `needle.`, `^\w`, `ab|^c.d`) come from the dialect both read the
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
// TRIPWIRE: an rg first on the PATH ours sees; a cell it answered is a finding of its own. And
// Bun.which('rg') must answer quaude's OWN absolute rg path (bun-shim RG_PATH, grep-native Task 10b),
// never the tripwire's, with no file there: the bundle then takes native's route (an absolute rg:
// target `.`, the directory as cwd), whatever the host's PATH holds.
// CONTROL: the full matrix, every pair equal, with ONE planted differing byte and ONE cell the
// tripwire answered.
//
// THE BASH ROUTE (grep-native Task 10c, user ruling 2026-10-04: the Bash tool's `rg` is quaude's tested rg). Native's
// snapshot defines `rg`, inside upstream's "is rg installed?" guard, as a shell function that runs the claude binary
// as rg; quaude's is that same function run against quaude, which answers as rg (libexec/rg-entry.cjs) before its
// bundle loads. So every cell runs a second way, per shell (bash, and zsh where installed): the shell sources the
// snapshot and runs `rg <argv>` as the Bash tool does (`< /dev/null`; a stdin cell pipes its input), with a PATH
// holding no rg and CLAUDE_CODE_EXECPATH naming the binary, as the bundle sets it:
//   native  native's own snapshot (test/fixtures/snapshot-2.1.283.sh), against the pinned provider
//   ours    quaude's snapshot as its writer emits it, through bun-shim's real interception, against a quaude BUILT
//           from this tree (test/built-binary.cjs), so the bootstrap's rg dispatch is what is judged
// plus BASH_ROWS (scripts/lib/rg-probe.cjs): what a model types that the Grep tool never builds (no path, -c with
// zero-count files, -l, --json, -U, the walk's order under -j1, a pipe into rg). Each pair is judged by compareRg as
// above. The instrument is checked too: native's Bash route must answer every matrix cell as native's rg answered
// it, or a broken shell function on both sides would read as agreement. And with a host rg installed (the
// tripwire first on PATH), the Bash tool's `rg` must be the host's, for native and ours alike, in normal mode and
// with --allowedTools naming Grep or Glob (no find/grep shadows), as native's guard makes it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const P = require('../../scripts/lib/rg-probe.cjs');
const { parseRgRefusal } = require('../../libexec/rg-native.cjs');
const { providerBin, rgOracle, rgOracleSkip } = require('../provider-resolve.cjs');
const { tjsPath, resolveBin } = require('../node-shim-helper.cjs');
const { builtQuaude, builtNaude } = require('../built-binary.cjs');

// Measured: RG_MATRIX's cells per tree kind: 21 Grep argv x 2 directory target forms plus 3
// Glob argv x 2 (2026-09-28); for bin2 the 21 Grep argv once more naming early.dat; for root
// the 12 stdin-branch argv and rg --version (2026-10-03); and in each, the two -j1 walk cells
// (RG-WALK-ORDER, 2026-10-04).
// And (Task 10 fix round, 2026-10-04) the three -U variants (`needle.`, `^\w`, `ab|^c.d`: 6 cells a kind, 9 for
// bin2, 6 stdin for root).
const KIND_FLOORS = { root: 87, nogit: 68, bin2: 98 };
const FLOOR = Object.values(KIND_FLOORS).reduce((a, b) => a + b, 0);
// ANSWERED FLOORS: per kind, the cells NATIVE answered: rc 0 with output (rg's "found"). A cell
// native answers rc 1 judges only that ours found nothing too (with --json that is a lone
// summary line), so a verdict needs enough answered cells to say anything about the bytes.
// Measured 2026-10-03 against native 2.1.283 on darwin-arm64, twice, the same both times: 123
// of the 178 cells (root's 47 = 34 + the 12 stdin cells + --version); with the -j1 walk cells
// (2026-10-04) 128 of 184 (root's -l and -c, nogit's -l and -c, bin2's -l: its -c counts nothing,
// a NUL squashing late.dat's count and early.dat holding no match before its NUL's fill).
// With the -U variants (Task 10 fix round, 2026-10-04): 182 of 253.
const ANSWERED_FLOORS = { root: 73, nogit: 56, bin2: 53 };
// THE BASH ROUTE's floors, per shell: every matrix cell plus every BASH_CELLS row (14 a tree kind, 2026-10-04) and the
// 4 BASH_IO rows (review I-1; the slow writer, fix round 2); the BASH_CELLS rows native answered (measured 2026-10-04,
// native 2.1.283, darwin-arm64: 35 of 42, both shells alike; root 13, nogit 12, bin2 10 of 14 each); and the built
// naude's rows (root's 14 + the 4 I/O rows, review M-5).
const BASH_FLOOR = FLOOR + 42 + 4;
const BASH_ANSWERED_FLOOR = 35;
const NAUDE_FLOOR = 14 + 4;

// THE TRIPWIRE: an `rg` placed FIRST on the PATH ours sees, which prints this and exits 99. Until
// grep-native Task 10b, Bun.which('rg') then answered ITS absolute path (the route a host with
// ripgrep took); now it answers quaude's own path whatever PATH holds, and the gate holds it to
// that. Either way, if any call escaped quaude's rg, this mark shows. Native is the claude binary
// run by its own path, so the PATH entry never reaches it.
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

// The standard printer with --null (2.1.283's environment scan eo(): `-o -H --null ... .`) walks in parallel too, and
// prints each file's lines together, `path\0` first on each (measured 2026-10-05 in an ubuntu:24.04 container: native's
// order over the envscan tree differed from this Mac's): each file's run of lines is ONE record (normalization 1). The
// lines inside a file, and the run's own bytes, are still judged; without --null a path cannot be told from its line
// (`a:b:c`), so the standard printer's order is judged there.
const STD_NULL = ['-o', '-H', '--null', 'needle', '.'];
test('compareRg forgives walk order for the standard printer with --null, a file\'s run of lines as one record', () => {
  const A = './a.txt\x00needle\n./a.txt\x00needle\n', B = './b.txt\x00needle\n';
  assert.strictEqual(P.compareRg(res(STD_NULL, A + B), res(STD_NULL, B + A)).same, true);
  // a file's own lines keep their order, and are not shuffled with another file's
  assert.strictEqual(P.compareRg(res(STD_NULL, './a.txt\x00one\n./a.txt\x00two\n'), res(STD_NULL, './a.txt\x00two\n./a.txt\x00one\n')).same, false);
  assert.strictEqual(P.compareRg(res(STD_NULL, A + B), res(STD_NULL, './a.txt\x00needle\n' + B + './a.txt\x00needle\n')).same, false);
  // judged where rg promised an order, and without --null
  assert.strictEqual(P.compareRg(res(['-j1', ...STD_NULL], A + B), res(['-j1', ...STD_NULL], B + A)).same, false);
  const H = ['-o', '-H', 'needle', '.'];
  assert.strictEqual(P.compareRg(res(H, './a.txt:needle\n./b.txt:needle\n'), res(H, './b.txt:needle\n./a.txt:needle\n')).same, false);
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
    const bash = bashRoute({ root, trees, bin, ugrep, home, tripDir: trip, cells });
    return {
      cells: cells.map((c, i) => ({ id: c.id, kind: c.kind, tree: c.cwd, argv: c.argv, native: native[i], ours: ours[i], bash: bash.matrix && bash.matrix[i] })),
      bash: { shells: bash.shells, cells: bash.cells, tripwire: bash.tripwire, unavailable: bash.unavailable, floor: BASH_FLOOR, answeredFloor: BASH_ANSWERED_FLOOR,
        naudeFloor: NAUDE_FLOOR },
      platform: process.platform,
      floors: KIND_FLOORS, answeredFloors: ANSWERED_FLOORS, tripwire: tripRg, rgPath: ours.length ? ours[0].rgPath : null,
      ownRgPath: ours.length ? ours[0].ownRgPath : null, rgPathExists: !!(ours.length && ours[0].ownRgPath && fs.existsSync(ours[0].ownRgPath)),
      what: `native ${bin} (${version.split('\n')[0]}) vs ours under tjs over ${ugrep}`,
    };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// THE BASH ROUTE: the matrix cells and BASH_CELLS through each shell's snapshot, native's and ours; then the
// tripwire rows. { shells, matrix: per cell { [shell]: { native, ours } }, cells: BASH_CELLS with the same,
// tripwire: [{ shell, mode, side, ran }] } or { unavailable: why } when there is no quaude to run.
function bashRoute({ root, trees, bin, ugrep, home, tripDir, cells }) {
  const q = builtQuaude();
  if (!q.path) return { unavailable: `no quaude built from this tree to run as rg (${q.skip})` };
  const nd = builtNaude();
  if (!nd.path) return { unavailable: `no naude built from this tree to run as rg (${nd.skip})` };
  const shells = [['bash', resolveBin('bash')], ['zsh', resolveBin('zsh')]].filter(([, b]) => b);
  if (!shells.some(([n]) => n === 'bash')) return { unavailable: 'no bash on this host' };
  const dir = path.join(root, 'bash-route');
  fs.mkdirSync(dir);
  // A PATH with no rg in it (the guard's "no host rg" branch); ugrep is named by CLODE_UGREP.
  const noRg = (process.env.PATH || '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'rg'))).join(path.delimiter);
  const env = { HOME: home, PATH: noRg, CLODE_UGREP: ugrep };
  const routes = [];
  for (const [name, shellBin] of shells) {
    routes.push({ name: `native ${name}`, shellName: name, shellBin, execPath: bin, snapshot: P.writeNativeSnapshot(path.join(dir, `native-${name}.sh`)) });
    routes.push({ name: `ours ${name}`, shellName: name, shellBin, execPath: q.path, snapshot: P.writeQuaudeSnapshot(path.join(dir, `ours-${name}.sh`), shellBin) });
  }
  const io = P.bashIoCells(trees.root, P.writeBigFile(path.join(dir, 'big.txt')));
  const bashCells = [...P.BASH_CELLS.map((c) => ({ ...c, cwd: trees[c.kind] })), ...io];
  const all = [...cells.map((c) => ({ argv: c.argv, cwd: c.cwd, input: c.input })), ...bashCells];
  const got = P.runBashRoutes(routes, all, { env, dir: path.join(dir, 'runs') });
  const pick = (i) => Object.fromEntries(shells.map(([name], si) => [name, { native: got[2 * si][i], ours: got[2 * si + 1][i] }]));
  // A BUILT NAUDE (review M-5) through bash, the same snapshot (its function runs CLAUDE_CODE_EXECPATH): root's
  // BASH_ROWS and the I/O rows, judged against native's bash route above.
  const naudeCells = bashCells.filter((c) => c.kind === 'root');
  const ng = P.runBashRoutes([{ name: 'naude bash', shellName: 'bash', shellBin: shells[0][1], execPath: nd.path, snapshot: routes[1].snapshot }],
    naudeCells, { env, dir: path.join(dir, 'naude-runs') })[0];
  // The tripwire rows: a host rg first on PATH, each snapshot in each mode, `rg needle .` once.
  const trip = [];
  for (const [name, shellBin] of shells) {
    for (const mode of ['normal', 'optin']) {
      trip.push({ name, shellName: name, mode, side: 'native', shellBin, execPath: bin, snapshot: P.writeNativeSnapshot(path.join(dir, `trip-native-${name}-${mode}.sh`), { mode }) });
      trip.push({ name, shellName: name, mode, side: 'ours', shellBin, execPath: q.path, snapshot: P.writeQuaudeSnapshot(path.join(dir, `trip-ours-${name}-${mode}.sh`), shellBin, { mode }) });
    }
  }
  const tripGot = P.runBashRoutes(trip, [{ argv: ['needle', '.'], cwd: trees.root, input: null }],
    { env: { ...env, PATH: `${tripDir}${path.delimiter}${noRg}` }, dir: path.join(dir, 'trip') });
  return {
    shells: shells.map(([n]) => n),
    matrix: cells.map((c, i) => pick(i)),
    cells: bashCells.map((c, j) => {
      const k = naudeCells.indexOf(c);
      return { id: c.id, kind: c.kind, io: !!c.io, tree: c.cwd, argv: c.argv, bash: pick(cells.length + j), naude: k === -1 ? null : ng[k] };
    }),
    tripwire: trip.map((t, k) => ({ shell: t.name, mode: t.mode, side: t.side,
      ran: tripGot[k][0].status === TRIPWIRE_RC && tripGot[k][0].stdout.toString('latin1').includes(TRIPWIRE_MARK) })),
  };
}

// An I/O row is judged on stdout, stderr and status, unnormalized (rg's own output in it is a single line or none).
function compareIo(a, b) {
  const why = [];
  for (const k of ['status', 'stdout', 'stderr']) {
    const x = k === 'status' ? a[k] : Buffer.from(a[k] || '').toString('latin1'), y = k === 'status' ? b[k] : Buffer.from(b[k] || '').toString('latin1');
    if (x !== y) why.push(`${k} ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  }
  return { same: why.length === 0, why: why.join('; ') };
}

// The Bash route's findings: a shell short of its floor (BROKEN, with the short list), a pair that differs, native's
// Bash route not answering as native's rg (the instrument), a host rg that did not answer, and the built naude's rows.
function scanBash(cells, bash, platform) {
  const short = [], findings = [];
  if (!bash) return { short: ['the Bash route never ran'], findings };
  if (bash.unavailable) return { short: [`the Bash route cannot run: ${bash.unavailable}`], findings };
  const rows = [...cells.map((c) => ({ ...c, matrix: true })), ...bash.cells];
  for (const shell of bash.shells) {
    const have = rows.filter((c) => c.bash && c.bash[shell]);
    if (have.length < bash.floor) short.push(`the Bash route through ${shell} has ${have.length} cells, under its floor of ${bash.floor}`);
    const answered = bash.cells.filter((c) => !c.io && c.bash && c.bash[shell] && c.bash[shell].native.status === 0 && c.bash[shell].native.stdout.length).length;
    if (answered < bash.answeredFloor) short.push(`the Bash route through ${shell} has ${answered} BASH_ROWS cells native answered, under its floor of ${bash.answeredFloor}`);
  }
  const naudeRows = bash.cells.filter((c) => c.naude);
  if (naudeRows.length < bash.naudeFloor) short.push(`the built naude ran ${naudeRows.length} Bash route cells, under its floor of ${bash.naudeFloor}`);
  if (!bash.shells.includes('bash')) short.push('the Bash route did not run through bash');
  if (short.length) return { short, findings };
  for (const shell of bash.shells) {
    for (const c of rows) {
      const b = c.bash[shell];
      const where = `${c.id} [Bash route, ${shell}]`;
      if (c.matrix) {
        const inst = P.compareRg(c.native, b.native);
        if (!inst.same) { findings.push(`${where}: native's Bash route did not answer as native's rg (${inst.why})`); continue; }
      }
      const ex = c.matrix ? P.mmapEverywhere(c.id, b.native, c.argv || [], c.tree, platform) : null;
      const d = c.io ? compareIo(b.native, b.ours) : P.compareRg(ex ? ex.expected : b.native, b.ours);
      if (!d.same) findings.push(`${where}: ${d.why}${ex ? ` (${P.MMAP_EVERYWHERE.rule}: judged against Linux native's answer)` : ''}`);
    }
  }
  for (const c of naudeRows) {
    const d = c.io ? compareIo(c.bash.bash.native, c.naude) : P.compareRg(c.bash.bash.native, c.naude);
    if (!d.same) findings.push(`${c.id} [Bash route, bash, built naude]: ${d.why}`);
  }
  for (const t of bash.tripwire) {
    if (!t.ran) findings.push(`[Bash route, ${t.shell}, ${t.mode === 'optin' ? 'searchToolsOptIn' : 'normal mode'}] with a host rg installed, ${t.side}'s Bash \`rg\` did not run it (native's guard leaves rg to the host's)`);
  }
  if (bash.tripwire.length < 4 * bash.shells.length) short.push(`the Bash route ran ${bash.tripwire.length} tripwire rows, not ${4 * bash.shells.length}`);
  return { short, findings };
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

function scanCells({ cells, floors, answeredFloors, tripwire, rgPath, ownRgPath, rgPathExists, what, platform, bash }) {
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
  const B = scanBash(cells, bash, platform);
  short.push(...B.short);
  if (short.length) return { examined: 0, findings: short, note: `${what}; ${short.join('; ')}` };
  const findings = [...B.findings];
  // quaude's own rg (grep-native Task 10b): absolute, named rg, the path bun-shim states (RG_PATH), never the tripwire's, and
  // no file there. A bare `rg` sends the bundle's Grep tool down the refusing route outside the working directory.
  const ownSpelled = typeof rgPath === 'string' && /^\//.test(rgPath.replace(/^[A-Za-z]:[\\/]/, '/')) && /^rg(?:\.exe)?$/.test(rgPath.split(/[\\/]/).pop());
  if (rgPath !== ownRgPath || !ownSpelled || rgPath === tripwire) {
    findings.push(`Bun.which('rg') answered ${JSON.stringify(rgPath)}, not quaude's own absolute rg ${JSON.stringify(ownRgPath)}: the bundle `
      + 'then takes a host-dependent route (a bare name refuses outside the working directory; a host rg\'s path is the host\'s)');
  }
  if (rgPathExists) findings.push(`a file exists at quaude's own rg path ${ownRgPath}: nothing is ever written there, and a route that execs it must meet ENOENT`);
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
  const bashNote = `Bash route (the Bash tool's own command) through ${bash.shells.join(' and ')}: ${bash.cells.length} BASH_ROWS and I/O cells + the matrix each, `
    + `${bash.cells.filter((c) => c.naude).length} through a built naude, ${bash.tripwire.length} tripwire rows`;
  return { examined: cells.length, findings,
    note: `${what}; ${cells.length} cells (${kinds}); ${findings.length} differ; ours refused: ${refusalTally(cells)}; ${bashNote}` };
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
  // The Bash route: every pair equal, native's Bash route answering as native's rg, every tripwire row run by the host rg.
  const shells = ['bash', 'zsh'];
  for (const c of cells) c.bash = Object.fromEntries(shells.map((sh) => [sh, { native: c.native, ours: c.ours }]));
  const ioCells = P.bashIoCells('/tree', '/tree/big.txt').map((c) => ({ ...c, cmd: true }));
  const bash = { shells, floor: BASH_FLOOR, answeredFloor: BASH_ANSWERED_FLOOR, naudeFloor: NAUDE_FLOOR,
    cells: [...P.BASH_CELLS, ...ioCells].map((c) => { const r = res(c.argv, 'a.txt\0'); return { id: c.id, kind: c.kind, io: !!c.io, tree: '/tree', argv: c.argv,
      bash: Object.fromEntries(shells.map((sh) => [sh, { native: r, ours: { ...r } }])), naude: c.kind === 'root' ? { ...r } : null }; }),
    tripwire: shells.flatMap((sh) => ['normal', 'optin'].flatMap((mode) => ['native', 'ours'].map((side) => ({ shell: sh, mode, side, ran: true })))) };
  const base = { cells, floors: KIND_FLOORS, answeredFloors: ANSWERED_FLOORS, tripwire: '/trip/rg', rgPath: '/quaude/bin/rg', ownRgPath: '/quaude/bin/rg',
    rgPathExists: false, what: 'synthetic control', platform: 'darwin', bash };
  if (!defects) return base;
  // ...the Bash route's own: one byte of a BASH_ROWS cell through zsh, native's Bash route off native's rg in one
  // matrix cell through bash, and quaude's Bash `rg` overriding a host rg in normal mode (the 10c defect itself).
  const bc = bash.cells[3].bash.zsh;
  const bb = Buffer.from(bc.ours.stdout); bb[0] ^= 1;
  bc.ours = { ...bc.ours, stdout: bb };
  const im = cells.filter((x) => !P.MMAP_EVERYWHERE.cells[x.id])[5];
  im.bash.bash = { native: { ...im.native, status: 127, stdout: Buffer.alloc(0) }, ours: { ...im.native, status: 127, stdout: Buffer.alloc(0) } };
  bash.tripwire.find((t) => t.shell === 'bash' && t.mode === 'normal' && t.side === 'ours').ran = false;
  // ...and the built naude dying of a closed reader with a stack trace where native is silent (review I-1)
  const nio = bash.cells.find((c) => c.io && c.naude);
  nio.naude = { ...nio.naude, stderr: Buffer.from('Error: EUNKNOWN, write\n') };
  const plain = cells.filter((x) => !P.MMAP_EVERYWHERE.cells[x.id]);
  const k = plain[Math.floor(plain.length / 2)];
  const planted = Buffer.from(k.ours.stdout); planted[0] ^= 1;
  k.ours = { ...k.ours, stdout: planted };
  plain[1].ours = { ...plain[1].ours, status: TRIPWIRE_RC, stdout: Buffer.from(`${TRIPWIRE_MARK} --hidden\n`) };
  const [e1, e2] = EXCEPTED.map((id) => cells.find((x) => x.id === id));
  const o = Buffer.from(e1.ours.stdout); o[o.length - 2] ^= 1;
  e1.ours = { ...e1.ours, stdout: o };
  e2.native = { ...e2.native, stdout: Buffer.concat([e2.native.stdout, Buffer.from('x')]) };
  for (const sh of shells) e2.bash[sh] = { ...e2.bash[sh], native: e2.native };   // native drifted, on both of its routes
  return base;
}

const guard = defineGuard({ name: 'rg-differential', floor: FLOOR, read: readCells, scan: scanCells, control: controlCells });
guardTests(guard);

test('a tree kind under its floor makes rg-differential BROKEN, naming the kind', () => {
  const r = checkGate({ name: 'floor-probe', floor: guard.floor,
    read: () => { const c = controlCells(); c.cells = c.cells.filter((x) => x.kind !== 'bin2'); return c; },
    scan: scanCells });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, /the bin2 tree has 0 cells, under its floor of 98/);
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

test('ours whose Bun.which(\'rg\') is not quaude\'s own absolute rg is a finding: a bare rg, the tripwire, another path', () => {
  for (const [rgPath, ownRgPath] of [['rg', 'rg'], ['/trip/rg', '/trip/rg'], ['/elsewhere/rg', '/quaude/bin/rg'], ['/quaude/bin/rgx', '/quaude/bin/rgx']]) {
    const c = controlCells({ defects: false });
    Object.assign(c, { rgPath, ownRgPath });
    const r = scanCells(c);
    assert.deepStrictEqual(r.findings.map((f) => /^Bun\.which\('rg'\) answered .*, not quaude's own absolute rg/.test(f)), [true], `${rgPath}: ${r.findings.join('\n')}`);
  }
  assert.deepStrictEqual(scanCells(controlCells({ defects: false })).findings, []);
});
test('a file at quaude\'s own rg path is a finding: nothing is ever written there', () => {
  const c = controlCells({ defects: false });
  c.rgPathExists = true;
  assert.deepStrictEqual(scanCells(c).findings, ['a file exists at quaude\'s own rg path /quaude/bin/rg: nothing is ever written there, and a route that execs it must meet ENOENT']);
});

test('the control plants one differing byte AND one tripwire hit, and the gate names both', () => {
  const r = scanCells(controlCells());
  assert.strictEqual(r.findings.length, 8, r.findings.join('\n'));
  assert.ok(r.findings.some((f) => /stdout differs at byte 0/.test(f)));
  assert.ok(r.findings.some((f) => /ours ran a HOST rg \(the tripwire answered/.test(f)));
});

// THE BASH ROUTE (grep-native Task 10c): each planted defect is its own finding, named by route and shell.
test('the Bash route: a differing byte, native\'s Bash route off its rg, and a host rg overridden are each a finding', () => {
  const r = scanCells(controlCells());
  const bashF = r.findings.filter((f) => /Bash route/.test(f));
  assert.strictEqual(bashF.length, 4, bashF.join('\n'));
  assert.ok(bashF.some((f) => /^root Bash IO .* \[Bash route, bash, built naude\]: stderr "" vs "Error: EUNKNOWN, write\\n"$/.test(f)), bashF.join('\n'));
  assert.ok(bashF.some((f) => new RegExp(`^${P.BASH_CELLS[3].id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[Bash route, zsh\\]: stdout differs at byte 0`).test(f)), bashF.join('\n'));
  assert.ok(bashF.some((f) => /\[Bash route, bash\]: native's Bash route did not answer as native's rg \(exit 0 vs 127/.test(f)), bashF.join('\n'));
  assert.ok(bashF.includes("[Bash route, bash, normal mode] with a host rg installed, ours's Bash `rg` did not run it (native's guard leaves rg to the host's)"), bashF.join('\n'));
  assert.deepStrictEqual(scanCells(controlCells({ defects: false })).findings, []);
});

test('the Bash route short of a shell\'s floor, or unable to run, makes rg-differential BROKEN, naming why', () => {
  const c = controlCells({ defects: false });
  c.bash.cells = c.bash.cells.slice(0, 10);
  let r = checkGate({ name: 'bash-floor', floor: guard.floor, read: () => c, scan: scanCells });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, /the Bash route through bash has \d+ cells, under its floor of \d+/);
  const u = controlCells({ defects: false });
  u.bash = { unavailable: 'no quaude built from this tree to run as rg (x)' };
  r = checkGate({ name: 'bash-unavailable', floor: guard.floor, read: () => u, scan: scanCells });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, /the Bash route cannot run: no quaude built/);
  const z = controlCells({ defects: false });
  z.bash.shells = ['zsh'];
  assert.match(checkGate({ name: 'bash-absent', floor: guard.floor, read: () => z, scan: scanCells }).message, /did not run through bash/);
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
  // ...and through the Bash route the same, in each shell
  assert.deepStrictEqual(scanCells(lin).findings.map((f) => f.split(':')[0]).sort(),
    EXCEPTED.flatMap((id) => [id, `${id} [Bash route, bash]`, `${id} [Bash route, zsh]`]).sort());
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
  { skip: process.platform !== 'darwin' ? 'macOS only' : !rgOracle(process.env) ? rgOracleSkip(process.env) : false }, () => {
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

module.exports = { readCells, scanCells, controlCells, KIND_FLOORS, ANSWERED_FLOORS, BASH_FLOOR, BASH_ANSWERED_FLOOR };
