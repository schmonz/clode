'use strict';
// RG-TEXT, RG-FIXED-STRINGS and RG-MAX-COUNT (the 2.1.330 pin): quaude's rg answers --text (-a), --fixed-strings (-F)
// and --max-count (-m) as native's rg does.
// 2.1.330 passes both in production: the hybrid-organization scan (`--text --fixed-strings --glob *.jsonl*`) and
// the model-family environment listing (`--max-count 20 --only-matching --null`); rg-carve-argv-answered found
// quaude's rg refusing them. Every row below is native's answer, VERBATIM, measured 2026-11-21 against the pinned
// 2.1.330 darwin-arm64 provider's embedded rg (ripgrep 14.1.1 at the revision libexec/rg-types.cjs records in version.head) over the files built here; the last
// test re-measures them against native wherever the oracle resolves, so a row that stops being native's fails there.
// What they pin (libexec/rg-native.cjs states each rule):
//   RG-FIXED-STRINGS  -F: the pattern is a literal, every metacharacter escaped; -i still folds; --no-fixed-strings undoes it.
//   RG-TEXT       no binary detection at all: a NUL is a byte, in a walked file, a named one and stdin; --no-text undoes it.
//   RG-MAX-COUNT  the first N selected lines per file; -m 0 selects none (rc 1, -l lists nothing); the Nth line's
//                 after-context is printed, a matching line there AS A MATCH that does not extend it (-c counts N);
//                 rg stops there, so a NUL in a fill it never read is no binary data (a walked late.dat under -m 1
//                 prints no WARNING and -c counts 1; -m 2 reaches the NUL's fill and is squashed as before).
// NOT pinned here: a NAMED file whose NUL lies past the first 64 KiB, which macOS native reads and quaude's rg
// answers as a mapped file (RG-MMAP-EVERYWHERE, the one written divergence); --max-count with --json and with -U,
// which quaude's rg refuses by name (the JSON end message's bytes_searched under -m is where rg's reads stood).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const rgn = require('../libexec/rg-native.cjs');
const { rgOracle, rgOracleSkip } = require('./provider-resolve.cjs');

const cat8 = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const LATE = cat8('first needle line\n' + 'filler line\n'.repeat(10000) + 'near needle\n', [0, 0x0a], 'after needle\n');
const EARLY = cat8('text needle before\n', [0, 1, 2, 0x0a], 'needle after nul\n');
const U = 'needle one\nx\nneedle two\nneedle three\ny\nz\nneedle four\n';
const BIG = 'filler line\n'.repeat(10000) + 'needle a\n' + 'filler line\n'.repeat(10000) + 'needle b\nneedle c\n';
const META = 'a.b(c) x\naxb(c) y\n$^[x]{1}*+?|\\ z\nA.B(C) w\n';
const FILES = [['early.dat', EARLY], ['late.dat', LATE], ['u.txt', U], ['big.txt', BIG], ['q/late/late.dat', LATE], ['q/early/early.dat', EARLY], ['q/u/u.txt', U], ['meta.txt', META]];

