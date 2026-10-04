'use strict';
// quaude's rg's WALK, judged against native's embedded rg (grep-native Task 9; the rules are stated once in
// libexec/rg-walk.cjs, the type table and version text in libexec/rg-types.cjs).
//
// P9_NATIVE: [rule, tree, cwd (relative to the tree), argv (`<T>` is the tree's absolute path), HOME (a
// tree of test/rg-walk-cases.cjs; `xdg-h1`: an empty HOME and XDG_CONFIG_HOME at h1's .config), rc, stdout,
// stderr], as native 2.1.283's embedded rg (ripgrep 14.1.1, darwin-arm64) printed them over these trees
// (measured 2026-10-04; the generator is in the task-9 report). Each row runs four ways: sync over ugrep,
// with the matcher alone (no ugrep), the async twin, and under tjs (both twins). Order: the rows compare
// rg's records order-insensitively (normalizeRg), because readdir's order belongs to the filesystem the
// trees are written on; RG-WALK-ORDER is judged by its own tests below, against the readdir order of the
// filesystem they run on and, where a native is at hand, against native there.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const rgn = require('../libexec/rg-native.cjs');
const rgWalk = require('../libexec/rg-walk.cjs');
const rgTypes = require('../libexec/rg-types.cjs');
const { normalizeRg } = require('../scripts/lib/rg-probe.cjs');
const { TREES, makeWalkTree } = require('./rg-walk-cases.cjs');
const { tjsPath, runLoader } = require('./node-shim-helper.cjs');
const { missingExtDeps } = require('./shim-surface/collect.cjs');
const { providerBin } = require('./provider-resolve.cjs');

const NO_TJS = !tjsPath() ? 'no tjs engine' : (() => {
  const missing = missingExtDeps();
  return missing.length ? `the shim's ext-dep closure is not installed (${missing.join(', ')}; npm ci --prefix deps/claude)` : false;
})();
function hostUgrep() {
  if (process.env.CLODE_UGREP) return process.env.CLODE_UGREP;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const x of exts) { const p = path.join(d, 'ugrep' + x); if (d && fs.existsSync(p)) return p; }
  }
  return null;
}
const UGREP = hostUgrep();
const CAPS = UGREP ? rgn.ugrepCapabilities(UGREP) : null;
// The trees hold names Windows cannot (`*.txt`, a trailing space) and symlinks; rg's own walk there
// (`\` joins, FILE_ATTRIBUTE_HIDDEN) is unmeasured (BACKLOG).
const POSIX = process.platform === 'win32' ? 'the walk on Windows is unmeasured (BACKLOG); these trees hold names it cannot' : false;
const needUgrep = { skip: POSIX || (!UGREP ? 'no ugrep on this host' : !CAPS.format ? CAPS.reason : false) };
const NATIVE = providerBin(process.env);
const NOT_TRANSLATED = () => { throw new Error('a walked search never reaches the translation'); };

