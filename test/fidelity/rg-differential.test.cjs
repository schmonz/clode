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
// and the two are compared on stdout bytes and exit code (compareRg), after exactly the two
// named normalizations compareRg owns (rg's nondeterministic walk ORDER, and the elapsed
// times in --json). Nothing else is forgiven.
//
// THE ONE WRITTEN DIVERGENCE IN SCOPE. Rust regex and ugrep's regex dialect cannot be equal in
// general, so the matrix's patterns (`needle`, `one.beta`) come from the dialect both read the
// same way. A pattern the emulation can tell they would read differently is refused honestly
// (rc 2, the reason on stderr), never answered differently.
//
// BASELINE RED BY DESIGN (the plan's Task 4). Measured 2026-10-03 against native 2.1.283
// (ripgrep 14.1.1) on darwin-arm64 with ugrep 7.8.2: all 165 cells differ, and ours REFUSED
// every one of them (rc 2, nothing searched): ugrep rejects the --max-columns 500 every Grep
// argv carries (70), --json, i.e. every content cell (63), Glob's --null (18), --type (14).
// With --max-columns removed from what ours sees (report-grep's best case), 56 cells answer
// and 40 of them still differ, every one in a class report-grep measured; the 16 equal ones
// are empty on both sides. Tasks 5-10 drive it to OK; the note tallies what ours refused so
// each task's progress is visible in the verdict itself.
//
// WHERE IT RUNS: wherever a native provider, tjs and ugrep all exist. Otherwise it SKIPS
// naming which is missing (CI wiring is the plan's Task 11).
//
// FLOORS: cells per tree kind (KIND_FLOORS), each measured as the matrix stood when this was
// written; a kind under its floor makes the gate BROKEN naming the kind, because a verdict
// over a matrix missing a tree says nothing about what that tree is in it to judge.
// CONTROL: the full matrix, every pair equal, with ONE planted differing byte.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const P = require('../../scripts/lib/rg-probe.cjs');
const { providerBin } = require('../provider-resolve.cjs');
const { tjsPath, resolveBin } = require('../node-shim-helper.cjs');

// Measured 2026-09-28: RG_MATRIX's cells per tree kind: 21 Grep argv x 2 directory target forms
// plus 3 Glob argv x 2, and for bin2 the 21 Grep argv once more naming early.dat.
const KIND_FLOORS = { root: 48, nogit: 48, bin2: 69 };
const FLOOR = Object.values(KIND_FLOORS).reduce((a, b) => a + b, 0);

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

test('compareRg does not forgive order where rg promised one (--sort=modified)', () => {
  const c = P.compareRg(res(GLOB, 'a.txt\0b.txt\0'), res(GLOB, 'b.txt\0a.txt\0'));
  assert.strictEqual(c.same, false);
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
    // Both sides get the same environment: a throwaway HOME (so no global gitignore or rg config
    // of this box's owner can reach either side), and this PATH (where ugrep lives).
    const env = { PATH: process.env.PATH, HOME: home };
    const cells = P.RG_MATRIX.map((c) => ({ ...c, cwd: trees[c.kind], argv: P.cellArgv(c, trees[c.kind]) }));
    const native = cells.map((c) => P.runNativeRg(bin, c.argv, c.cwd, { env }));
    const ours = P.runOursRgBatch(cells.map((c) => ({ argv: c.argv, cwd: c.cwd })), { env });
    return {
      cells: cells.map((c, i) => ({ id: c.id, kind: c.kind, native: native[i], ours: ours[i] })),
      floors: KIND_FLOORS,
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
    const m = /^rg: error parsing flag( \S+)?: (.*)$/m.exec(c.ours.stderr.toString('utf8'));
    if (!m) continue;
    const said = /rejected this search \((?:\w+: )?([^,)]*)/.exec(m[2]);
    const key = m[1] ? m[1].trim() : said ? `rejected: ${said[1].trim()}` : m[2].replace(/[;(].*$/, '').trim();
    t.set(key, (t.get(key) || 0) + 1);
  }
  return [...t].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', ') || 'none';
}

function scanCells({ cells, floors, what }) {
  const per = {};
  for (const c of cells) per[c.kind] = (per[c.kind] || 0) + 1;
  const short = Object.entries(floors).filter(([k, f]) => (per[k] || 0) < f)
    .map(([k, f]) => `the ${k} tree has ${per[k] || 0} cells, under its floor of ${f}`);
  if (short.length) return { examined: 0, findings: short, note: `${what}; ${short.join('; ')}` };
  const findings = [];
  for (const c of cells) {
    const d = P.compareRg(c.native, c.ours);
    if (!d.same) findings.push(`${c.id}: ${d.why}`);
  }
  const kinds = Object.keys(floors).map((k) => `${k} ${per[k]}`).join(', ');
  return { examined: cells.length, findings,
    note: `${what}; ${cells.length} cells (${kinds}); ${findings.length} differ; ours refused: ${refusalTally(cells)}` };
}

// The full matrix, every pair equal, then ONE byte of one cell's stdout changed.
function controlCells() {
  const cells = P.RG_MATRIX.map((c) => {
    const r = res(P.cellArgv(c, '/tree'), 'a.txt\0');
    return { id: c.id, kind: c.kind, native: r, ours: { ...r } };
  });
  const k = Math.floor(cells.length / 2);
  const planted = Buffer.from(cells[k].ours.stdout); planted[0] ^= 1;
  cells[k].ours = { ...cells[k].ours, stdout: planted };
  return { cells, floors: KIND_FLOORS, what: 'synthetic control' };
}

const guard = defineGuard({ name: 'rg-differential', floor: FLOOR, read: readCells, scan: scanCells, control: controlCells });
guardTests(guard);

test('the control plants exactly one differing byte, and the gate names that cell', () => {
  const r = scanCells(controlCells());
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /stdout differs at byte 0/);
});

test('a tree kind under its floor makes rg-differential BROKEN, naming the kind', () => {
  const r = checkGate({ name: 'floor-probe', floor: guard.floor,
    read: () => { const c = controlCells(); c.cells = c.cells.filter((x) => x.kind !== 'bin2'); return c; },
    scan: scanCells });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, /the bin2 tree has 0 cells, under its floor of 69/);
});

test('RG_MATRIX holds every kind at or above its floor, and each cell id once', () => {
  const per = {};
  for (const c of P.RG_MATRIX) per[c.kind] = (per[c.kind] || 0) + 1;
  assert.deepStrictEqual(Object.keys(per).sort(), Object.keys(KIND_FLOORS).sort());
  for (const [k, f] of Object.entries(KIND_FLOORS)) assert.ok(per[k] >= f, `${k}: ${per[k]} cells, floor ${f}`);
  assert.strictEqual(new Set(P.RG_MATRIX.map((c) => c.id)).size, P.RG_MATRIX.length);
});

module.exports = { readCells, scanCells, controlCells, KIND_FLOORS };