// [rule, argv, stdin (a file's name, or null), rc, stdout, stderr when rc 2]
const NATIVE = [
  ["RG-TEXT",["--text","needle","q/early"],null,0,"q/early/early.dat:text needle before\nq/early/early.dat:needle after nul\n"],
  ["RG-TEXT",["-a","-n","needle","early.dat"],null,0,"1:text needle before\n3:needle after nul\n"],
  ["RG-TEXT",["-a","-n","needle","q/late"],null,0,"q/late/late.dat:1:first needle line\nq/late/late.dat:10002:near needle\nq/late/late.dat:10004:after needle\n"],
  ["RG-TEXT",["-a","-c","needle","q/late"],null,0,"q/late/late.dat:3\n"],
  ["RG-TEXT",["-a","-l","needle","q/early"],null,0,"q/early/early.dat\n"],
  ["RG-TEXT",["-a","-n","needle","-"],"early.dat",0,"1:text needle before\n3:needle after nul\n"],
  ["RG-TEXT",["-a","-c","needle","late.dat"],null,0,"3\n"],
  ["RG-TEXT",["-a","--no-text","-n","needle","early.dat"],null,0,"binary file matches (found \"\\0\" byte around offset 19)\n"],
  ["RG-TEXT",["--no-config","--no-ignore","--hidden","--text","--no-filename","--no-line-number","--fixed-strings","--glob","*.dat*","--regexp","needle","."],null,0,"first needle line\nnear needle\nafter needle\ntext needle before\nneedle after nul\nfirst needle line\nnear needle\nafter needle\ntext needle before\nneedle after nul\n"],
  ["RG-FIXED-STRINGS",["-F","-n","a.b(c)","meta.txt"],null,0,"1:a.b(c) x\n"],
  ["RG-FIXED-STRINGS",["--fixed-strings","-o","$^[x]{1}*+?|\\","meta.txt"],null,0,"$^[x]{1}*+?|\\\n"],
  ["RG-FIXED-STRINGS",["-F","-i","-n","a.b(c)","meta.txt"],null,0,"1:a.b(c) x\n4:A.B(C) w\n"],
  ["RG-FIXED-STRINGS",["-F","--no-fixed-strings","-n","a.b","meta.txt"],null,0,"1:a.b(c) x\n2:axb(c) y\n"],
  ["RG-MAX-COUNT",["-m","2","-n","needle","u.txt"],null,0,"1:needle one\n3:needle two\n"],
  ["RG-MAX-COUNT",["-m2","-o","-e","e","u.txt"],null,0,"e\ne\ne\ne\ne\ne\ne\n"],
  ["RG-MAX-COUNT",["--max-count","1","-c","needle","u.txt"],null,0,"1\n"],
  ["RG-MAX-COUNT",["--max-count=2","-n","needle","q/u"],null,0,"q/u/u.txt:1:needle one\nq/u/u.txt:3:needle two\n"],
  ["RG-MAX-COUNT",["-m","0","-n","needle","u.txt"],null,1,""],
  ["RG-MAX-COUNT",["-m","0","-l","needle","q/u"],null,1,""],
  ["RG-MAX-COUNT",["-m","0","-l","needle","u.txt"],null,1,""],
  ["RG-MAX-COUNT",["-m","0","-c","needle","u.txt"],null,1,""],
  ["RG-MAX-COUNT",["-m","9","-c","needle","u.txt"],null,0,"4\n"],
  ["RG-MAX-COUNT",["-m","1","-A","2","-n","needle","u.txt"],null,0,"1:needle one\n2-x\n3:needle two\n"],
  ["RG-MAX-COUNT",["-m","2","-A","1","-n","needle","u.txt"],null,0,"1:needle one\n2-x\n3:needle two\n4:needle three\n"],
  ["RG-MAX-COUNT",["-m","1","-A","3","-n","needle","u.txt"],null,0,"1:needle one\n2-x\n3:needle two\n4:needle three\n"],
  ["RG-MAX-COUNT",["-m","1","-A","2","-c","needle","u.txt"],null,0,"1\n"],
  ["RG-MAX-COUNT",["-m","1","-A","2","-o","-n","needle","u.txt"],null,0,"1:needle\n2-x\n3:needle\n"],
  ["RG-MAX-COUNT",["-m","1","-B","1","-n","needle","u.txt"],null,0,"1:needle one\n"],
  ["RG-MAX-COUNT",["-m","2","-C","1","-n","needle","u.txt"],null,0,"1:needle one\n2-x\n3:needle two\n4:needle three\n"],
  ["RG-MAX-COUNT",["-m","1","-A","2","-n","needle","q/u"],null,0,"q/u/u.txt:1:needle one\nq/u/u.txt-2-x\nq/u/u.txt:3:needle two\n"],
  ["RG-MAX-COUNT",["-m","1","-A","2","-n","needle","-"],"u.txt",0,"1:needle one\n2-x\n3:needle two\n"],
  ["RG-MAX-COUNT",["-m","2","-A","1","-n","needle","-"],"u.txt",0,"1:needle one\n2-x\n3:needle two\n4:needle three\n"],
  ["RG-MAX-COUNT",["-m","1","-n","needle","big.txt"],null,0,"10001:needle a\n"],
  ["RG-MAX-COUNT",["-m","2","-A","1","-n","needle","-"],"big.txt",0,"10001:needle a\n10002-filler line\n--\n20002:needle b\n20003:needle c\n"],
  ["RG-MAX-COUNT",["-m","1","-n","needle","q/late"],null,0,"q/late/late.dat:1:first needle line\n"],
  ["RG-MAX-COUNT",["-m","2","-n","needle","q/late"],null,0,"q/late/late.dat:1:first needle line\nq/late/late.dat: WARNING: stopped searching binary file after match (found \"\\0\" byte around offset 120030)\n"],
  ["RG-MAX-COUNT",["-m","1","-c","needle","q/late"],null,0,"q/late/late.dat:1\n"],
  ["RG-MAX-COUNT",["-m","2","-c","needle","q/late"],null,1,""],
  ["RG-MAX-COUNT",["-m","1","-A","1","-n","needle","q/late"],null,0,"q/late/late.dat:1:first needle line\nq/late/late.dat-2-filler line\n"],
  ["RG-MAX-COUNT",["-m","1","-C","1","-n","near","q/late"],null,1,""],
  ["RG-MAX-COUNT",["-m","1","-n","needle","early.dat"],null,0,"binary file matches (found \"\\0\" byte around offset 19)\n"],
  ["RG-MAX-COUNT",["-m","1","-c","needle","early.dat"],null,0,"1\n"],
  ["RG-MAX-COUNT",["-m","1","-n","needle","q/early"],null,1,""],
  ["RG-MAX-COUNT",["-m","1","-n","needle","-"],"late.dat",0,"1:first needle line\n"],
  ["RG-MAX-COUNT",["-m","1","-A","1","-n","needle","-"],"late.dat",0,"1:first needle line\n2-filler line\n"],
  ["RG-MAX-COUNT",["-m","2","-n","needle","-"],"late.dat",0,"1:first needle line\nbinary file matches (found \"\\0\" byte around offset 120030)\n"],
  ["RG-MAX-COUNT",["-m","1","-n","needle","-"],"early.dat",0,"binary file matches (found \"\\0\" byte around offset 19)\n"],
  ["RG-MAX-COUNT",["-m","1","-a","-n","needle","q/late"],null,0,"q/late/late.dat:1:first needle line\n"],
  ["RG-MAX-COUNT",["-m","x","needle","u.txt"],null,2,"","rg: error parsing flag -m: value is not a valid number: invalid digit found in string\n"],
  ["RG-MAX-COUNT",["--no-config","--line-buffered","--only-matching","--with-filename","--null","--no-line-number","--no-heading","--max-count","1","--max-filesize","1M","--max-depth","8","-g","!q","-e","[A-Za-z0-9._]*(?:needle)[A-Za-z0-9@_-]*","."],null,0,"./late.dat\u0000needle\n./u.txt\u0000needle\n./big.txt\u0000needle\n"],
];

