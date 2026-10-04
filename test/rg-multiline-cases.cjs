'use strict';
// The files test/rg-multiline.test.cjs measures rg's multiline search over (grep-native Task 10), built here
// byte for byte so the test and the generator of its native literals build the SAME tree. Non-ASCII and
// invalid UTF-8 are built from code points and bytes (never a literal in source: the Write/Edit hazard).
//
//   a.txt       the differential's root a.txt (`one.beta` spans its lines 1-2)
//   m.txt       short lines, a blank line, an unterminated last line
//   crlf.txt    CRLF line ends (\r is a character to rg)
//   u.txt       a two-byte and two three-byte characters (empty matches inside them)
//   bad.txt     invalid UTF-8 (`.` never matches an invalid byte, dotall or not)
//   ctx.txt     matches far enough apart for context and `--`
//   sp.txt      rg's searcher reads a slice from where the last match ended, so `^` matches there
//   early.dat   a NUL at 14 (inside rg's first 64 KiB), matches before and after it
//   bom16.txt   UTF-16LE with a byte order mark (rg searches its UTF-8 transcoding)
//   sub/b.txt   a walked file under a directory
//   q/early/early.dat  early.dat again, alone in a directory, to be walked
//   q/late/late.dat    a NUL past the first 64 KiB, inside the lines of a later match (only here)
const cp = (...c) => String.fromCodePoint(...c);
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const FILLER = 'filler line\n'.repeat(6000);
const ML_FILES = [
  ['a.txt', 'alpha needle one\nbeta\ngamma needle two needle\ndelta\nepsilon\nzeta needle\n'],
  ['m.txt', 'abc\ndef\nghi\n\njkl\nmno'],
  ['crlf.txt', 'one\r\nbeta\r\nthree one\r\n'],
  ['u.txt', `caf${cp(0xe9)}\n${cp(0x4e2d, 0x6587)}\nx one\nbeta\n`],
  ['bad.txt', cat('a', [0xff], '\nb', [0xc3], '\n', [0x80], 'c one\nbeta\n')],
  ['ctx.txt', '1\n2 one\nbeta 3\n4\n5\n6\n7\n8 one\nbeta\n9\n10\n'],
  ['sp.txt', 'abc\nd\nxab\ncd\n'],
  ['early.dat', cat('text one\nbeta\n', [0, 1, 2, 0x0a], 'after one\nbeta nul\n')],
  ['bom16.txt', cat([0xff, 0xfe], Buffer.from('ab one\nbeta zz\n', 'utf16le'))],
  ['sub/b.txt', 'sub one\nbeta\n'],
];
// each binary alone in a directory, to be WALKED (rg's binary quit) or named; late.dat only here (its filler
// would swamp the other rows' answers)
ML_FILES.push(['q/early/early.dat', new Map(ML_FILES).get('early.dat')],
  ['q/late/late.dat', cat('first one\nbeta\n', FILLER, 'near one\nbeta ', [0], 'x\n', 'after one\nbeta\n')]);
function makeMlTree(fs, path, dir) {
  for (const [rel, data] of ML_FILES) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}
const ML_INPUT = (name) => (name ? Buffer.from(new Map(ML_FILES).get(name)) : undefined);
module.exports = { ML_FILES, makeMlTree, ML_INPUT };
