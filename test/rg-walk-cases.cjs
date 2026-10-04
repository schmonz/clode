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
//   uni      a non-ASCII file name, for globs over bytes
//   plugcache, skills   2.1.283's production --max-depth 4 listings (orphaned plugin versions; skills, rt)
//   links, linksout, linksrepo   symlinks for -L/--follow (2.1.283's FileIndex fallback), outside and inside a repo
//   errs     paths whose errors rg words in its libc's text (RG-ERROR-TEXT)
//   envscan  2.1.283's environment scan (eo()): --no-messages, --max-filesize, -o -H --null over config files
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
  // 2.1.283's production --max-depth listings (grep-native Task 10 fix round, review I-1): a plugin cache whose
  // version dirs carry an empty `.orphaned_at` (orphanedVersionGlobExclusions: --max-depth 4 from the cache), and a
  // skills tree (rt: --max-depth 4, -g SKILL.md -g *.md); one marker and one .md each sit too deep
  plugcache: [
    ['mkt/plug/1.0/.orphaned_at', ''], ['mkt/plug/2.0/a.txt', NEEDLE], ['mkt/plug/2.0/deep/.orphaned_at', ''], ['mkt/.orphaned_at', ''],
    ['mkt/other/0.1/x.txt', NEEDLE],
  ],
  skills: [
    ['README.md', NEEDLE], ['m/SKILL.md', NEEDLE], ['m/n/x.md', NEEDLE], ['m/n/o/deep.md', NEEDLE], ['m/n/o/p/deeper.md', NEEDLE],
    ['node_modules/p/SKILL.md', NEEDLE], ['.git/x.md', NEEDLE], ['notes.txt', NEEDLE],
  ],
  // RG-WALK-FOLLOW (2.1.283's FileIndex fallback outside a repo: --files --follow --hidden ... [--no-ignore-vcs]):
  // a link to a directory, to a file, to nowhere, to a directory outside the tree, and one back to an ancestor
  links: [
    ['real/a.md', NEEDLE], ['real/sub/b.md', NEEDLE], ['ldir', { symlink: 'real' }], ['lfile.md', { symlink: 'real/a.md' }],
    ['broken.md', { symlink: 'nowhere' }], ['real/sub/loop', { symlink: '..' }], ['lout', { symlink: '../linksout' }],
    ['.gitignore', 'ign.md\n'], ['ign.md', NEEDLE], ['.ignore', 'dot.md\n'], ['dot.md', NEEDLE],
  ],
  linksout: [['o.md', NEEDLE]],
  // RG-NO-MESSAGES and RG-MAX-FILESIZE (2.1.283's environment scan eo(): -o -H --null --no-messages --max-filesize 4M
  // over config files for s3://, gs:// and az:// URLs): one file past 4 MiB, one exactly at it, a hidden one, one the
  // globs leave out, node_modules, and an .ignore line that does not parse (a message --no-messages withholds)
  envscan: [
    ['cfg/a.toml', 'bucket = "s3://my-bucket/path"\nother = "gs://g-b.x/y"\nnone\nAZ://NOPE az://ok-1\n'],
    ['b.json', '{"u":"s3://json-b"}\n'], ['c.txt', 's3://not-in-txt\n'], ['node_modules/x/m.json', 's3://in-node-modules\n'],
    ['.h.yml', 'k: s3://hidden\n'], ['big.yaml', 'x: s3://big-bucket\n' + 'y'.repeat(4 * 1048576) + '\n'],
    ['atlimit.yaml', `x: s3://at-limit\n${'y'.repeat(4 * 1048576 - 18)}\n`], ['.ignore', '[z-a]\n'],
  ],
  // RG-ERROR-TEXT: errnos whose libc text libuv words differently (a link to itself: ELOOP; one through a loop of
  // two), next to a broken link (ENOENT) and a file to search
  errs: [['ok.txt', NEEDLE], ['self', { symlink: 'self' }], ['gone', { symlink: 'nowhere' }], ['dd/lp', { symlink: '../dd/lp' }]],
  linksrepo: [
    ['.git/HEAD', 'x\n'], ['real/a.md', NEEDLE], ['ldir', { symlink: 'real' }], ['.gitignore', 'ign.md\n'], ['ign.md', NEEDLE],
    ['.ignore', 'dot.md\n'], ['dot.md', NEEDLE],
  ],
  // a non-ASCII name (built from its code point: never a literal in source); globs match its UTF-8 BYTES
  uni: [[`caf${String.fromCodePoint(0xe9)}.txt`, NEEDLE], ['plain.txt', NEEDLE]],
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
