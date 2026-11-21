'use strict';
// RG-STREAM (grep-native Task 10c fix round, review I-2): a command's search streams (libexec/rg-native.cjs
// streamEntry), and what it prints is the whole-text search's, byte for byte. The whole-text search is the one
// test/rg-native.test.cjs, test/rg-walk.test.cjs and the rg-differential gate hold to native's literals, so it is
// the oracle here: every printer (standard, -n, -o, context, --max-columns, -c, -c -o, -l, --json), stdin (rg's
// RG-BINARY-CONVERT) and a named file (RG-BINARY-MMAP; and RG-BINARY-CONVERT beside `-`), over generated texts
// that put line ends, long lines (past rg's 64 KiB buffer), NULs, CRLF, a UTF-8 BOM, UTF-16 and an unterminated
// last line where a window's edges fall, read a few bytes at a time and a megabyte at a time.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rgn = require('../libexec/rg-native.cjs');
const { census, rngBias, assertCensus } = require('./shape-census.cjs');

// A small seeded generator, so a failure names the case that reproduces it.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
function makeText(seed) {
  const r = rng(seed);
  const parts = [];
  const lines = 1 + Math.floor(r() * 400);
  for (let i = 0; i < lines; i++) {
    const roll = r();
    let line;
    if (roll < 0.02) line = 'y'.repeat(60000 + Math.floor(r() * 90000)) + (r() < 0.5 ? ' needle' : '');
    else if (roll < 0.3) line = `l${i} has a needle${r() < 0.3 ? ' and needle again' : ''}`;
    else line = `l${i} ${'z'.repeat(Math.floor(r() * 80))}`;
    parts.push(line + (r() < 0.1 ? '\r\n' : '\n'));
  }
  let b = Buffer.from(parts.join(''));
  if (r() < 0.25) b = b.subarray(0, b.length - 1);                // an unterminated last line
  if (r() < 0.3) { const at = Math.floor(r() * b.length); b = Buffer.concat([b.subarray(0, at), Buffer.from([0]), b.subarray(at)]); }
  if (r() < 0.1) b = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]);
  return b;
}
const ARGVS = [
  ['needle'], ['-n', 'needle'], ['-o', 'needle'], ['-n', '-C', '1', 'needle'], ['-B', '2', '-A', '1', 'needle'], ['-A', '3', '-n', 'needle'],
  ['-M', '20', 'needle'], ['-N', 'needle'], ['-c', 'needle'], ['-c', '-o', 'needle'], ['-l', 'needle'], ['--json', 'needle'],
  ['--json', '-C', '1', 'needle'], ['-n', 'zzz-absent'],
  // RG-MAX-COUNT (2.1.330): the first N selected lines across windows, and the Nth line's after-context with its tails
  ['-m', '3', '-n', 'needle'], ['-m', '2', '-A', '2', '-n', 'needle'], ['-m', '1', '-c', 'needle'], ['-a', '-n', 'needle'],
];
const norm = (b) => String(Buffer.from(b).toString('latin1')).replace(/"(elapsed|elapsed_total)":\{[^{}]*\}/g, '"$1":{}');

function both(argv, dir, stdinBytes, piece, readSize) {
  const whole = rgn.runRg(argv, { cwd: dir, input: stdinBytes, matchFiles: rgn.matchFilesAlone });
  const got = [];
  let i = 0;
  const st = rgn.runRg(argv, { cwd: dir, stream: true, sink: (b) => got.push(Buffer.from(b)), matchFiles: rgn.matchFilesAlone, streamRead: readSize,
    stdinChunk: () => { if (i >= stdinBytes.length) return null; const c = stdinBytes.subarray(i, i + piece); i += piece; return c; } });
  return { whole, stream: { ...st, stdout: Buffer.concat([...got, st.stdout]) } };
}

