'use strict';
// The trees test/rg-walk.test.cjs measures rg's walk over (grep-native Task 9), built here byte for byte
// so the test and the generator of its native literals build the SAME trees. Each tree is a list of
// [relative path, contents | { symlink: target } | { dir: true }]; a HOME is a tree too (the global
// gitignore rows give rg a sandbox HOME, as the differential does).
//
//   repo     a git repo: .gitignore (a file, a dir/, a whitelist, an extension, an anchored name),
//            .ignore, .rgignore (whitelisting what .ignore ignores: .rgignore wins), .git/info/exclude,
//            a hidden file, a deeper .gitignore whitelisting what the top one ignores, an ignored dir,
//            a private dir (the deny-glob shapes), code files for --type, and two symlinks
//   norepo   .gitignore and .ignore with no repo anywhere above
//   wt       a .git FILE (a worktree's), pointing nowhere
//   up       a repo whose .gitignore applies to up/inner, searched from inside it
//   nested   top/.ignore over top/tree: rg's parent-directory rules, matched as rg rebuilds the path
//   badig    ignore files with lines that do not parse, a line that is not UTF-8, and the escapes
//   bomig    a .gitignore that starts with a UTF-8 BOM (rg reads it as part of the first line) and has CRLFs
//   shared   one .gitignore over several roots searched at once (rg's ancestors are built once, by the first)
//   h1 h2    HOMEs: XDG's git/ignore; ~/.gitconfig's core.excludesFile with a ~
const NEEDLE = 'needle\n';
const TREES = {
  repo: [
    ['.git/HEAD', NEEDLE], ['.git/info/exclude', 'excl.txt\n'],
    ['.gitignore', 'ign.txt\nigndir/\n*.ign\n!keep.ign\n/anch.txt\n'],
    ['.ignore', 'dotig.txt\nboth.txt\n'], ['.rgignore', '!dotig.txt\nrgig.txt\n'],
    ['a.txt', NEEDLE], ['ign.txt', NEEDLE], ['keep.ign', NEEDLE], ['x.ign', NEEDLE], ['anch.txt', NEEDLE], ['excl.txt', NEEDLE],
    ['dotig.txt', NEEDLE], ['rgig.txt', NEEDLE], ['both.txt', NEEDLE], ['.hid.txt', NEEDLE], ['g1.txt', NEEDLE], ['g2.txt', NEEDLE],
    ['sub/.gitignore', '!ign.txt\n'], ['sub/ign.txt', NEEDLE], ['sub/anch.txt', NEEDLE], ['sub/x.ign', NEEDLE],
    ['igndir/f.txt', NEEDLE],
    ['private/p.txt', NEEDLE], ['private/in/q.txt', NEEDLE], ['other/private', NEEDLE],
    ['code/x.ts', NEEDLE], ['code/y.tsx', NEEDLE], ['code/z.js', NEEDLE], ['code/README.md', NEEDLE], ['code/Makefile', NEEDLE],
    ['code/a.TXT', NEEDLE], ['code/.h.ts', NEEDLE], ['code/{b}.ts', NEEDLE], ['code/*.txt', NEEDLE],
    ['link.txt', { symlink: 'a.txt' }], ['linkdir', { symlink: 'sub' }],
  ],
  norepo: [
    ['.gitignore', 'i1.txt\n'], ['.ignore', 'skip.txt\n'], ['i1.txt', NEEDLE], ['skip.txt', NEEDLE], ['plain.txt', NEEDLE], ['g1.txt', NEEDLE],
  ],
  wt: [['.git', 'gitdir: /nonexistent/wt\n'], ['.gitignore', 'i1.txt\n'], ['i1.txt', NEEDLE], ['plain.txt', NEEDLE], ['g1.txt', NEEDLE]],
  up: [['.git/HEAD', 'x\n'], ['.gitignore', 'i1.txt\n'], ['inner/i1.txt', NEEDLE], ['inner/plain.txt', NEEDLE], ['inner/g1.txt', NEEDLE]],
  nested: [
    ['top/.ignore', 'c.txt\ntree/sub/b.txt\n'],
    ['top/tree/a.txt', NEEDLE], ['top/tree/c.txt', NEEDLE], ['top/tree/sub/b.txt', NEEDLE], ['top/tree/sub/c.txt', NEEDLE],
    ['top/tree/sub/deep/b.txt', NEEDLE], ['top/tree/sub/deep/c.txt', NEEDLE],
  ],
  badig: [
    ['.git/HEAD', 'x\n'], ['.gitignore', 'a.txt\n[z-a]\n{x\nb.txt\n'],
    ['.ignore', Buffer.concat([Buffer.from('c.txt\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('d.txt\n')])],
    ['s/.ignore', '[q\n'], ['s/sub/.rgignore', '\\!x.txt\n\\#y.txt\ntrail.txt   \nkeep\\ \n'],
    ['a.txt', NEEDLE], ['b.txt', NEEDLE], ['c.txt', NEEDLE], ['d.txt', NEEDLE],
    ['s/a.txt', NEEDLE], ['s/b.txt', NEEDLE], ['s/c.txt', NEEDLE], ['s/d.txt', NEEDLE],
    ['s/sub/!x.txt', NEEDLE], ['s/sub/#y.txt', NEEDLE], ['s/sub/trail.txt', NEEDLE], ['s/sub/keep ', NEEDLE], ['s/sub/keep', NEEDLE],
  ],
  bomig: [
    ['.git/HEAD', 'x\n'], ['.gitignore', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('*.log\r\nfoo.txt\r\n')])],
    ['a.log', NEEDLE], ['foo.txt', NEEDLE], ['ok.txt', NEEDLE],
  ],
  shared: [
    ['.git/HEAD', 'x\n'], ['.gitignore', 'docs/*.md\n**/gen/**\n'],
    ['docs/a.md', NEEDLE], ['docs/sub/b.md', NEEDLE], ['sub/docs/c.md', NEEDLE], ['gen/g.txt', NEEDLE], ['sub/gen/g2.txt', NEEDLE],
    ['sub/x.txt', NEEDLE], ['ok.txt', NEEDLE],
  ],
  h1: [['.config/git/ignore', 'g1.txt\n']],
  h2: [['.gitconfig', '[core]\n\texcludesFile = ~/x/ex\n'], ['x/ex', 'g2.txt\n']],
};

function makeWalkTree(fs, path, dir, name) {
  for (const [rel, data] of TREES[name]) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (data && data.symlink) fs.symlinkSync(data.symlink, p);
    else if (data && data.dir) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, data);
  }
  return dir;
}

module.exports = { TREES, makeWalkTree };