function withFiles(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-text-max-')));
  try {
    for (const [rel, d] of FILES) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); }
    return fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const input = (root, name) => (name ? fs.readFileSync(path.join(root, name)) : undefined);
const l1 = (b) => Buffer.from(b || '').toString('latin1');
// A row searching `.` walks several files: rg's order is its threads', so lines are compared as a set.
const walks = (argv) => argv.includes('.');
const sorted = (s) => s.split('\n').sort().join('\n');
function check(row, got, how) {
  const [rule, argv, , rc, out, err] = row;
  const what = `${rule} (${how}): rg ${argv.join(' ')} => ${JSON.stringify(got).slice(0, 600)}`;
  assert.strictEqual(got.status, rc, what);
  assert.strictEqual(walks(argv) ? sorted(got.stdout) : got.stdout, walks(argv) ? sorted(out) : out, what);
  if (err !== undefined) assert.strictEqual(got.stderr, err, what);
  assert.strictEqual(rgn.parseRgRefusal(got.stderr), null, `${what}: native answers this, so ours must not refuse it`);
}
// The whole-text search (runRg), with the matcher alone deciding every file so it runs on every host.
function whole(root, [, argv, inp]) {
  const r = rgn.runRg(argv, { cwd: root, input: input(root, inp), matchFiles: rgn.matchFilesAlone });
  return { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) };
}
// A command's search (RG-STREAM: rg-entry.cjs), stdin handed over `piece` bytes at a time.
function streamed(root, [, argv, inp], piece) {
  const bytes = input(root, inp) || Buffer.alloc(0), got = [];
  let i = 0;
  const r = rgn.runRg(argv, { cwd: root, stream: true, sink: (b) => got.push(Buffer.from(b)), matchFiles: rgn.matchFilesAlone,
    stdinChunk: () => { if (i >= bytes.length) return null; const c = bytes.subarray(i, i + piece); i += piece; return c; } });
  return { status: r.status, stdout: l1(Buffer.concat([...got, Buffer.from(r.stdout || '')])), stderr: l1(r.stderr) };
}

