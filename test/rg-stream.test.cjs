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

for (const [label, targets] of [['stdin (convert)', ['-']], ['a named file (mmap)', ['f']], ['a named file beside - (convert)', ['f', '-']]]) {
  test(`RG-STREAM: ${label} streamed prints the whole-text search's bytes, every printer, windows of every size`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-stream-'));
    try {
      let cases = 0;
      for (let seed = 1; seed <= 36; seed++) {
        const text = makeText(seed * 7919);
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