const P9_NATIVE = [
  ["RG-IGNORE-FILES", "repo", ".", ["-j1", "-l", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-IGNORE-FILES", "repo", ".", ["-j1", "-l", "needle", "<T>"], "empty", 0, "<T>/g2.txt\n<T>/g1.txt\n<T>/other/private\n<T>/code/y.tsx\n<T>/code/{b}.ts\n<T>/code/Makefile\n<T>/code/*.txt\n<T>/code/README.md\n<T>/code/x.ts\n<T>/code/a.TXT\n<T>/code/z.js\n<T>/keep.ign\n<T>/dotig.txt\n<T>/sub/ign.txt\n<T>/sub/anch.txt\n<T>/a.txt\n<T>/private/in/q.txt\n<T>/private/p.txt\n", ""],
  ["RG-IGNORE-REPO", "repo", "sub", ["-j1", "-l", "needle", "."], "empty", 0, "./ign.txt\n./anch.txt\n", ""],
  ["RG-IGNORE-REPO", "repo", "sub", ["-j1", "-l", "needle", ".."], "empty", 0, "../g2.txt\n../g1.txt\n../other/private\n../code/y.tsx\n../code/{b}.ts\n../code/Makefile\n../code/*.txt\n../code/README.md\n../code/x.ts\n../code/a.TXT\n../code/z.js\n../keep.ign\n../dotig.txt\n../sub/ign.txt\n../sub/anch.txt\n../a.txt\n../private/in/q.txt\n../private/p.txt\n", ""],
  ["RG-IGNORE-REPO", "norepo", ".", ["-j1", "-l", "needle", "."], "empty", 0, "./g1.txt\n./i1.txt\n./plain.txt\n", ""],
  ["RG-IGNORE-REPO", "wt", ".", ["-j1", "-l", "needle", "."], "empty", 0, "./g1.txt\n./plain.txt\n", ""],
  ["RG-IGNORE-REPO", "up", "inner", ["-j1", "-l", "needle", "."], "empty", 0, "./g1.txt\n./plain.txt\n", ""],
  ["RG-IGNORE-GLOBAL", "repo", ".", ["-j1", "-l", "needle", "."], "h1", 0, "./g2.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-IGNORE-GLOBAL", "repo", ".", ["-j1", "-l", "needle", "."], "h2", 0, "./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-IGNORE-GLOBAL", "repo", ".", ["-j1", "-l", "needle", "."], "xdg-h1", 0, "./g2.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-IGNORE-GLOBAL", "norepo", ".", ["-j1", "-l", "needle", "."], "h1", 0, "./g1.txt\n./i1.txt\n./plain.txt\n", ""],
  ["RG-IGNORE-GLOBAL", "wt", ".", ["-j1", "-l", "needle", "."], "h1", 0, "./plain.txt\n", ""],
  ["RG-IGNORE-GLOBAL", "up", "inner", ["-j1", "-l", "needle", "."], "h2", 0, "./g1.txt\n./plain.txt\n", ""],
  ["RG-IGNORE-PARENTS", "nested", "top/tree", ["-j1", "-l", "needle", "."], "empty", 0, "./sub/deep/b.txt\n./sub/b.txt\n./a.txt\n", ""],
  ["RG-IGNORE-PARENTS", "nested", "top/tree/sub", ["-j1", "-l", "needle", "."], "empty", 1, "", ""],
  ["RG-IGNORE-PARENTS", "nested", "top/tree/sub", ["-j1", "-l", "needle", ".."], "empty", 0, "../sub/deep/b.txt\n../sub/b.txt\n../a.txt\n", ""],
  ["RG-IGNORE-PARENTS", "nested", "top/tree", ["-j1", "-l", "needle", "<T>/top/tree/sub"], "empty", 1, "", ""],
  ["RG-NO-IGNORE", "repo", ".", ["-j1", "-l", "--no-ignore", "needle", "."], "h1", 0, "./g2.txt\n./g1.txt\n./igndir/f.txt\n./excl.txt\n./rgig.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./sub/x.ign\n./both.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./ign.txt\n./anch.txt\n./x.ign\n", ""],
  ["RG-NO-IGNORE", "nested", "top/tree", ["-j1", "-l", "--no-ignore", "needle", "."], "empty", 0, "./c.txt\n./sub/deep/c.txt\n./sub/deep/b.txt\n./sub/c.txt\n./sub/b.txt\n./a.txt\n", ""],
  ["RG-HIDDEN", "repo", ".", ["-j1", "-l", "--hidden", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-HIDDEN", "repo", ".", ["-j1", "-l", "-.", "--no-ignore", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./igndir/f.txt\n./excl.txt\n./rgig.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./sub/x.ign\n./both.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./ign.txt\n./anch.txt\n./x.ign\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-HIDDEN", "repo", ".", ["-j1", "-l", "--glob", "*.txt", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./excl.txt\n./rgig.txt\n./code/*.txt\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./both.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./ign.txt\n./anch.txt\n./.hid.txt\n", ""],
  ["RG-HIDDEN", "repo", ".", ["-j1", "-l", "--glob", "!a.txt", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-HIDDEN", "repo", ".", ["-j1", "-l", "--type", "ts", "needle", "."], "empty", 0, "./code/y.tsx\n./code/{b}.ts\n./code/.h.ts\n./code/x.ts\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "!.git", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "!private", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "!private/", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!/private", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!/private", "needle", "<T>"], "empty", 0, "<T>/g2.txt\n<T>/g1.txt\n<T>/other/private\n<T>/code/y.tsx\n<T>/code/{b}.ts\n<T>/code/Makefile\n<T>/code/*.txt\n<T>/code/.h.ts\n<T>/code/README.md\n<T>/code/x.ts\n<T>/code/a.TXT\n<T>/code/z.js\n<T>/keep.ign\n<T>/dotig.txt\n<T>/sub/ign.txt\n<T>/sub/anch.txt\n<T>/a.txt\n<T>/.git/HEAD\n<T>/.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", "sub", ["-j1", "-l", "--hidden", "--iglob", "!/private", "needle", "<T>"], "empty", 0, "<T>/g2.txt\n<T>/g1.txt\n<T>/other/private\n<T>/code/y.tsx\n<T>/code/{b}.ts\n<T>/code/Makefile\n<T>/code/*.txt\n<T>/code/.h.ts\n<T>/code/README.md\n<T>/code/x.ts\n<T>/code/a.TXT\n<T>/code/z.js\n<T>/keep.ign\n<T>/dotig.txt\n<T>/sub/ign.txt\n<T>/sub/anch.txt\n<T>/a.txt\n<T>/private/in/q.txt\n<T>/private/p.txt\n<T>/.git/HEAD\n<T>/.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!/private/**", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!private/**", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!**/private/**", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!<T>/private/**", "needle", "<T>"], "empty", 0, "<T>/g2.txt\n<T>/g1.txt\n<T>/other/private\n<T>/code/y.tsx\n<T>/code/{b}.ts\n<T>/code/Makefile\n<T>/code/*.txt\n<T>/code/.h.ts\n<T>/code/README.md\n<T>/code/x.ts\n<T>/code/a.TXT\n<T>/code/z.js\n<T>/keep.ign\n<T>/dotig.txt\n<T>/sub/ign.txt\n<T>/sub/anch.txt\n<T>/a.txt\n<T>/private/in/q.txt\n<T>/private/p.txt\n<T>/.git/HEAD\n<T>/.hid.txt\n", ""],
  ["RG-GLOB-EXCLUDES-DIRS", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "!<T>/private", "needle", "<T>"], "empty", 0, "<T>/g2.txt\n<T>/g1.txt\n<T>/other/private\n<T>/code/y.tsx\n<T>/code/{b}.ts\n<T>/code/Makefile\n<T>/code/*.txt\n<T>/code/.h.ts\n<T>/code/README.md\n<T>/code/x.ts\n<T>/code/a.TXT\n<T>/code/z.js\n<T>/keep.ign\n<T>/dotig.txt\n<T>/sub/ign.txt\n<T>/sub/anch.txt\n<T>/a.txt\n<T>/private/in/q.txt\n<T>/private/p.txt\n<T>/.git/HEAD\n<T>/.hid.txt\n", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "*.txt", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./excl.txt\n./rgig.txt\n./code/*.txt\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./both.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./ign.txt\n./anch.txt\n./.hid.txt\n", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "*.ign", "needle", "."], "empty", 0, "./keep.ign\n./sub/x.ign\n./x.ign\n", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "igndir/**", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "sub/*", "needle", "."], "empty", 0, "./sub/ign.txt\n./sub/anch.txt\n./sub/x.ign\n", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "!a.txt", "--iglob", "A.TXT", "needle", "."], "empty", 0, "./code/a.TXT\n./a.txt\n", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--iglob", "!A.TXT", "--glob", "a.txt", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "a.txt", "--glob", "!a.txt", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-WHITELIST", "repo", ".", ["-j1", "-l", "--glob", "!a.txt", "--glob", "a.txt", "needle", "."], "empty", 0, "./a.txt\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "**/*.{ts,tsx}", "needle", "."], "empty", 0, "./code/y.tsx\n./code/{b}.ts\n./code/.h.ts\n./code/x.ts\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "*.[tj]s", "needle", "."], "empty", 0, "./code/{b}.ts\n./code/.h.ts\n./code/x.ts\n./code/z.js\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "*.[!t]s", "needle", "."], "empty", 0, "./code/z.js\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "code/*", "needle", "."], "empty", 0, "./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "?.ts", "needle", "."], "empty", 0, "./code/x.ts\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "{a,z}.*", "needle", "."], "empty", 0, "./code/a.TXT\n./code/z.js\n./a.txt\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "**/private/**", "needle", "."], "empty", 0, "./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "\\{b}.ts", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "\\*.txt", "needle", "."], "empty", 0, "./code/*.txt\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "*.TXT", "needle", "."], "empty", 0, "./code/a.TXT\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--iglob", "*.TXT", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./excl.txt\n./rgig.txt\n./code/*.txt\n./code/a.TXT\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./both.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./ign.txt\n./anch.txt\n./.hid.txt\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "!*.txt", "needle", "."], "empty", 0, "./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./.git/HEAD\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "code/**/*.ts", "needle", "."], "empty", 0, "./code/{b}.ts\n./code/.h.ts\n./code/x.ts\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "c*e/*.md", "needle", "."], "empty", 0, "./code/README.md\n", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "{a,{b}}", "needle", "."], "empty", 2, "", "rg: error parsing glob '{a,{b}}': nested alternate groups are not allowed\n"],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "[z-a]", "needle", "."], "empty", 2, "", "rg: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "[a", "needle", "."], "empty", 2, "", "rg: error parsing glob '[a': unclosed character class; missing ']'\n"],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "a\\", "needle", "."], "empty", 2, "", "rg: error parsing glob 'a\\': dangling '\\'\n"],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "a}", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-DIALECT", "repo", ".", ["-j1", "-l", "--hidden", "--glob", "{a", "needle", "."], "empty", 2, "", "rg: error parsing glob '{a': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)\n"],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type", "ts", "needle", "."], "empty", 0, "./code/y.tsx\n./code/{b}.ts\n./code/.h.ts\n./code/x.ts\n", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "-t", "js", "needle", "."], "empty", 0, "./code/z.js\n", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type-not", "ts", "needle", "code"], "empty", 0, "code/Makefile\ncode/*.txt\ncode/README.md\ncode/a.TXT\ncode/z.js\n", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type", "make", "--type", "md", "needle", "."], "empty", 0, "./code/Makefile\n./code/README.md\n", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type", "ts", "--glob", "!x.ts", "needle", "."], "empty", 0, "./code/y.tsx\n./code/{b}.ts\n./code/.h.ts\n", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type", "ts", "--type-not", "ts", "needle", "code"], "empty", 1, "", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type", "nosuch", "needle", "."], "empty", 2, "", "rg: unrecognized file type: nosuch\n"],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--hidden", "--type", "all", "needle", "code"], "empty", 0, "code/y.tsx\ncode/{b}.ts\ncode/Makefile\ncode/*.txt\ncode/.h.ts\ncode/README.md\ncode/x.ts\ncode/z.js\n", ""],
  ["RG-TYPE", "repo", ".", ["-j1", "-l", "--type", "ts", "needle", "code/z.js"], "empty", 0, "code/z.js\n", ""],
  ["RG-WALK-SYMLINK", "repo", ".", ["-j1", "-l", "needle", "link.txt", "linkdir"], "empty", 0, "link.txt\nlinkdir/ign.txt\nlinkdir/anch.txt\n", ""],
  ["RG-WALK-SYMLINK", "repo", ".", ["-j1", "-l", "--hidden", "--no-ignore", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./igndir/f.txt\n./excl.txt\n./rgig.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/.h.ts\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./sub/x.ign\n./both.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n./ign.txt\n./anch.txt\n./x.ign\n./.git/HEAD\n./.hid.txt\n", ""],
  ["RG-PATH-SPELLING", "repo", ".", ["-j1", "--json", "--glob", "*.ts", "needle", "."], "empty", 0, "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"./code/{b}.ts\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"./code/{b}.ts\"},\"lines\":{\"text\":\"needle\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"./code/{b}.ts\"},\"binary_offset\":null,\"stats\":{\"elapsed\":{\"secs\":0,\"nanos\":12041,\"human\":\"0.000012s\"},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":7,\"bytes_printed\":241,\"matched_lines\":1,\"matches\":1}}}\n{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"./code/.h.ts\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"./code/.h.ts\"},\"lines\":{\"text\":\"needle\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"./code/.h.ts\"},\"binary_offset\":null,\"stats\":{\"elapsed\":{\"secs\":0,\"nanos\":3375,\"human\":\"0.000003s\"},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":7,\"bytes_printed\":239,\"matched_lines\":1,\"matches\":1}}}\n{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"./code/x.ts\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"./code/x.ts\"},\"lines\":{\"text\":\"needle\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"./code/x.ts\"},\"binary_offset\":null,\"stats\":{\"elapsed\":{\"secs\":0,\"nanos\":3041,\"human\":\"0.000003s\"},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":7,\"bytes_printed\":237,\"matched_lines\":1,\"matches\":1}}}\n{\"data\":{\"elapsed_total\":{\"human\":\"0.000676s\",\"nanos\":675750,\"secs\":0},\"stats\":{\"bytes_printed\":717,\"bytes_searched\":21,\"elapsed\":{\"human\":\"0.000018s\",\"nanos\":18457,\"secs\":0},\"matched_lines\":3,\"matches\":3,\"searches\":3,\"searches_with_match\":3}},\"type\":\"summary\"}\n", ""],
  ["RG-PATH-SPELLING", "repo", ".", ["-j1", "-c", "--type", "ts", "needle", "<T>"], "empty", 0, "<T>/code/y.tsx:1\n<T>/code/{b}.ts:1\n<T>/code/.h.ts:1\n<T>/code/x.ts:1\n", ""],
  ["RG-IGNORE-FILE-ERRORS", "badig", ".", ["-j1", "-l", "needle", "."], "empty", 0, "./s/sub/keep\n./s/d.txt\n./d.txt\n", "rg: ./.gitignore: line 2: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n./.gitignore: line 3: error parsing glob '{x': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)\nrg: ./s/.ignore: line 1: error parsing glob '[q': unclosed character class; missing ']'\n"],
  ["RG-IGNORE-FILE-ERRORS", "badig", ".", ["-l", "needle", "."], "empty", 0, "./d.txt\n./s/d.txt\n./s/sub/keep\n", "rg: ./.gitignore: line 2: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n./.gitignore: line 3: error parsing glob '{x': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)\nrg: ./s/.ignore: line 1: error parsing glob '[q': unclosed character class; missing ']'\n"],
  ["RG-IGNORE-FILE-ERRORS", "badig", ".", ["-j1", "-l", "needle", "s"], "empty", 2, "s/sub/keep\ns/d.txt\n", "rg: <T>/.gitignore: line 2: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n<T>/.gitignore: line 3: error parsing glob '{x': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)\nrg: s/.ignore: line 1: error parsing glob '[q': unclosed character class; missing ']'\n"],
  ["RG-IGNORE-FILE-ERRORS", "badig", "s", ["-j1", "-l", "needle", "."], "empty", 2, "./sub/keep\n./d.txt\n", "rg: <T>/.gitignore: line 2: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n<T>/.gitignore: line 3: error parsing glob '{x': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)\nrg: ./.ignore: line 1: error parsing glob '[q': unclosed character class; missing ']'\n"],
  ["RG-IGNORE-FILE-ERRORS", "badig", "s", ["-l", "needle", "sub"], "empty", 2, "sub/keep\n", "rg: <T>/.gitignore: line 2: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n<T>/.gitignore: line 3: error parsing glob '{x': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)\n<T>/s/.ignore: line 1: error parsing glob '[q': unclosed character class; missing ']'\n"],
  ["RG-IGNORE-FILE-ERRORS", "badig", ".", ["-j1", "-l", "--no-ignore", "needle", "."], "empty", 0, "./s/c.txt\n./s/b.txt\n./s/sub/keep\n./s/sub/trail.txt\n./s/sub/keep \n./s/sub/!x.txt\n./s/sub/#y.txt\n./s/a.txt\n./s/d.txt\n./c.txt\n./b.txt\n./a.txt\n./d.txt\n", ""],
  ["RG-WALK-ORDER", "repo", ".", ["-l", "needle", "."], "empty", 0, "./private/p.txt\n./private/in/q.txt\n./a.txt\n./sub/anch.txt\n./sub/ign.txt\n./dotig.txt\n./keep.ign\n./code/z.js\n./code/a.TXT\n./code/x.ts\n./code/README.md\n./code/*.txt\n./code/y.tsx\n./code/Makefile\n./code/{b}.ts\n./other/private\n./g2.txt\n./g1.txt\n", ""],
  ["RG-WALK-ORDER", "repo", ".", ["-c", "--hidden", "needle", "code"], "empty", 0, "code/z.js:1\ncode/a.TXT:1\ncode/x.ts:1\ncode/README.md:1\ncode/.h.ts:1\ncode/*.txt:1\ncode/Makefile:1\ncode/{b}.ts:1\ncode/y.tsx:1\n", ""],
  ["RG-WALK-ORDER", "nested", "top", ["-l", "needle", "tree"], "empty", 0, "tree/a.txt\ntree/sub/b.txt\ntree/sub/deep/b.txt\n", ""],
  ["RG-WALK-ORDER", "repo", ".", ["-l", "needle", "sub", "code", "a.txt"], "empty", 0, "a.txt\ncode/z.js\ncode/a.TXT\nsub/anch.txt\ncode/x.ts\nsub/ign.txt\ncode/README.md\ncode/{b}.ts\ncode/*.txt\ncode/y.tsx\ncode/Makefile\n", ""],
  ["RG-TYPE", "repo", ".", ["-l", "--type=ts", "needle", "."], "empty", 0, "./code/x.ts\n./code/.h.ts\n./code/{b}.ts\n./code/y.tsx\n", ""],
  ["RG-TYPE", "repo", ".", ["-l", "-tts", "needle", "."], "empty", 0, "./code/x.ts\n./code/.h.ts\n./code/{b}.ts\n./code/y.tsx\n", ""],
  ["RG-TYPE", "repo", ".", ["-l", "-Tts", "needle", "code"], "empty", 0, "code/z.js\ncode/a.TXT\ncode/README.md\ncode/*.txt\ncode/Makefile\n", ""],
  // RG-GLOB-DENY-RULES: the --iglob shapes 2.1.283's Grep builder (Vin) writes for Read-deny rules (Task 6 review
  // M-1): `!/S` and, for `S/**`, `!/S` beside it; `!**/S`; `!**`; braces as `[{]` and `[}]` (AQ). rg's dialect, so the
  // walk excludes exactly what native excludes.
  ["RG-GLOB-DENY-RULES", "repo", ".", ["--hidden", "--glob", "!.git", "-l", "--null", "needle", "--iglob", "!**/private", "."], "empty", 0, "./g1.txt\u0000./keep.ign\u0000./sub/ign.txt\u0000./g2.txt\u0000./a.txt\u0000./code/z.js\u0000./sub/anch.txt\u0000./code/*.txt\u0000./code/y.tsx\u0000./code/{b}.ts\u0000./code/a.TXT\u0000./code/README.md\u0000./code/x.ts\u0000./code/.h.ts\u0000./.hid.txt\u0000./code/Makefile\u0000./dotig.txt\u0000", ""],
  ["RG-GLOB-DENY-RULES", "repo", ".", ["--hidden", "--glob", "!.git", "-l", "--null", "needle", "--iglob", "!/private/**", "--iglob", "!/private", "<T>"], "empty", 0, "<T>/.hid.txt\u0000<T>/a.txt\u0000<T>/sub/anch.txt\u0000<T>/sub/ign.txt\u0000<T>/g1.txt\u0000<T>/dotig.txt\u0000<T>/g2.txt\u0000<T>/other/private\u0000<T>/keep.ign\u0000<T>/code/*.txt\u0000<T>/code/Makefile\u0000<T>/code/{b}.ts\u0000<T>/code/z.js\u0000<T>/code/README.md\u0000<T>/code/.h.ts\u0000<T>/code/y.tsx\u0000<T>/code/x.ts\u0000<T>/code/a.TXT\u0000", ""],
  ["RG-GLOB-DENY-RULES", "repo", ".", ["--hidden", "-l", "--null", "needle", "--iglob", "!**", "."], "empty", 1, "", ""],
  ["RG-GLOB-DENY-RULES", "repo", ".", ["--hidden", "-l", "--null", "needle", "--iglob", "!**/code/[{]b[}].ts", "."], "empty", 0, "./.hid.txt\u0000./.git/HEAD\u0000./private/p.txt\u0000./private/in/q.txt\u0000./a.txt\u0000./sub/anch.txt\u0000./sub/ign.txt\u0000./dotig.txt\u0000./keep.ign\u0000./code/z.js\u0000./code/a.TXT\u0000./code/x.ts\u0000./g1.txt\u0000./code/Makefile\u0000./code/README.md\u0000./code/*.txt\u0000./g2.txt\u0000./code/y.tsx\u0000./code/.h.ts\u0000./other/private\u0000", ""],
  ["RG-GLOB-DENY-RULES", "repo", ".", ["--hidden", "-l", "--null", "needle", "--iglob", "!**/CODE/**", "--iglob", "!**/CODE", "."], "empty", 0, "./.hid.txt\u0000./.git/HEAD\u0000./a.txt\u0000./other/private\u0000./private/p.txt\u0000./dotig.txt\u0000./g2.txt\u0000./sub/anch.txt\u0000./keep.ign\u0000./private/in/q.txt\u0000./g1.txt\u0000./sub/ign.txt\u0000", ""],
  // RG-IGNORE-FILES (review I-1): an ignore file's UTF-8 BOM is no BOM to rg (ignore 0.4.23 reads lines as they
  // are), so it is part of the first line's glob, which then matches nothing; CRLF lines lose their CR.
  ["RG-IGNORE-FILES", "bomig", ".", ["-j1", "-l", "needle", "."], "empty", 0, "./a.log\n./ok.txt\n", ""],
  ["RG-IGNORE-FILES", "bomig", ".", ["-l", "needle", "."], "empty", 0, "./ok.txt\n./a.log\n", ""],
  // RG-IGNORE-PARENTS (review M-1): several roots share their ancestors' matchers, built by the first root whose
  // walk needs them and kept while the previous root's chain lives (dir.rs add_parents' cache; walk.rs keeps one
  // root's chain until the next root is set up, and a root that is no directory, but stdin, drops it). -j1 only:
  // in parallel the roots race to build them, so the files listed vary from run to run (measured, 30 runs).
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "sub", "docs", "."], "empty", 0, "sub/x.txt\nsub/docs/c.md\nsub/gen/g2.txt\ndocs/sub/b.md\ndocs/a.md\n./ok.txt\n./docs/sub/b.md\n./sub/x.txt\n./sub/docs/c.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "docs", "sub", "."], "empty", 0, "sub/x.txt\nsub/gen/g2.txt\n./ok.txt\n./docs/sub/b.md\n./sub/x.txt\n./sub/docs/c.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "sub", "ok.txt", "docs", "."], "empty", 0, "sub/x.txt\nsub/docs/c.md\nsub/gen/g2.txt\nok.txt\n./ok.txt\n./docs/sub/b.md\n./sub/x.txt\n./sub/docs/c.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "sub", "-", "docs"], "empty", 0, "sub/x.txt\nsub/docs/c.md\nsub/gen/g2.txt\ndocs/sub/b.md\ndocs/a.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "docs", "gen"], "empty", 0, "gen/g.txt\n", ""],
  ["RG-IGNORE-PARENTS", "shared", "sub", ["-j1", "-l", "needle", ".", "../docs"], "empty", 0, "./x.txt\n./docs/c.md\n./gen/g2.txt\n../docs/sub/b.md\n../docs/a.md\n", ""],
  // RG-GLOB-LINE (review M-2): a --glob read as a gitignore line: a comment adds nothing, trailing white space
  // goes (unless escaped), a leading / anchors, a trailing / matches directories only, X/** what is under X.
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--glob", "#a.txt", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./sub/ign.txt\n./sub/anch.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--glob", "a.txt   ", "needle", "."], "empty", 0, "./a.txt\n", ""],
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--glob", "/a.txt", "needle", "."], "empty", 0, "./a.txt\n", ""],
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--iglob", "a.txt", "needle", "."], "empty", 0, "./code/a.TXT\n./a.txt\n", ""],
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--glob", "sub/", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--glob", "!sub/", "needle", "."], "empty", 0, "./g2.txt\n./g1.txt\n./other/private\n./code/y.tsx\n./code/{b}.ts\n./code/Makefile\n./code/*.txt\n./code/README.md\n./code/x.ts\n./code/a.TXT\n./code/z.js\n./keep.ign\n./dotig.txt\n./a.txt\n./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-GLOB-LINE", "repo", ".", ["-j1", "-l", "--glob", "private/**", "needle", "."], "empty", 0, "./private/in/q.txt\n./private/p.txt\n", ""],
  ["RG-GLOB-LINE", "badig", ".", ["-j1", "-l", "--no-ignore", "--glob", "keep\\ ", "needle", "."], "empty", 0, "./s/sub/keep \n", ""],
  ["RG-GLOB-LINE", "badig", ".", ["-j1", "-l", "--no-ignore", "--glob", "\\#y.txt", "needle", "."], "empty", 0, "./s/sub/#y.txt\n", ""],
  // RG-GLOB-ROOT (review M-2): globs are matched relative to rg's cwd: a path under it loses that prefix, any
  // other is matched as spelled (so /anch.txt anchors to the cwd, and sub/* misses an absolute target from sub).
  ["RG-GLOB-ROOT", "repo", "sub", ["-j1", "-l", "--glob", "/anch.txt", "needle", "."], "empty", 0, "./anch.txt\n", ""],
  ["RG-GLOB-ROOT", "repo", ".", ["-j1", "-l", "--glob", "/anch.txt", "needle", "sub"], "empty", 1, "", ""],
  ["RG-GLOB-ROOT", "repo", "sub", ["-j1", "-l", "--glob", "/anch.txt", "needle", ".."], "empty", 1, "", ""],
  ["RG-GLOB-ROOT", "repo", "sub", ["-j1", "-l", "--glob", "sub/*", "needle", "<T>"], "empty", 1, "", ""],
  ["RG-GLOB-ROOT", "repo", ".", ["-j1", "-l", "--glob", "sub/*", "needle", "<T>"], "empty", 0, "<T>/sub/ign.txt\n<T>/sub/anch.txt\n<T>/sub/x.ign\n", ""],
  ["RG-GLOB-ROOT", "repo", "code", ["-j1", "-l", "--iglob", "!/A.TXT", "needle", "."], "empty", 0, "./y.tsx\n./{b}.ts\n./Makefile\n./*.txt\n./README.md\n./x.ts\n./z.js\n", ""],
];

// Every tree in a fresh root; fn(root). The trees' names are the keys of TREES, plus `empty` (a HOME).
async function withTrees(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-walk-')));
  try {
    for (const name of Object.keys(TREES)) makeWalkTree(fs, path, path.join(root, name), name);
    fs.mkdirSync(path.join(root, 'empty'));
    return await fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function rowEnv(root, home) {
  const env = { PATH: process.env.PATH, HOME: path.join(root, home === 'xdg-h1' ? 'empty' : home) };
  if (home === 'xdg-h1') env.XDG_CONFIG_HOME = path.join(root, 'h1', '.config');
  return env;
}
function rowCall(root, [, tree, cwdRel, argv, home]) {
  const T = path.join(root, tree);
  return { T, argv: argv.map((a) => a.split('<T>').join(T)), cwd: path.join(T, cwdRel), env: rowEnv(root, home) };
}
const lines = (s) => s.split('\n').filter(Boolean).sort().join('\n');
function check(row, got, T) {
  const [rule, tree, cwdRel, argv, home, rc, out, err] = row;
  const un = (s) => s.split(T).join('<T>');
  const what = `${rule}: (${tree}/${cwdRel}, HOME ${home}) rg ${argv.join(' ')} => ${JSON.stringify(got).slice(0, 600)}`;
  assert.strictEqual(got.status, rc, what);
  // records compared in any order, -j1 rows too (readdir's order is the filesystem's: RG-WALK-ORDER's own tests)
  const anyOrder = argv.filter((a) => a !== '-j1');
  assert.strictEqual(normalizeRg(Buffer.from(un(got.stdout), 'latin1'), anyOrder), normalizeRg(Buffer.from(out, 'latin1'), anyOrder), what);
  assert.strictEqual(lines(un(got.stderr)), lines(err), what);
  assert.strictEqual(rgn.parseRgRefusal(got.stderr), null, `${what}: native answers this, so ours must not refuse it`);
}
const l1 = (b) => Buffer.from(b).toString('latin1');
function syncRun(root, row, { alone = false } = {}) {
  const c = rowCall(root, row);
  const r = rgn.runRg(c.argv, { cwd: c.cwd, env: c.env, spawnSync: cp.spawnSync, translate: NOT_TRANSLATED,
    ugrep: () => (alone ? null : UGREP), matchFiles: alone ? rgn.matchFilesAlone : undefined });
  return { T: c.T, got: { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) } };
}
function asyncRun(root, row) {
  const c = rowCall(root, row);
  return new Promise((resolve) => {
    const child = rgn.rgExecFile(c.argv, { cwd: c.cwd, env: c.env, encoding: 'buffer' }, (e, so, se) => resolve({ T: c.T,
      got: { status: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: l1(so), stderr: l1(se) } }),
    'rg', { translate: NOT_TRANSLATED, spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP });
    if (child.stdin) child.stdin.end();
  });
}

const RULES = [...new Set(P9_NATIVE.map((r) => r[0]))];
for (const rule of RULES) {
  test(`${rule}: runRg walks as native walks (native, over ugrep)`, needUgrep, () => withTrees((root) => {
    for (const row of P9_NATIVE.filter((r) => r[0] === rule)) { const { T, got } = syncRun(root, row); check(row, got, T); }
  }));
}
test('RG-WALK-*: with the matcher alone deciding every file (no ugrep), every row (native)', { skip: POSIX }, () => withTrees((root) => {
  for (const row of P9_NATIVE) { const { T, got } = syncRun(root, row, { alone: true }); check(row, got, T); }
}));
test('RG-WALK-*: the async twin walks as the sync one does, every row (rgExecFile, native)', needUgrep, () => withTrees(async (root) => {
  for (const row of P9_NATIVE) { const { T, got } = await asyncRun(root, row); check(row, got, T); }
}));
test('RG-WALK-*: under tjs, both twins, every row (native)', { skip: needUgrep.skip || NO_TJS }, () => withTrees((root) => {
  const prog = path.join(root, '..', path.basename(root) + '-probe.cjs');
  const calls = P9_NATIVE.map((row) => { const c = rowCall(root, row); return [c.argv, c.cwd, c.env]; });
  fs.writeFileSync(prog, `
    const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
    const cp = require('child_process');
    const UGREP = ${JSON.stringify(UGREP)}, calls = ${JSON.stringify(calls)};
    const l1 = (b) => Buffer.from(b).toString('latin1');
    (async () => {
      const out = [];
      for (const [argv, cwd, env] of calls) {
        const ctx = { translate: () => { throw new Error('translated'); }, spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
        const s = rgn.runRg(argv, { ...ctx, cwd, env });
        const a = await new Promise((res) => {
          const c = rgn.rgExecFile(argv, { cwd, env, encoding: 'buffer' }, (err, so, se) => res({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx);
          if (c.stdin) c.stdin.end();
        });
        out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
      }
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `);
  try {
    const res = runLoader(prog, [], { timeout: 180000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const got = JSON.parse(line.slice('PROBE:'.length));
    assert.strictEqual(got.length, P9_NATIVE.length);
    P9_NATIVE.forEach((row, i) => { const T = path.join(root, row[1]); check(row, got[i].sync, T); check(row, got[i].async, T); });
  } finally { fs.rmSync(prog, { force: true }); }
}));

// ---- RG-WALK-ORDER -------------------------------------------------------------------------------------------
// The order is the filesystem's readdir order, so it is judged against the readdir order of the filesystem
// the test runs on: an independent reading of it (opendir, depth first), not the walk's own code. Measured
// (2026-10-04): -j1 is native's order 20 of 20 on APFS (this Mac) and on overlayfs (Linux container); the
// parallel walk's order varies on both (a 12-thread Xeon: 3-7 of 20 for its commonest order on small trees, 20
// orders in 20 runs on the repo tree), and on this Mac its commonest order on a small tree is the LIFO one,
// 20 of 20, which quaude's rg prints; rg-differential forgives order there, and only there.
function readdirOrder(dir) {
  const d = fs.opendirSync(dir), out = [];
  for (let e; (e = d.readSync()) !== null;) out.push({ name: e.name, dir: e.isDirectory(), file: e.isFile() });
  d.closeSync();
  return out;
}
// Every regular file under `rel` holding `needle` (no ignore rules: --no-ignore --hidden), as rg spells it, in
// -j1's order (depth first, readdir order) or the parallel walk's LIFO order.
function expectedOrder(root, tree, rel, lifo) {
  // which files hold `needle`: what test/rg-walk-cases.cjs wrote there (paths relative to the tree, the cwd)
  const holds = new Set(TREES[tree].filter(([, d]) => typeof d === 'string' && /needle/.test(d)).map(([r]) => r));
  const out = [];
  const visit = (r) => {
    const ents = readdirOrder(path.join(root, r));
    for (const e of lifo ? ents.slice().reverse() : ents) {
      const p = `${r}/${e.name}`;
      if (e.dir) visit(p); else if (e.file && holds.has(path.posix.normalize(p))) out.push(p);
    }
  };
  visit(rel);
  return out.map((p) => `${p}\n`).join('');
}
test('RG-WALK-ORDER: -j1 walks depth first in readdir order, the parallel walk LIFO over it (this filesystem)', { skip: POSIX }, () => withTrees((root) => {
  for (const [lifo, j] of [[false, ['-j1']], [true, []]]) {
    for (const [tree, rel] of [['repo', '.'], ['nested', 'top']]) {
      const r = rgn.runRg([...j, '-l', '--no-ignore', '--hidden', 'needle', rel], { cwd: path.join(root, tree), spawnSync: cp.spawnSync,
        translate: NOT_TRANSLATED, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
      assert.strictEqual(r.stdout.toString('latin1'), expectedOrder(path.join(root, tree), tree, rel, lifo), `${tree} ${j.join(' ') || '(parallel)'}`);
    }
  }
}));
test('RG-WALK-ORDER: native\'s -j1 order is ours exactly, and its parallel order on a small tree is ours at least once in 10 (native)',
  { skip: POSIX || (!NATIVE ? 'no native provider' : false) }, () => withTrees((root) => {
    const env = { PATH: process.env.PATH, HOME: path.join(root, 'empty') };
    const native = (argv, cwd) => cp.spawnSync(NATIVE, ['--no-config', ...argv], { cwd, argv0: 'rg', env, encoding: 'latin1' }).stdout;
    const ours = (argv, cwd) => rgn.runRg(argv, { cwd, env, spawnSync: cp.spawnSync, translate: NOT_TRANSLATED, ugrep: () => null, matchFiles: rgn.matchFilesAlone }).stdout.toString('latin1');
    for (const [tree, rel] of [['repo', '.'], ['badig', '.'], ['nested', 'top']]) {
      const argv = ['-j1', '-l', '--hidden', 'needle', rel], cwd = path.join(root, tree);
      assert.strictEqual(ours(argv, cwd), native(argv, cwd), `${tree}: -j1`);
    }
    for (const [tree, cwdRel, rel] of [['repo', '.', 'code'], ['nested', 'top', 'tree']]) {
      const argv = ['-l', '--hidden', 'needle', rel], cwd = path.join(root, tree, cwdRel);
      const o = ours(argv, cwd);
      const seen = Array.from({ length: 10 }, () => native(argv, cwd));
      assert.ok(seen.includes(o), `${tree}/${rel}: native's parallel orders ${JSON.stringify([...new Set(seen)])} never once ours ${JSON.stringify(o)}`);
    }
  }));

// ---- RG-WALK-ERROR ---------------------------------------------------------------------------------------------
// A directory and a file that cannot be read (native 2.1.283, measured 2026-10-04: the rest answered, rc 2).
const WALK_ERROR = {
  '-j1': ['./ok/a.txt\n', 'rg: ./locked: IO error for operation on ./locked: Permission denied (os error 13)\nrg: ./noread.txt: Permission denied (os error 13)\n'],
  parallel: ['./ok/a.txt\n', 'rg: ./noread.txt: Permission denied (os error 13)\nrg: ./locked: Permission denied (os error 13)\n'],
};
test('RG-WALK-ERROR: a directory or file rg cannot read is its error, the rest searched, rc 2 (native; both twins)', {
  skip: needUgrep.skip || ((process.getuid && process.getuid() === 0) ? 'root reads a chmod 000 directory' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-walk-err-')));
  try {
    for (const [p, d] of [['ok/a.txt', 'needle\n'], ['locked/x.txt', 'needle\n'], ['noread.txt', 'needle\n']]) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), d); }
    fs.chmodSync(path.join(dir, 'locked'), 0); fs.chmodSync(path.join(dir, 'noread.txt'), 0);
    for (const [how, [out, err]] of Object.entries(WALK_ERROR)) {
      const argv = [...(how === '-j1' ? ['-j1'] : []), '-l', 'needle', '.'];
      const s = rgn.runRg(argv, { cwd: dir, spawnSync: cp.spawnSync, translate: NOT_TRANSLATED, ugrep: () => UGREP });
      const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd: dir, encoding: 'buffer' }, (e, so, se) => res({ status: e ? e.code : 0, stdout: so, stderr: se }),
        'rg', { translate: NOT_TRANSLATED, spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP }));
      for (const g of [s, a]) {
        assert.deepStrictEqual([g.status, l1(g.stdout), lines(l1(g.stderr))], [2, out, lines(err)], how);
      }
    }
  } finally {
    for (const p of ['locked', 'noread.txt']) try { fs.chmodSync(path.join(dir, p), 0o755); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- RG-VERSION, RG-VERSION-SIMD, RG-TYPE-LIST ------------------------------------------------------------------------
// native's own text: darwin-arm64 (this Mac) and linux-x64 (a node:24.21.0-bookworm container on a Xeon E5-1650 v2,
// which has SSSE3 and no AVX2), measured 2026-10-04.
const VERSION_NATIVE = {
  arm64: 'ripgrep 14.1.1 (rev 7c1d0ed28a)\n\nfeatures:+pcre2\nsimd(compile):+NEON\nsimd(runtime):+NEON\n\nPCRE2 10.45 is available (JIT is available)\n',
  x64: 'ripgrep 14.1.1 (rev 7c1d0ed28a)\n\nfeatures:+pcre2\nsimd(compile):+SSE2,+SSSE3,-AVX2\nsimd(runtime):+SSE2,+SSSE3,-AVX2\n\nPCRE2 10.45 is available (JIT is available)\n',
};
const VERSION_SHORT = 'ripgrep 14.1.1 (rev 7c1d0ed28a)\n';
test('RG-VERSION-SIMD: --version for each architecture is native\'s (aarch64 and x86_64 measured; elsewhere rg prints no simd lines)', () => {
  for (const [arch, want] of Object.entries(VERSION_NATIVE)) assert.strictEqual(rgTypes.versionText({ arch }), want, arch);
  assert.strictEqual(rgTypes.versionText({ arch: 'ppc' }), 'ripgrep 14.1.1 (rev 7c1d0ed28a)\n\nfeatures:+pcre2\n\nPCRE2 10.45 is available (JIT is available)\n');
  assert.strictEqual(rgTypes.versionText({ short: true }), VERSION_SHORT);
});
test('RG-VERSION: rg --version, -V and a search argv holding --version answer as native, and /doctor\'s probe passes', async () => {
  const opts = { spawnSync: cp.spawnSync, translate: NOT_TRANSLATED, ugrep: () => null };
  const long = rgTypes.versionText();
  for (const [argv, want] of [[['--version'], long], [['-V'], VERSION_SHORT], [['-l', 'needle', '.', '--version'], long]]) {
    const r = rgn.runRg(argv, opts);
    assert.deepStrictEqual([r.status, r.stdout.toString(), r.stderr.toString()], [0, want, ''], argv.join(' '));
  }
  if (VERSION_NATIVE[process.arch]) assert.strictEqual(long, VERSION_NATIVE[process.arch]);
  // the bundle's first-use probe (2.1.283's DQ, what /doctor reports as "rg works"): `rg --version` through
  // execFile, stdout starting `ripgrep `
  const out = await new Promise((res) => rgn.rgExecFile(['--version'], {}, (e, so) => res(e ? null : so), 'rg', { translate: NOT_TRANSLATED, spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => null }));
  assert.ok(String(out).startsWith('ripgrep '), String(out));
});
test('RG-TYPE-LIST: --type-list prints native\'s table (its first lines and size, measured; the whole of it, where a native is at hand)', () => {
  const r = rgn.runRg(['--type-list'], { spawnSync: cp.spawnSync, translate: NOT_TRANSLATED, ugrep: () => null });
  const text = r.stdout.toString();
  assert.strictEqual(r.status, 0);
  assert.ok(text.startsWith('ada: *.adb, *.ads\nagda: *.agda, *.lagda\naidl: *.aidl\nalire: alire.toml\namake: *.bp, *.mk\n'), text.slice(0, 200));
  assert.strictEqual(text.split('\n').filter(Boolean).length, 206);
  assert.ok(text.endsWith('zstd: *.zst, *.zstd\n'));
  if (NATIVE) assert.strictEqual(text, cp.spawnSync(NATIVE, ['--no-config', '--type-list'], { argv0: 'rg', encoding: 'utf8', env: { HOME: os.tmpdir() } }).stdout);
});

// ---- RG-REFUSE-NAME-NOT-UTF8 -------------------------------------------------------------------------------------------
// Linux native lists such a file (`./f\xff`, measured in the container; --json would name it {"bytes": ...}); quaude's
// rg cannot carry its name through the engine's readdir, open and ugrep's argv, so it refuses by name rather than
// answer without it. APFS will not create such a name (EILSEQ): there the test says so and skips.
test('RG-REFUSE-NAME-NOT-UTF8: a walked name that is not UTF-8 refuses the search, naming the rule', { skip: POSIX }, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-walk-nonutf8-')));
  try {
    try { fs.writeFileSync(Buffer.concat([Buffer.from(dir + '/f'), Buffer.from([0xff])]), 'needle\n'); } catch (e) { t.skip(`this filesystem will not create a name that is not UTF-8 (${e.code})`); return; }
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'needle\n');
    const r = rgn.runRg(['-l', 'needle', '.'], { cwd: dir, spawnSync: cp.spawnSync, translate: NOT_TRANSLATED, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.stdout.length, 0);
    assert.match(rgn.parseRgRefusal(r.stderr).reason, /RG-REFUSE-NAME-NOT-UTF8/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- N-2: the match pass does not stat what the walk already knows ------------------------------------------------------
// (Task 5 re-review N-2) matchPlan stat'ed every file the walk had just listed, to learn it is a regular file: a
// second look that could race the first. A walked file is now known to be one; only its first bytes are read (a BOM).
test('N-2: a walked search never stats a file the walk listed (it reads only its first bytes for a BOM)', needUgrep, () => withTrees((root) => {
  const cwd = path.join(root, 'repo');
  const stat = fs.statSync, seen = [];
  fs.statSync = function (p, ...rest) { seen.push(path.resolve(cwd, String(p))); return stat.call(this, p, ...rest); };
  let r;
  try { r = rgn.runRg(['-l', '--hidden', 'needle', '.'], { cwd, spawnSync: cp.spawnSync, translate: NOT_TRANSLATED, ugrep: () => UGREP }); } finally { fs.statSync = stat; }
  const listed = r.stdout.toString().split('\n').filter(Boolean).map((p) => path.resolve(cwd, p));
  assert.ok(listed.length >= 15, `${listed.length} files listed`);
  assert.deepStrictEqual(listed.filter((p) => seen.includes(p)), []);
}));
