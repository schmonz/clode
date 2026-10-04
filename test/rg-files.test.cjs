'use strict';
// quaude's rg --files (grep-native Task 10: the Glob tool's argv, `--files --null --glob P --sort=modified
// --no-ignore --hidden [--iglob DENY...] [--glob !ORPHAN] TARGET`), answered through rg's walk
// (libexec/rg-walk.cjs), never the old ugrep/bfs translation (which leaked the Read-deny --iglobs). Native is the
// truth: P10_FILES_NATIVE is what 2.1.283's EMBEDDED rg (ripgrep 14.1.1 rev 7c1d0ed28a) printed over
// test/rg-files-cases.cjs's tree on darwin-arm64; linux-x64 native printed the same in a node:24.21.0-bookworm
// container (but one -j1 row's readdir order), and quaude's rg equalled it there row for row (2026-10-04). Rules,
// stated once in libexec/rg-native.cjs ("rg --files"):
//   RG-FILES          what the walk reaches, as it spells it, \n or \0; rc 0/1/2; a named file whatever the globs;
//                     the LAST of --files, -l, -c and --json decides the mode
//   RG-FILES-DENY     (RG-FILES's rows for the Grep/Glob tools' Read-deny `--iglob` shapes and the orphan `--glob`)
//   RG-SORT-MODIFIED  one thread, then by modification time to the nanosecond, stable; --sortr; a search sorts too
// [rule, cwd under the tree, argv (<ROOT>: the tree), exit status, stdout (latin1), stderr]
// Comparison: a sorted listing exactly, but for files of EQUAL time (two pairs in the tree), which keep the walk's
// order, which is the filesystem's readdir order: those compare as a set here, and their order has its own test
// (RG-SORT-MODIFIED, ties) against an independent opendir reading. An unsorted listing compares in any order
// (-j1's order is readdir's; the parallel walk's rg's own nondeterminism, the gate's named normalization).
const P10_FILES_NATIVE = [
  ["RG-FILES",".",["--files","--null","--glob","**/*.txt","--sort=modified","--no-ignore","--hidden","."],0,"./private/in/q.txt\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./.hidden.txt\u0000./sub/deep/f.txt\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./private/p.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/*.txt","--sort=modified","--no-ignore","--hidden","<ROOT>"],0,"<ROOT>/private/in/q.txt\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/.hidden.txt\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/private/p.txt\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/*.{ts,tsx}","--sort=modified","--no-ignore","--hidden","."],0,"./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/*.{ts,tsx}","--sort=modified","--no-ignore","--hidden","<ROOT>"],0,"<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/code/{b}.ts\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","*","--sort=modified","--no-ignore","--hidden","."],0,"./.git/HEAD\u0000./.gitignore\u0000./private/in/q.txt\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./other/private\u0000./private/p.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","*","--sort=modified","--no-ignore","--hidden","<ROOT>"],0,"<ROOT>/.git/HEAD\u0000<ROOT>/.gitignore\u0000<ROOT>/private/in/q.txt\u0000<ROOT>/d.js\u0000<ROOT>/x.log\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/code/{b}.ts\u0000<ROOT>/.hidden.txt\u0000<ROOT>/bin.dat\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/deep/g.TXT\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/other/private\u0000<ROOT>/private/p.txt\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","sub/**","--sort=modified","--no-ignore","--hidden","."],0,"./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./sub/e.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","sub/**","--sort=modified","--no-ignore","--hidden","<ROOT>"],0,"<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/deep/g.TXT\u0000<ROOT>/sub/e.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","*.TXT","--sort=modified","--no-ignore","--hidden","."],0,"./sub/deep/g.TXT\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","*.TXT","--sort=modified","--no-ignore","--hidden","<ROOT>"],0,"<ROOT>/sub/deep/g.TXT\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/private","--sort=modified","--no-ignore","--hidden","."],0,"./other/private\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/private","--sort=modified","--no-ignore","--hidden","<ROOT>"],0,"<ROOT>/other/private\u0000",""],
  ["RG-FILES","sub",["--files","--null","--glob","**/*.txt","--sort=modified","--no-ignore","--hidden","."],0,"./deep/f.txt\u0000./e.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/*.txt","--sort=modified","--no-ignore","--hidden","sub"],0,"sub/deep/f.txt\u0000sub/e.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","*.txt","--sort=modified","--no-ignore","--hidden","<ROOT>/sub"],0,"<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/e.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!/private","."],0,"./.git/HEAD\u0000./.gitignore\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./other/private\u0000./ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!/private","<ROOT>"],0,"<ROOT>/.git/HEAD\u0000<ROOT>/.gitignore\u0000<ROOT>/d.js\u0000<ROOT>/x.log\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/code/{b}.ts\u0000<ROOT>/.hidden.txt\u0000<ROOT>/bin.dat\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/deep/g.TXT\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/other/private\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!/private/**","--iglob","!/private","."],0,"./.git/HEAD\u0000./.gitignore\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./other/private\u0000./ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!/private/**","--iglob","!/private","<ROOT>"],0,"<ROOT>/.git/HEAD\u0000<ROOT>/.gitignore\u0000<ROOT>/d.js\u0000<ROOT>/x.log\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/code/{b}.ts\u0000<ROOT>/.hidden.txt\u0000<ROOT>/bin.dat\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/deep/g.TXT\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/other/private\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**/private","."],0,"./.git/HEAD\u0000./.gitignore\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**/private","<ROOT>"],0,"<ROOT>/.git/HEAD\u0000<ROOT>/.gitignore\u0000<ROOT>/d.js\u0000<ROOT>/x.log\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/code/{b}.ts\u0000<ROOT>/.hidden.txt\u0000<ROOT>/bin.dat\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/deep/g.TXT\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**/code/[{]b[}].ts","."],0,"./.git/HEAD\u0000./.gitignore\u0000./private/in/q.txt\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./other/private\u0000./private/p.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**/code/[{]b[}].ts","<ROOT>"],0,"<ROOT>/.git/HEAD\u0000<ROOT>/.gitignore\u0000<ROOT>/private/in/q.txt\u0000<ROOT>/d.js\u0000<ROOT>/x.log\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/.hidden.txt\u0000<ROOT>/bin.dat\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/sub/deep/g.TXT\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/other/private\u0000<ROOT>/private/p.txt\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**","."],1,"",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**","<ROOT>"],1,"",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**/SUB/**","--iglob","!**/SUB","."],0,"./.git/HEAD\u0000./.gitignore\u0000./private/in/q.txt\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./empty.txt\u0000./a.txt\u0000./other/private\u0000./private/p.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*","--sort=modified","--no-ignore","--hidden","--iglob","!**/SUB/**","--iglob","!**/SUB","<ROOT>"],0,"<ROOT>/.git/HEAD\u0000<ROOT>/.gitignore\u0000<ROOT>/private/in/q.txt\u0000<ROOT>/d.js\u0000<ROOT>/x.log\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/versions/1.0/orphan.txt\u0000<ROOT>/b.ts\u0000<ROOT>/c.tsx\u0000<ROOT>/code/{b}.ts\u0000<ROOT>/.hidden.txt\u0000<ROOT>/bin.dat\u0000<ROOT>/empty.txt\u0000<ROOT>/a.txt\u0000<ROOT>/other/private\u0000<ROOT>/private/p.txt\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES-DENY",".",["--files","--null","--glob","**/*.txt","--sort=modified","--no-ignore","--hidden","--glob","!**/versions/1.0/**","<ROOT>"],0,"<ROOT>/private/in/q.txt\u0000<ROOT>/versions/2.0/keep.txt\u0000<ROOT>/.hidden.txt\u0000<ROOT>/sub/deep/f.txt\u0000<ROOT>/empty.txt\u0000<ROOT>/sub/e.txt\u0000<ROOT>/a.txt\u0000<ROOT>/private/p.txt\u0000<ROOT>/ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/*","--sort=modified","."],0,"./.git/HEAD\u0000./.gitignore\u0000./private/in/q.txt\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./other/private\u0000./private/p.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","**/*","--sort=modified","--hidden","."],0,"./.git/HEAD\u0000./.gitignore\u0000./private/in/q.txt\u0000./d.js\u0000./x.log\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./b.ts\u0000./c.tsx\u0000./code/{b}.ts\u0000./.hidden.txt\u0000./bin.dat\u0000./sub/deep/f.txt\u0000./sub/deep/g.TXT\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./other/private\u0000./private/p.txt\u0000./ignored.txt\u0000",""],
  ["RG-FILES",".",["--files","-j1","--hidden","--no-ignore","."],0,"./empty.txt\n./d.js\n./b.ts\n./other/private\n./versions/1.0/orphan.txt\n./versions/2.0/keep.txt\n./code/{b}.ts\n./sub/deep/f.txt\n./sub/deep/g.TXT\n./sub/e.txt\n./a.txt\n./.gitignore\n./private/in/q.txt\n./private/p.txt\n./bin.dat\n./.hidden.txt\n./.git/HEAD\n./c.tsx\n./ignored.txt\n./x.log\n",""],
  ["RG-FILES",".",["--files","--hidden","--no-ignore","."],0,"./x.log\n./ignored.txt\n./c.tsx\n./b.ts\n./d.js\n./empty.txt\n./.gitignore\n./a.txt\n./.git/HEAD\n./.hidden.txt\n./bin.dat\n./private/p.txt\n./other/private\n./code/{b}.ts\n./versions/2.0/keep.txt\n./private/in/q.txt\n./versions/1.0/orphan.txt\n./sub/e.txt\n./sub/deep/g.TXT\n./sub/deep/f.txt\n",""],
  ["RG-FILES",".",["--files","."],0,"./c.tsx\n./bin.dat\n./private/p.txt\n./private/in/q.txt\n./a.txt\n./sub/e.txt\n./sub/deep/g.TXT\n./sub/deep/f.txt\n./code/{b}.ts\n./versions/2.0/keep.txt\n./versions/1.0/orphan.txt\n./other/private\n./b.ts\n./d.js\n./empty.txt\n",""],
  ["RG-FILES",".",["--files","--null","--glob","*.ts","--sort=modified","a.txt"],0,"a.txt\u0000",""],
  ["RG-FILES",".",["--files","--null","--glob","*.txt","--sort=modified","--no-ignore","--hidden","nosuch","."],2,"./private/in/q.txt\u0000./versions/2.0/keep.txt\u0000./versions/1.0/orphan.txt\u0000./.hidden.txt\u0000./sub/deep/f.txt\u0000./empty.txt\u0000./sub/e.txt\u0000./a.txt\u0000./private/p.txt\u0000./ignored.txt\u0000","rg: nosuch: IO error for operation on nosuch: No such file or directory (os error 2)\n"],
  ["RG-FILES",".",["--files","--null","--glob","*.nothing","--sort=modified","--no-ignore","--hidden","."],1,"",""],
  ["RG-FILES",".",["--files","-l","--null","--sort=modified","x","sub"],0,"sub/deep/f.txt\u0000sub/deep/g.TXT\u0000sub/e.txt\u0000",""],
  ["RG-FILES",".",["--json","--files","--sort=modified","sub"],0,"sub/deep/f.txt\nsub/deep/g.TXT\nsub/e.txt\n",""],
  ["RG-SORT-MODIFIED",".",["--files","--sort=modified","--hidden","--no-ignore","."],0,"./.git/HEAD\n./.gitignore\n./private/in/q.txt\n./d.js\n./x.log\n./versions/2.0/keep.txt\n./versions/1.0/orphan.txt\n./b.ts\n./c.tsx\n./code/{b}.ts\n./.hidden.txt\n./bin.dat\n./sub/deep/f.txt\n./sub/deep/g.TXT\n./empty.txt\n./sub/e.txt\n./a.txt\n./other/private\n./private/p.txt\n./ignored.txt\n",""],
  ["RG-SORT-MODIFIED",".",["--files","--sortr=modified","--hidden","--no-ignore","."],0,"./ignored.txt\n./private/p.txt\n./other/private\n./a.txt\n./sub/e.txt\n./empty.txt\n./sub/deep/f.txt\n./sub/deep/g.TXT\n./bin.dat\n./.hidden.txt\n./code/{b}.ts\n./b.ts\n./c.tsx\n./versions/1.0/orphan.txt\n./versions/2.0/keep.txt\n./x.log\n./d.js\n./private/in/q.txt\n./.gitignore\n./.git/HEAD\n",""],
  ["RG-SORT-MODIFIED",".",["--files","--sort","modified","--sortr=none","-j1","--hidden","--no-ignore","."],0,"./empty.txt\n./d.js\n./b.ts\n./other/private\n./versions/1.0/orphan.txt\n./versions/2.0/keep.txt\n./code/{b}.ts\n./sub/deep/f.txt\n./sub/deep/g.TXT\n./sub/e.txt\n./a.txt\n./.gitignore\n./private/in/q.txt\n./private/p.txt\n./bin.dat\n./.hidden.txt\n./.git/HEAD\n./c.tsx\n./ignored.txt\n./x.log\n",""],
  ["RG-SORT-MODIFIED",".",["--files","--sort=bogus","."],2,"","rg: error parsing flag --sort: choice 'bogus' is unrecognized\n"],
  ["RG-SORT-MODIFIED",".",["--files","--sort=modified","--hidden","--no-ignore","link.txt","sub","b.ts","c.tsx"],0,"b.ts\nc.tsx\nsub/deep/f.txt\nsub/deep/g.TXT\nsub/e.txt\nlink.txt\n",""],
  ["RG-SORT-MODIFIED",".",["-l","--sort=modified","--hidden","--no-ignore","x","."],0,"./.git/HEAD\n./.gitignore\n./private/in/q.txt\n./d.js\n./x.log\n./versions/2.0/keep.txt\n./versions/1.0/orphan.txt\n./b.ts\n./c.tsx\n./code/{b}.ts\n./.hidden.txt\n./sub/deep/f.txt\n./sub/deep/g.TXT\n./sub/e.txt\n./a.txt\n./other/private\n./private/p.txt\n./ignored.txt\n",""],
  ["RG-SORT-MODIFIED",".",["-c","--sortr=modified","--hidden","--no-ignore","x","."],0,"./ignored.txt:1\n./private/p.txt:1\n./other/private:1\n./a.txt:1\n./sub/e.txt:1\n./sub/deep/f.txt:1\n./sub/deep/g.TXT:1\n./.hidden.txt:1\n./code/{b}.ts:1\n./b.ts:1\n./c.tsx:1\n./versions/1.0/orphan.txt:1\n./versions/2.0/keep.txt:1\n./x.log:1\n./d.js:1\n./private/in/q.txt:1\n./.gitignore:1\n./.git/HEAD:1\n",""],
  ["RG-SORT-MODIFIED",".",["--json","--sort=modified","x","sub"],0,"{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"sub/deep/f.txt\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"sub/deep/f.txt\"},\"lines\":{\"text\":\"x\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"x\"},\"start\":0,\"end\":1}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"sub/deep/f.txt\"},\"binary_offset\":null,\"stats\":{\"elapsed\":{\"secs\":0,\"nanos\":11708,\"human\":\"0.000012s\"},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":2,\"bytes_printed\":233,\"matched_lines\":1,\"matches\":1}}}\n{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"sub/deep/g.TXT\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"sub/deep/g.TXT\"},\"lines\":{\"text\":\"x\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"x\"},\"start\":0,\"end\":1}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"sub/deep/g.TXT\"},\"binary_offset\":null,\"stats\":{\"elapsed\":{\"secs\":0,\"nanos\":3334,\"human\":\"0.000003s\"},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":2,\"bytes_printed\":233,\"matched_lines\":1,\"matches\":1}}}\n{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"sub/e.txt\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"sub/e.txt\"},\"lines\":{\"text\":\"x\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"x\"},\"start\":0,\"end\":1}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"sub/e.txt\"},\"binary_offset\":null,\"stats\":{\"elapsed\":{\"secs\":0,\"nanos\":3000,\"human\":\"0.000003s\"},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":2,\"bytes_printed\":223,\"matched_lines\":1,\"matches\":1}}}\n{\"data\":{\"elapsed_total\":{\"human\":\"0.000438s\",\"nanos\":437917,\"secs\":0},\"stats\":{\"bytes_printed\":689,\"bytes_searched\":6,\"elapsed\":{\"human\":\"0.000018s\",\"nanos\":18042,\"secs\":0},\"matched_lines\":3,\"matches\":3,\"searches\":3,\"searches_with_match\":3}},\"type\":\"summary\"}\n",""]
];

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const rgn = require('../libexec/rg-native.cjs');
const { tjsPath, runLoader } = require('./node-shim-helper.cjs');
const { missingExtDeps } = require('./shim-surface/collect.cjs');
const { providerBin } = require('./provider-resolve.cjs');
const { FILES_TREE, makeFilesTree } = require('./rg-files-cases.cjs');