// THE GENERATOR'S SHAPE CENSUS (observability Task 4; test/shape-census.cjs). The 36 texts below are this file's whole
// claim about where a window's edges fall, so they must hold the shapes the header names. The floors: a floor written
// as a fraction of today's count is a regression tripwire on a deterministic count (the seeds are fixed), not a
// coverage requirement. Measured 2026-11-19 over the
// 36 texts: a line past 64 KiB 35, needle on such a line 31, CRLF 36, a NUL 13 (before the first match 2, after it 11),
// a BOM 3, an unterminated last line 8, needle across a 3001-byte read edge 9, CRLF split by a 7-byte stdin piece 17
// (odd seeds), a \n exactly at a read edge's last byte 2. UTF-16 is not drawn here: its own test below holds it.
const STREAM_SEEDS = Array.from({ length: 36 }, (_, i) => (i + 1) * 7919);
const at = (b, s) => { const r = []; const n = Buffer.from(s); for (let i = b.indexOf(n); i >= 0; i = b.indexOf(n, i + 1)) r.push(i); return r; };
const textLines = (t) => { const out = []; for (let s = 0; s < t.length;) { let e = t.indexOf(10, s); if (e < 0) e = t.length; out.push(t.subarray(s, e)); s = e + 1; } return out; };
const STREAM_SHAPES = [
  { shape: 'a line past rg\'s 64 KiB buffer', min: 20, has: ({ t }) => textLines(t).some((l) => l.length > 65536), why: 'over half of the 35 measured' },
  { shape: 'needle on a line past 64 KiB', min: 15, has: ({ t }) => textLines(t).some((l) => l.length > 65536 && l.includes('needle')), why: 'half of the 31 measured' },
  { shape: 'a CRLF line', min: 20, has: ({ t }) => t.includes('\r\n'), why: 'over half of the 36 measured' },
  { shape: 'a NUL before the first match (binary detection decides first)', min: 2, has: ({ t }) => { const z = t.indexOf(0), m = t.indexOf('needle'); return z >= 0 && m >= 0 && z < m; },
    why: 'two texts (2 measured: each NUL lands in a random place, mostly after the first needle)' },
  { shape: 'a NUL after the first match', min: 5, has: ({ t }) => { const z = t.indexOf(0), m = t.indexOf('needle'); return z >= 0 && m >= 0 && z > m; }, why: 'half of the 11 measured' },
  { shape: 'a UTF-8 BOM', min: 2, has: ({ t }) => t[0] === 0xef && t[1] === 0xbb && t[2] === 0xbf, why: 'two texts (3 measured; 1 in 10 drawn)' },
  { shape: 'an unterminated last line', min: 4, has: ({ t }) => t[t.length - 1] !== 0x0a, why: 'half of the 8 measured' },
  { shape: 'needle across a 3001-byte read edge', min: 4, has: ({ t }) => at(t, 'needle').some((i) => Math.floor(i / 3001) !== Math.floor((i + 5) / 3001)),
    why: 'half of the 9 measured' },
  { shape: 'CRLF split by a 7-byte stdin piece', min: 8, has: ({ t, seed }) => (seed / 7919) % 2 === 1 && at(t, '\r\n').some((i) => i % 7 === 6),
    why: 'half of the 17 measured (the 7-byte pieces are the odd seeds)' },
  { shape: 'a \\n on a read edge\'s last byte', min: 1, has: ({ t }) => at(t, '\n').some((i) => i % 3001 === 3000),
    why: 'one text: about 1 terminator in 3,001 lands there (2 measured)' },
];
test('RG-STREAM\'s generated texts hold every shape the header claims, from an unbiased RNG (census)', (t) => {
  const texts = census('RG-STREAM texts', STREAM_SHAPES, STREAM_SEEDS.map((seed) => ({ seed, t: makeText(seed) })));
  // the bits it uses: floor(r() * k) for the line count, lengths and choices, and r() < p for p in 0.02 .. 0.5
  const bias = rngBias('RG-STREAM RNG', () => { const r = rng(7919); return (m) => Math.floor(r() * m); }, [2, 4, 10, 50, 80, 400]);
  for (const r of [texts, bias]) t.diagnostic(r.summary);
  assertCensus(assert, texts, bias);
});

for (const [label, targets] of [['stdin (convert)', ['-']], ['a named file (mmap)', ['f']], ['a named file beside - (convert)', ['f', '-']]]) {
  test(`RG-STREAM: ${label} streamed prints the whole-text search's bytes, every printer, windows of every size`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-stream-'));
    try {
      let cases = 0;
      for (let seed = 1; seed <= 36; seed++) {
        const text = makeText(STREAM_SEEDS[seed - 1]);
        fs.writeFileSync(path.join(dir, 'f'), text);
        const stdin = targets.includes('f') ? Buffer.alloc(0) : text;
        for (const argv0 of ARGVS) {
          const argv = [...argv0, ...targets];
          for (const [piece, readSize] of [[seed % 2 ? 7 : 4093, 3001], [1 << 20, 1 << 20]]) {
            const { whole, stream } = both(argv, dir, stdin, piece, readSize);
            const where = `seed ${seed * 7919}, ${argv.join(' ')}, pieces of ${piece}/${readSize}`;
            assert.strictEqual(stream.status, whole.status, `${where}: status (${String(stream.stderr)})`);
            assert.strictEqual(norm(stream.stdout), norm(whole.stdout), where);
            assert.strictEqual(String(stream.stderr), String(whole.stderr), `${where}: stderr`);
            cases++;
          }
        }
      }
      assert.ok(cases >= 36 * ARGVS.length * 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('RG-STREAM: a UTF-16 stdin is searched whole (rg\'s decoder), and answers as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-stream-'));
  try {
    const u = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a needle\nb\nneedle c\n', 'utf16le')]);
    for (const argv of [['-n', 'needle', '-'], ['--json', 'needle', '-'], ['-c', 'needle', '-']]) {
      const { whole, stream } = both(argv, dir, u, 5, 4096);
      assert.strictEqual(norm(stream.stdout), norm(whole.stdout), argv.join(' '));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// What streaming is for: output before the input ends, and a search that stops when its reader does. Counted, not
// timed: the bytes of stdin read before the first line was handed on, and after a sink that throws.
test('RG-STREAM: the first match is handed on long before the input ends, and a sink that throws ends the search', () => {
  const line = Buffer.from('needle\n');
  let pulled = 0, firstAt = -1;
  const out = [];
  const stop = Object.assign(new Error('the reader went away'), { sinkClosed: true });
  const chunk = Buffer.concat(Array(8192).fill(line));          // 56 KiB a piece, forever
  assert.throws(() => rgn.runRg(['needle', '-'], { cwd: os.tmpdir(), stream: true, matchFiles: rgn.matchFilesAlone,
    stdinChunk: () => { pulled += chunk.length; if (pulled > 512 * 1024 * 1024) throw new Error('never stopped'); return chunk; },
    sink: (b) => { if (firstAt === -1) firstAt = pulled; out.push(b); if (out.length > 3) throw stop; } }), (e) => e === stop);
  assert.ok(firstAt > 0 && firstAt <= 1024 * 1024, `the first output came after ${firstAt} bytes of stdin`);
  assert.ok(pulled <= 4 * 1024 * 1024, `${pulled} bytes of stdin were read for 4 pieces of output`);
});
