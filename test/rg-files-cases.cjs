'use strict';
// The tree test/rg-files.test.cjs measures `rg --files` over (grep-native Task 10: the Glob tool), built
// here byte for byte, with every file's modification time set, so the test and the generator of its native
// literals build the SAME tree and --sort=modified has ONE right answer. Times are sub-second apart where it
// matters (rg sorts to the nanosecond; a whole-second clock would order them differently: ruling G12), and
// two pairs are EQUAL (rg's sort is stable: equal times keep the walk's order, which -j1 makes rg's own).
//
//   a git repo (.git/HEAD), its .gitignore (ignored.txt, *.log), a hidden file, ts/tsx/js for brace globs,
//   an empty file and a binary (a listing lists them: no content is read), nested dirs, the Grep/Glob tools'
//   Read-deny shapes (private/, other/private, code/{b}.ts), a versions dir with an orphan, and a walked
//   symlink (never listed: rg's walk does not follow one)
const T0 = 1700000000;
const FILES_TREE = [
  // [relative path, contents | { symlink }, mtime in seconds (fractional), or undefined for a symlink]
  ['.git/HEAD', 'ref: x\n', T0 + 0.001],
  ['.gitignore', 'ignored.txt\n*.log\n', T0 + 0.002],
  ['ignored.txt', 'x\n', T0 + 9.5],
  ['x.log', 'x\n', T0 + 1.25],
  ['.hidden.txt', 'x\n', T0 + 3.75],
  ['a.txt', 'x\n', T0 + 7.000001],
  ['b.ts', 'x\n', T0 + 2.4],
  ['c.tsx', 'x\n', T0 + 2.4],
  ['d.js', 'x\n', T0 + 0.9],
  ['empty.txt', '', T0 + 6.5],
  ['bin.dat', Buffer.from([0x61, 0, 0x62, 0x0a]), T0 + 4.0],
  ['sub/e.txt', 'x\n', T0 + 7.0],
  ['sub/deep/f.txt', 'x\n', T0 + 5.1],
  ['sub/deep/g.TXT', 'x\n', T0 + 5.1],
  ['private/p.txt', 'x\n', T0 + 8.2],
  ['private/in/q.txt', 'x\n', T0 + 0.3],
  ['other/private', 'x\n', T0 + 8.1],
  ['code/{b}.ts', 'x\n', T0 + 3.3],
  ['versions/1.0/orphan.txt', 'x\n', T0 + 1.9],
  ['versions/2.0/keep.txt', 'x\n', T0 + 1.8],
  ['link.txt', { symlink: 'a.txt' }],
];
function makeFilesTree(fs, path, dir) {
  for (const [rel, data] of FILES_TREE) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (data && data.symlink) fs.symlinkSync(data.symlink, p);
    else fs.writeFileSync(p, data);
  }
  for (const [rel, data, t] of FILES_TREE) if (!(data && data.symlink)) fs.utimesSync(path.join(dir, ...rel.split('/')), t, t);
}
module.exports = { FILES_TREE, makeFilesTree };