const NO_TJS = !tjsPath() ? 'no tjs engine' : (() => {
  const missing = missingExtDeps();
  return missing.length ? `the shim's ext-dep closure is not installed (${missing.join(', ')}; npm ci --prefix deps/claude)` : false;
})();
const POSIX = process.platform === 'win32' ? 'rg\'s Windows path spelling is unmeasured (BACKLOG)' : false;

async function withTree(fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-files-')));
  const root = path.join(base, 'gl');
  try { makeFilesTree(fs, path, root); return await fn(root, base); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
const l1 = (b) => Buffer.from(b).toString('latin1');
// The value of the last --sort / --sortr (rg: the last one given wins), or null.
function sortOf(argv) {
  let v = null;
  argv.forEach((a, i) => {
    const m = /^--sortr?(?:=(.*))?$/.exec(a);
    if (m) v = m[1] !== undefined ? m[1] : argv[i + 1];
  });
  return v && v !== 'none' ? v : null;
}
// A file's time, by its name (every file's name in the tree is its own; a symlink has its target's).
const TIME = new Map();
for (const [rel, data, t] of FILES_TREE) TIME.set(path.basename(rel), t);
for (const [rel, data] of FILES_TREE) if (data && data.symlink) TIME.set(path.basename(rel), TIME.get(data.symlink));
// A listing as groups of equal time, each group's names sorted (the order WITHIN a group is readdir's).
function timeGroups(recs) {
  const out = [];
  for (const r of recs) {
    const t = TIME.get(path.basename(r.replace(/[\0\n]$/, '')));
    const last = out[out.length - 1];
    if (last && t !== undefined && last.t === t) last.recs.push(r); else out.push({ t, recs: [r] });
  }
  return out.map((g) => g.recs.sort().join(''));
}
const records = (s, sep) => s.split(sep).filter(Boolean).map((x) => x + sep);
function check(row, got, root) {
  const [rule, , argv, status, out, err] = row;
  const want = out.split('<ROOT>').join(root);
  const what = `${rule}: rg ${argv.join(' ')} => ${JSON.stringify(got).slice(0, 800)}`;
  assert.strictEqual(got.status, status, what);
  assert.strictEqual(got.stderr, err.split('<ROOT>').join(root), what);
  const sep = argv.includes('--null') ? '\0' : '\n';
  const elapsed = (x) => x.replace(/"(elapsed|elapsed_total)":\{[^{}]*\}/g, '"$1":{}');   // rg-probe's named normalization 2
  if (argv.includes('--json')) assert.strictEqual(elapsed(got.stdout), elapsed(want), what);
  else if (sortOf(argv)) assert.deepStrictEqual(timeGroups(records(got.stdout, sep)), timeGroups(records(want, sep)), what);
  else assert.deepStrictEqual(records(got.stdout, sep).sort(), records(want, sep).sort(), what);
}
const NOT_TRANSLATED = () => { throw new Error('nothing reaches the old translation'); };
function syncRun(root, [, cwdRel, argv]) {
  const r = rgn.runRg(argv.map((a) => a.split('<ROOT>').join(root)), { cwd: path.join(root, cwdRel), spawnSync: cp.spawnSync, translate: NOT_TRANSLATED,
    ugrep: () => null, matchFiles: rgn.matchFilesAlone });
  return { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) };
}
function asyncRun(root, [, cwdRel, argv]) {
  return new Promise((resolve) => {
    const child = rgn.rgExecFile(argv.map((a) => a.split('<ROOT>').join(root)), { cwd: path.join(root, cwdRel), encoding: 'buffer' }, (err, so, se) => resolve({
      status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }),
    'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
    if (child.stdin) child.stdin.end();
  });
}

const RULES = [...new Set(P10_FILES_NATIVE.map((r) => r[0]))];
for (const rule of RULES) {
  test(`${rule}: runRg lists as native (native)`, { skip: POSIX }, () => withTree((root) => {
    for (const row of P10_FILES_NATIVE.filter((r) => r[0] === rule)) check(row, syncRun(root, row), root);
  }));
}
test('RG-FILES, RG-SORT-MODIFIED: the async twin lists every row as the sync one does (rgExecFile, native)', { skip: POSIX }, () => withTree(async (root) => {
  for (const row of P10_FILES_NATIVE) check(row, await asyncRun(root, row), root);
}));
test('RG-FILES, RG-SORT-MODIFIED: under tjs, both twins, every row (native; node-shim\'s stat to the nanosecond, ruling G12)', {
  skip: POSIX || NO_TJS,
}, () => withTree((root) => {
  const prog = path.join(root, '..', 'probe.cjs');
  fs.writeFileSync(prog, `
    const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
    const cp = require('child_process'), path = require('path');
    const root = ${JSON.stringify(root)};
    const rows = ${JSON.stringify(P10_FILES_NATIVE.map((r) => [r[1], r[2]]))};
    const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone };
    const l1 = (b) => Buffer.from(b).toString('latin1');
    (async () => {
      const out = [];
      for (const [cwdRel, argv0] of rows) {
        const argv = argv0.map((a) => a.split('<ROOT>').join(root)), cwd = path.join(root, cwdRel);
        const s = rgn.runRg(argv, { ...ctx, cwd });
        const a = await new Promise((res) => {
          const c = rgn.rgExecFile(argv, { cwd, encoding: 'buffer' }, (err, so, se) => res({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx);
          if (c.stdin) c.stdin.end();
        });
        out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
      }
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `);
  const res = runLoader(prog, [], { timeout: 120000 });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
  assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
  const got = JSON.parse(line.slice('PROBE:'.length));
  assert.strictEqual(got.length, P10_FILES_NATIVE.length);
  P10_FILES_NATIVE.forEach((row, i) => { check(row, got[i].sync, root); check(row, got[i].async, root); });
}));

// RG-SORT-MODIFIED's ties: files of EQUAL time keep rg's one-thread walk order, depth first in readdir order (an
// independent reading of the filesystem here, opendir's raw order: the tree's b.ts/c.tsx in its root and
// f.txt/g.TXT in sub/deep), whichever the filesystem gives; --sortr reverses the times, never the ties; named roots
// keep their argv order. The tree's mtimes are measured back first (a filesystem whose clock is coarser than the
// tree's sub-second times would tie more files: the claim is then not this tree's).
function readdirOrder(dir) {
  const d = fs.opendirSync(dir), out = [];
  try { for (let e; (e = d.readSync());) out.push(e.name); } finally { d.closeSync(); }
  return out;
}
test('RG-SORT-MODIFIED: equal times keep the walk\'s readdir order, --sortr keeps it too, named roots their argv order', { skip: POSIX }, () => withTree((root) => {
  for (const [rel, data, t] of FILES_TREE) {
    if (data && data.symlink) continue;
    const ns = fs.statSync(path.join(root, rel), { bigint: true }).mtimeNs;
    assert.ok(Math.abs(Number(ns) / 1e9 - t) < 2e-6, `${rel}: the filesystem kept ${ns} ns for ${t} s; this tree needs microseconds`);
  }
  const before = (dir, a, b) => { const o = readdirOrder(dir); return o.indexOf(a) < o.indexOf(b) ? [a, b] : [b, a]; };
  const [t1, t2] = before(root, 'b.ts', 'c.tsx');
  const [d1, d2] = before(path.join(root, 'sub', 'deep'), 'f.txt', 'g.TXT');
  const list = (argv) => l1(rgn.runRg(argv, { cwd: root, spawnSync: cp.spawnSync, ugrep: () => null }).stdout).split('\n').filter(Boolean);
  const asc = list(['--files', '--sort=modified', '--hidden', '--no-ignore', '.']);
  const desc = list(['--files', '--sortr=modified', '--hidden', '--no-ignore', '.']);
  for (const L of [asc, desc]) {
    assert.ok(L.indexOf(`./${t1}`) + 1 === L.indexOf(`./${t2}`), `${t1} then ${t2}: ${L}`);
    assert.ok(L.indexOf(`./sub/deep/${d1}`) + 1 === L.indexOf(`./sub/deep/${d2}`), `${d1} then ${d2}: ${L}`);
  }
  assert.deepStrictEqual(list(['--files', '--sort=modified', 'c.tsx', 'b.ts']), ['c.tsx', 'b.ts']);
}));

// RULING G12, end to end: files written within ONE second, their times as the filesystem gave them (none set):
// native's --sort=modified order is quaude's under tjs (node-shim's stat once reported whole seconds, so such files
// came out in walk order). Native is run where a provider is at hand; the times are also judged sub-second under tjs.
const NATIVE = (() => { try { return providerBin(); } catch { return null; } })();
test('RG-SORT-MODIFIED (ruling G12): files written within one second list in native\'s order under tjs (native)', {
  skip: POSIX || NO_TJS || (!NATIVE ? 'no native provider' : false),
}, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-g12-')));
  try {
    const names = ['m.txt', 'z.txt', 'a.txt', 'q/k.txt', 'b.txt', 'q/c.txt', 'y.txt', 'e.txt'];
    fs.mkdirSync(path.join(base, 'q'));
    const t0 = Date.now();
    for (const n of names) { fs.writeFileSync(path.join(base, n), 'x\n'); const until = Date.now() + 15; while (Date.now() < until) { /* apart */ } }
    assert.ok(Date.now() - t0 < 1000, 'written within one second');
    const argv = ['--files', '--null', '--glob', '**/*.txt', '--sort=modified', '--no-ignore', '--hidden', '.'];
    const nat = cp.spawnSync(NATIVE, ['--no-config', ...argv], { cwd: base, argv0: 'rg', encoding: 'latin1' });
    assert.strictEqual(nat.status, 0, nat.stderr);
    const prog = path.join(base, '..', path.basename(base) + '-g12.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process'), fs = require('fs');
      const r = rgn.runRg(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(base)}, spawnSync: cp.spawnSync, ugrep: () => null });
      const ns = ${JSON.stringify(names)}.map((n) => String(fs.statSync(${JSON.stringify(base)} + '/' + n, { bigint: true }).mtimeNs));
      process.stdout.write('PROBE:' + JSON.stringify({ out: r.stdout.toString('latin1'), ns }) + '\\n');
    `);
    try {
      const res = runLoader(prog, [], { timeout: 60000 });
      const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
      assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
      const got = JSON.parse(line.slice('PROBE:'.length));
      assert.strictEqual(got.out, nat.stdout, 'quaude\'s order under tjs is native\'s');
      assert.deepStrictEqual(got.ns, names.map((n) => String(fs.statSync(path.join(base, n), { bigint: true }).mtimeNs)), 'tjs stat\'s mtimeNs is node\'s');
      assert.ok(new Set(got.ns.map((x) => x.slice(0, -9))).size < names.length, 'some files share a second (the case G12 is about)');
    } finally { fs.rmSync(prog, { force: true }); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