test('RG-TEXT and RG-MAX-COUNT: the whole-text search prints what native prints', () => withFiles((root) => {
  for (const row of NATIVE) check(row, whole(root, row), 'whole');
}));
test('RG-TEXT and RG-MAX-COUNT: a command\'s streamed search prints what native prints, stdin in small pieces and large', () => withFiles((root) => {
  for (const piece of [7, 4096, 1 << 20]) for (const row of NATIVE) check(row, streamed(root, row, piece), `streamed, ${piece}-byte pieces`);
}));
// The same, over the host's ugrep (quaude's search as it runs: ugrep proposes, the matcher decides).
function hostUgrep() {
  if (process.env.CLODE_UGREP) return process.env.CLODE_UGREP;
  for (const d of (process.env.PATH || '').split(path.delimiter)) for (const x of process.platform === 'win32' ? ['.exe', ''] : ['']) {
    const p = path.join(d, 'ugrep' + x); if (d && fs.existsSync(p)) return p;
  }
  return null;
}
const UGREP = hostUgrep();
test('RG-TEXT and RG-MAX-COUNT: over ugrep, the whole-text search prints what native prints', { skip: UGREP ? false : 'no ugrep on this host' }, () => withFiles((root) => {
  for (const row of NATIVE) {
    const [, argv, inp] = row;
    const r = rgn.runRg(argv, { cwd: root, input: input(root, inp), spawnSync: cp.spawnSync, ugrep: () => UGREP });
    check(row, { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) }, 'over ugrep');
  }
}));
test('RG-MAX-COUNT under --json and under -U is refused by name, never answered differently', () => withFiles((root) => {
  for (const [argv, flag] of [[['-m', '1', '--json', 'needle', 'u.txt'], '--max-count with --json'], [['--json', '--max-count=2', 'needle', 'q/u'], '--max-count with --json'],
    [['-U', '-m', '1', 'needle\\nx', 'u.txt'], '--max-count with --multiline'], [['-U', '-a', 'needle\\nx', 'u.txt'], '--text with --multiline']]) {
    const r = rgn.runRg(argv, { cwd: root, matchFiles: rgn.matchFilesAlone });
    assert.strictEqual(r.status, 2, argv.join(' '));
    assert.ok(l1(r.stderr).includes(flag), `${argv.join(' ')}: ${l1(r.stderr)}`);
  }
}));
// Native is the truth: every row re-measured against the pinned provider's embedded rg, where it resolves.
const NATIVE_BIN = rgOracle(process.env);
test('RG-TEXT and RG-MAX-COUNT: every row is still native\'s answer (native)', { skip: !NATIVE_BIN ? rgOracleSkip(process.env) : false }, () => withFiles((root) => {
  for (const row of NATIVE) {
    const [, argv, inp] = row;
    const r = cp.spawnSync(NATIVE_BIN, argv, { cwd: root, argv0: 'rg', input: input(root, inp) || '', env: { HOME: root }, maxBuffer: 1 << 24 });
    check(row, { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) }, 'native');
  }
}));
