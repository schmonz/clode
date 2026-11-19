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
const { rgOracle, rgOracleSkip } = require('./provider-resolve.cjs');

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
const NATIVE = rgOracle(process.env), NATIVE_SKIP = rgOracleSkip(process.env);

const NREP = 'n'.repeat(300);   // a path component past NAME_MAX
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
  // root's chain until the next root is set up, and a root that is no directory, but stdin, drops it). -j1 rows
  // here: in parallel the roots race to build them, so for some argv the files listed vary from run to run
  // (measured, 30 runs); the parallel rows below are the ones native answered alike (or nearly) over 12 runs.
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "sub", "docs", "."], "empty", 0, "sub/x.txt\nsub/docs/c.md\nsub/gen/g2.txt\ndocs/sub/b.md\ndocs/a.md\n./ok.txt\n./docs/sub/b.md\n./sub/x.txt\n./sub/docs/c.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "docs", "sub", "."], "empty", 0, "sub/x.txt\nsub/gen/g2.txt\n./ok.txt\n./docs/sub/b.md\n./sub/x.txt\n./sub/docs/c.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "sub", "ok.txt", "docs", "."], "empty", 0, "sub/x.txt\nsub/docs/c.md\nsub/gen/g2.txt\nok.txt\n./ok.txt\n./docs/sub/b.md\n./sub/x.txt\n./sub/docs/c.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "sub", "-", "docs"], "empty", 0, "sub/x.txt\nsub/docs/c.md\nsub/gen/g2.txt\ndocs/sub/b.md\ndocs/a.md\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-j1", "-l", "needle", "docs", "gen"], "empty", 0, "gen/g.txt\n", ""],
  ["RG-IGNORE-PARENTS", "shared", "sub", ["-j1", "-l", "needle", ".", "../docs"], "empty", 0, "./x.txt\n./docs/c.md\n./gen/g2.txt\n../docs/sub/b.md\n../docs/a.md\n", ""],
  // In PARALLEL a root that is no directory drops nothing (walk.rs's parallel visit hands every root ig_root's
  // clone, and only the one-thread walker resets its chain): measured 12 runs each (Task 9 re-review, ruling G26),
  // the same answer 12 of 12 for the first two; the third gave this 10 of 12 (2 runs listed neither docs file nor
  // sub/docs/c.md: the parallel race the -j1 rows above avoid). Under -j1 the same argv drop the chain (rows above).
  ["RG-IGNORE-PARENTS", "shared", ".", ["-l", "needle", "sub", "nosuch", "docs"], "empty", 2, "docs/a.md\ndocs/sub/b.md\nsub/docs/c.md\nsub/gen/g2.txt\nsub/x.txt\n", "rg: nosuch: No such file or directory (os error 2)\n"],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-l", "needle", "sub", "docs/sub", "ok.txt", "docs"], "empty", 0, "docs/a.md\ndocs/sub/b.md\ndocs/sub/b.md\nok.txt\nsub/docs/c.md\nsub/gen/g2.txt\nsub/x.txt\n", ""],
  ["RG-IGNORE-PARENTS", "shared", ".", ["-l", "needle", "sub", "-", "ok.txt", "docs"], "empty", 0, "docs/a.md\ndocs/sub/b.md\nok.txt\nsub/docs/c.md\nsub/gen/g2.txt\nsub/x.txt\n", ""],
  // 2.1.283 PASSES --max-depth, --follow and --no-ignore-vcs in production (grep-native Task 10 fix round, review I-1;
  // test/build-gates/rg-carve-argv-gates.test.cjs reads every rg argv the carve builds): orphanedVersionGlobExclusions
  // (`--files --hidden --no-ignore --max-depth 4 --glob .orphaned_at`), rt (`--files --hidden --max-depth 4 -g !.git -g
  // !node_modules -g SKILL.md -g *.md`), the sandbox scan (`--files --hidden --max-depth N --iglob ... -g !**/node_modules/**`)
  // and the FileIndex fallback outside a repo (`--files --follow --hidden --glob !.git/ ... [--no-ignore-vcs]`).
  ["RG-WALK-MAX-DEPTH","plugcache",".",["--files","--hidden","--no-ignore","--max-depth","4","--glob",".orphaned_at","<T>"],"empty",0,"<T>/mkt/plug/1.0/.orphaned_at\n<T>/mkt/.orphaned_at\n",""],
  ["RG-WALK-MAX-DEPTH","plugcache",".",["--files","--hidden","--no-ignore","--max-depth","4","--glob",".orphaned_at","."],"empty",0,"./mkt/plug/1.0/.orphaned_at\n./mkt/.orphaned_at\n",""],
  ["RG-WALK-MAX-DEPTH","plugcache",".",["--files","--hidden","--no-ignore","--max-depth","3","--glob",".orphaned_at","."],"empty",0,"./mkt/.orphaned_at\n",""],
  ["RG-WALK-MAX-DEPTH","plugcache",".",["-j1","--files","--hidden","--no-ignore","--max-depth","4","--glob",".orphaned_at","."],"empty",0,"./mkt/.orphaned_at\n./mkt/plug/1.0/.orphaned_at\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--hidden","--max-depth","4","-g","!.git","-g","!node_modules","-g","SKILL.md","-g","*.md","<T>"],"empty",0,"<T>/m/SKILL.md\n<T>/m/n/x.md\n<T>/m/n/o/deep.md\n<T>/README.md\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--hidden","--max-depth","2","-g","!.git","-g","!node_modules","-g","SKILL.md","-g","*.md","."],"empty",0,"./m/SKILL.md\n./README.md\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--hidden","--max-depth","3","--iglob","**/node_modules/**","--iglob","**/.git/hooks/**","-g","!**/node_modules/**","."],"empty",0,"./node_modules/p/SKILL.md\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--hidden","--max-depth","4","-g","!**/node_modules/**","."],"empty",0,"./m/SKILL.md\n./m/n/x.md\n./m/n/o/deep.md\n./.git/x.md\n./README.md\n./notes.txt\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--hidden","--max-depth","0","."],"empty",1,"",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--max-depth","0","notes.txt"],"empty",0,"notes.txt\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["-j1","-l","--max-depth","1","needle","."],"empty",0,"./notes.txt\n./README.md\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--maxdepth","1","."],"empty",0,"./README.md\n./notes.txt\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","-d","1","."],"empty",0,"./README.md\n./notes.txt\n",""],
  ["RG-WALK-MAX-DEPTH","skills",".",["--files","--max-depth","x","."],"empty",2,"","rg: error parsing flag --max-depth: value is not a valid number: invalid digit found in string\n"],
  ["RG-WALK-FOLLOW","links",".",["--files","--follow","--hidden","--glob","!.git/","--glob","!.svn/","--glob","!.hg/","--glob","!.bzr/","--glob","!.jj/","--glob","!.sl/","."],"empty",2,"./lout/o.md\n./.gitignore\n./.ignore\n./lfile.md\n./ign.md\n./real/a.md\n./real/sub/b.md\n./ldir/a.md\n./ldir/sub/b.md\n","rg: ./broken.md: No such file or directory (os error 2)\nrg: File system loop found: ./real/sub/loop points to an ancestor ./real\nrg: File system loop found: ./ldir/sub/loop points to an ancestor ./ldir\n"],
  ["RG-WALK-FOLLOW","links",".",["--files","--follow","--hidden","--glob","!.git/","--glob","!.svn/","--glob","!.hg/","--glob","!.bzr/","--glob","!.jj/","--glob","!.sl/","--no-ignore-vcs","<T>"],"empty",2,"<T>/lout/o.md\n<T>/.gitignore\n<T>/.ignore\n<T>/lfile.md\n<T>/ign.md\n<T>/real/a.md\n<T>/real/sub/b.md\n<T>/ldir/a.md\n<T>/ldir/sub/b.md\n","rg: <T>/broken.md: No such file or directory (os error 2)\nrg: File system loop found: <T>/real/sub/loop points to an ancestor <T>/real\nrg: File system loop found: <T>/ldir/sub/loop points to an ancestor <T>/ldir\n"],
  ["RG-WALK-FOLLOW","links",".",["-j1","--files","--follow","--hidden","--glob","!.git/","."],"empty",2,"./ldir/sub/b.md\n./ldir/a.md\n./real/sub/b.md\n./real/a.md\n./ign.md\n./lfile.md\n./.ignore\n./.gitignore\n./lout/o.md\n","rg: File system loop found: ./ldir/sub/loop points to an ancestor ./ldir\nrg: File system loop found: ./real/sub/loop points to an ancestor ./real\nrg: ./broken.md: IO error for operation on ./broken.md: No such file or directory (os error 2)\n"],
  ["RG-WALK-FOLLOW","links",".",["--files","--follow","--hidden","--no-ignore","--glob","*.md","."],"empty",2,"./lout/o.md\n./lfile.md\n./dot.md\n./ign.md\n./real/a.md\n./real/sub/b.md\n./ldir/a.md\n./ldir/sub/b.md\n","rg: ./broken.md: No such file or directory (os error 2)\nrg: File system loop found: ./real/sub/loop points to an ancestor ./real\nrg: File system loop found: ./ldir/sub/loop points to an ancestor ./ldir\n"],
  ["RG-WALK-FOLLOW","links",".",["-L","-l","needle","."],"empty",2,"./lout/o.md\n./lfile.md\n./ign.md\n./real/a.md\n./real/sub/b.md\n./ldir/a.md\n./ldir/sub/b.md\n","rg: ./broken.md: No such file or directory (os error 2)\nrg: File system loop found: ./real/sub/loop points to an ancestor ./real\nrg: File system loop found: ./ldir/sub/loop points to an ancestor ./ldir\n"],
  ["RG-WALK-FOLLOW","links",".",["-j1","--files","-L","--max-depth","2","."],"empty",2,"./ldir/a.md\n./real/a.md\n./ign.md\n./lfile.md\n./lout/o.md\n","rg: ./broken.md: IO error for operation on ./broken.md: No such file or directory (os error 2)\n"],
  ["RG-WALK-FOLLOW","links",".",["--files","--follow","--no-follow","."],"empty",0,"./ign.md\n./real/a.md\n./real/sub/b.md\n",""],
  ["RG-NO-IGNORE","linksrepo",".",["--files","--follow","--hidden","--glob","!.git/","."],"empty",0,"./.gitignore\n./.ignore\n./real/a.md\n./ldir/a.md\n",""],
  ["RG-NO-IGNORE","linksrepo",".",["--files","--follow","--hidden","--glob","!.git/","--no-ignore-vcs","."],"empty",0,"./.gitignore\n./.ignore\n./ign.md\n./real/a.md\n./ldir/a.md\n",""],
  ["RG-NO-IGNORE","linksrepo",".",["--files","--hidden","--glob","!.git/","--no-ignore-vcs","--ignore-vcs","."],"empty",0,"./.gitignore\n./.ignore\n./real/a.md\n",""],
  // 2.1.283's environment scan eo() (fix round 2, review N2), its argv verbatim: RG-NO-MESSAGES (rg's messages unwritten, the
  // status kept; --no-heading and --color=never as printing to a pipe) and RG-MAX-FILESIZE (a walked file past N bytes skipped).
  ["RG-NO-MESSAGES","envscan",".",["-o","-H","--no-line-number","--no-messages","--no-heading","--color=never","--null","--hidden","-g","!.git","-g","!node_modules","-g","*.toml","-g","*.yaml","-g","*.yml","-g","*.json","-g","*.cfg","--max-filesize","4M","-e","[a-z0-9.+-]?(s3|gs|az)://[a-z0-9][a-z0-9._-]*","."],"empty",0,"./b.json\u0000s3://json-b\n./cfg/a.toml\u0000s3://my-bucket\n./cfg/a.toml\u0000gs://g-b.x\n./cfg/a.toml\u0000az://ok-1\n./atlimit.yaml\u0000s3://at-limit\n./.h.yml\u0000s3://hidden\n",""],
  ["RG-NO-MESSAGES","envscan",".",["-j1","-o","-H","--no-line-number","--no-messages","--no-heading","--color=never","--null","--hidden","-g","!.git","-g","!node_modules","-g","*.toml","-g","*.yaml","-g","*.yml","-g","*.json","-g","*.cfg","--max-filesize","4M","-e","[a-z0-9.+-]?(s3|gs|az)://[a-z0-9][a-z0-9._-]*","<T>"],"empty",0,"<T>/.h.yml\u0000s3://hidden\n<T>/atlimit.yaml\u0000s3://at-limit\n<T>/cfg/a.toml\u0000s3://my-bucket\n<T>/cfg/a.toml\u0000gs://g-b.x\n<T>/cfg/a.toml\u0000az://ok-1\n<T>/b.json\u0000s3://json-b\n",""],
  ["RG-NO-MESSAGES","envscan",".",["-o","-H","--null","--hidden","-g","!.git","-g","!node_modules","-g","*.toml","-g","*.yaml","-g","*.yml","-g","*.json","--max-filesize","4M","-e","[a-z0-9.+-]?(s3|gs|az)://[a-z0-9][a-z0-9._-]*","."],"empty",0,"./b.json\u0000s3://json-b\n./cfg/a.toml\u0000s3://my-bucket\n./cfg/a.toml\u0000gs://g-b.x\n./cfg/a.toml\u0000az://ok-1\n./atlimit.yaml\u0000s3://at-limit\n./.h.yml\u0000s3://hidden\n","rg: ./.ignore: line 1: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-NO-MESSAGES","envscan",".",["--no-messages","-l","s3","nosuch","b.json"],"empty",2,"b.json\n",""],
  ["RG-NO-MESSAGES","envscan",".",["--messages","--no-messages","-l","s3","nosuch"],"empty",2,"",""],
  ["RG-NO-MESSAGES","envscan",".",["--no-messages","--messages","-l","s3","nosuch"],"empty",2,"","rg: nosuch: IO error for operation on nosuch: No such file or directory (os error 2)\n"],
  ["RG-NO-MESSAGES","envscan",".",["-l","--color","never","--no-heading","gs://","."],"empty",0,"./cfg/a.toml\n","rg: ./.ignore: line 1: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-NO-MESSAGES","envscan",".",["-l","--color=bogus","s3","."],"empty",2,"","rg: error parsing flag --color: choice 'bogus' is unrecognized\n"],
  ["RG-MAX-FILESIZE","envscan",".",["--files","--hidden","--max-filesize","4M","."],"empty",0,"./b.json\n./c.txt\n./cfg/a.toml\n./.ignore\n./node_modules/x/m.json\n./atlimit.yaml\n./.h.yml\n","rg: ./.ignore: line 1: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-MAX-FILESIZE","envscan",".",["-j1","--files","--max-filesize=1K","."],"empty",0,"./node_modules/x/m.json\n./cfg/a.toml\n./c.txt\n./b.json\n","rg: ./.ignore: line 1: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-MAX-FILESIZE","envscan",".",["-l","--max-filesize","4M","s3","big.yaml"],"empty",0,"big.yaml\n",""],
  ["RG-MAX-FILESIZE","envscan",".",["-l","--max-filesize","0","s3","."],"empty",1,"","rg: ./.ignore: line 1: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-MAX-FILESIZE","envscan",".",["--files","--max-filesize","4K","--max-filesize=4194303","."],"empty",0,"./b.json\n./c.txt\n./cfg/a.toml\n./node_modules/x/m.json\n","rg: ./.ignore: line 1: error parsing glob '[z-a]': invalid range; 'z' > 'a'\n"],
  ["RG-MAX-FILESIZE","envscan",".",["--files","--max-filesize","4X","."],"empty",2,"","rg: error parsing flag --max-filesize: invalid size: invalid format for size '4X', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix\n"],
  ["RG-MAX-FILESIZE","envscan",".",["--files","--max-filesize","1k","."],"empty",2,"","rg: error parsing flag --max-filesize: invalid size: invalid format for size '1k', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix\n"],
  ["RG-MAX-FILESIZE","envscan",".",["--files","--max-filesize","99999999999999999999","."],"empty",2,"","rg: error parsing flag --max-filesize: invalid size: invalid integer found in size '99999999999999999999': number too large to fit in target type\n"],
  ["RG-MAX-FILESIZE","envscan",".",["--files","--max-filesize","18446744073709551615K","."],"empty",2,"","rg: error parsing flag --max-filesize: invalid size: size too big in '18446744073709551615K'\n"],
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
  // RG-GLOB-DIALECT over a non-ASCII name (review I-2 made ASCII paths skip the UTF-8 encode, so these pin the
  // other branch): globs match BYTES: ? is one byte (two match the e-acute), a class of it is a class of its two
  // bytes, --iglob folds ASCII only.
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--glob", "caf\u00e9.txt", "needle", "."], "empty", 0, "./caf\u00c3\u00a9.txt\n", ""],
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--glob", "caf?.txt", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--glob", "caf??.txt", "needle", "."], "empty", 0, "./caf\u00c3\u00a9.txt\n", ""],
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--glob", "caf[\u00e9].txt", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--glob", "caf*.txt", "needle", "."], "empty", 0, "./caf\u00c3\u00a9.txt\n", ""],
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--iglob", "CAF\u00c9.TXT", "needle", "."], "empty", 1, "", ""],
  ["RG-GLOB-DIALECT", "uni", ".", ["-j1", "-l", "--iglob", "CAF\u00e9.TXT", "needle", "."], "empty", 0, "./caf\u00c3\u00a9.txt\n", ""],
];

// RG-ERROR-TEXT (Task 10 fix round 2, review N1): an errno as the platform C library words it (rg-native.cjs: the
// engine's strerror(3)); a link to itself or through a loop (ELOOP), a name past NAME_MAX (ENAMETOOLONG), a path
// through a file (ENOTDIR), a broken link (ENOENT). Per platform, because the number and the words are the libc's:
// darwin's measured on this Mac, linux's in a node:24.21.0-bookworm container (linux-x64 native); a platform with no
// recorded native (NetBSD has no native Claude Code) runs none of these rows. Node has no strerror binding: its runs
// map these through libuv's table (nodeText below).
const P9_ERROR_TEXT = {
  darwin: [
    ["RG-ERROR-TEXT","errs",".",["-L","-l","needle","."],"empty",2,"./ok.txt\n","rg: ./gone: No such file or directory (os error 2)\nrg: ./self: Too many levels of symbolic links (os error 62)\nrg: ./dd/lp: Too many levels of symbolic links (os error 62)\n"],
    ["RG-ERROR-TEXT","errs",".",["-j1","-L","-l","needle","."],"empty",2,"./ok.txt\n","rg: ./gone: IO error for operation on ./gone: No such file or directory (os error 2)\nrg: ./self: IO error for operation on ./self: Too many levels of symbolic links (os error 62)\nrg: ./dd/lp: IO error for operation on ./dd/lp: Too many levels of symbolic links (os error 62)\n"],
    ["RG-ERROR-TEXT","errs",".",["--files","-L","."],"empty",2,"./ok.txt\n","rg: ./gone: No such file or directory (os error 2)\nrg: ./self: Too many levels of symbolic links (os error 62)\nrg: ./dd/lp: Too many levels of symbolic links (os error 62)\n"],
    ["RG-ERROR-TEXT","errs",".",["-j1","--files","--follow","."],"empty",2,"./ok.txt\n","rg: ./gone: IO error for operation on ./gone: No such file or directory (os error 2)\nrg: ./self: IO error for operation on ./self: Too many levels of symbolic links (os error 62)\nrg: ./dd/lp: IO error for operation on ./dd/lp: Too many levels of symbolic links (os error 62)\n"],
    ["RG-ERROR-TEXT","errs",".",["-l","needle","self","ok.txt"],"empty",2,"ok.txt\n","rg: self: Too many levels of symbolic links (os error 62)\n"],
    ["RG-ERROR-TEXT","errs",".",["--files","self","ok.txt"],"empty",2,"ok.txt\n","rg: self: Too many levels of symbolic links (os error 62)\n"],
    ["RG-ERROR-TEXT","errs",".",["-l","needle",NREP,"ok.txt"],"empty",2,"ok.txt\n",`rg: ${NREP}: File name too long (os error 63)\n`],
    ["RG-ERROR-TEXT","errs",".",["-l","needle","ok.txt/x","ok.txt"],"empty",2,"ok.txt\n","rg: ok.txt/x: Not a directory (os error 20)\n"],
    ["RG-ERROR-TEXT","errs",".",["-c","needle","dd/lp","ok.txt"],"empty",2,"ok.txt:1\n","rg: dd/lp: Too many levels of symbolic links (os error 62)\n"],
  ],
  linux: [
    ["RG-ERROR-TEXT","errs",".",["-L","-l","needle","."],"empty",2,"./ok.txt\n","rg: ./gone: No such file or directory (os error 2)\nrg: ./self: Too many levels of symbolic links (os error 40)\nrg: ./dd/lp: Too many levels of symbolic links (os error 40)\n"],
    ["RG-ERROR-TEXT","errs",".",["-j1","-L","-l","needle","."],"empty",2,"./ok.txt\n","rg: ./gone: IO error for operation on ./gone: No such file or directory (os error 2)\nrg: ./self: IO error for operation on ./self: Too many levels of symbolic links (os error 40)\nrg: ./dd/lp: IO error for operation on ./dd/lp: Too many levels of symbolic links (os error 40)\n"],
    ["RG-ERROR-TEXT","errs",".",["--files","-L","."],"empty",2,"./ok.txt\n","rg: ./gone: No such file or directory (os error 2)\nrg: ./self: Too many levels of symbolic links (os error 40)\nrg: ./dd/lp: Too many levels of symbolic links (os error 40)\n"],
    ["RG-ERROR-TEXT","errs",".",["-j1","--files","--follow","."],"empty",2,"./ok.txt\n","rg: ./gone: IO error for operation on ./gone: No such file or directory (os error 2)\nrg: ./self: IO error for operation on ./self: Too many levels of symbolic links (os error 40)\nrg: ./dd/lp: IO error for operation on ./dd/lp: Too many levels of symbolic links (os error 40)\n"],
    ["RG-ERROR-TEXT","errs",".",["-l","needle","self","ok.txt"],"empty",2,"ok.txt\n","rg: self: Too many levels of symbolic links (os error 40)\n"],
    ["RG-ERROR-TEXT","errs",".",["--files","self","ok.txt"],"empty",2,"ok.txt\n","rg: self: Too many levels of symbolic links (os error 40)\n"],
    ["RG-ERROR-TEXT","errs",".",["-l","needle",NREP,"ok.txt"],"empty",2,"ok.txt\n",`rg: ${NREP}: File name too long (os error 36)\n`],
    ["RG-ERROR-TEXT","errs",".",["-l","needle","ok.txt/x","ok.txt"],"empty",2,"ok.txt\n","rg: ok.txt/x: Not a directory (os error 20)\n"],
    ["RG-ERROR-TEXT","errs",".",["-c","needle","dd/lp","ok.txt"],"empty",2,"ok.txt:1\n","rg: dd/lp: Too many levels of symbolic links (os error 40)\n"],
  ],
};
P9_NATIVE.push(...(P9_ERROR_TEXT[process.platform] || []));

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
// RG-ERROR-TEXT's one named divergence: node exposes no strerror(3), so on node quaude's rg words an errno as
// libuv's table does (capitalized), and native's text is mapped through that same table for node's runs; under tjs
// (the engine quaude ships) the text is judged exactly as native printed it.
function nodeText(err) {
  const util = require('node:util');
  return err.split('\n').map((l) => l.replace(/: ([^:]+) \(os error (\d+)\)$/, (m, t, n) => {
    const u = util.getSystemErrorMessage(-Number(n));
    return `: ${u[0].toUpperCase()}${u.slice(1)} (os error ${n})`;
  })).join('\n');
}
// RG-ERROR-TEXT ON A MUSL ENGINE, the named divergence stated in libexec/rg-native.cjs (Task 11 review I1): quaude's
// published Linux engine is static MUSL, whose strerror(3) words some errnos differently from glibc's, the libc
// native's rows were measured with. Measured 2026-10-05 over errnos 0..133 (musl in node:24.21.0-alpine, the engine
// built there printing the same table; glibc in gcc:13): 74 of 134 differ; these are the ones rg's searches meet.
// The engine is told by its own strerror(0) (musl "No error information", glibc "Success"). Native's rows stay as
// native printed them; under a musl engine they are read through these words.
const MUSL_TEXT = { 5: 'I/O error', 36: 'Filename too long', 40: 'Symbolic link loop', 95: 'Not supported' };
const engineLibc = (strerror0) => (strerror0 === 'No error information' ? 'musl' : strerror0 === 'Success' ? 'glibc' : null);
function muslText(err) {
  return err.split('\n').map((l) => l.replace(/: ([^:]+) \(os error (\d+)\)$/, (m, t, n) => (MUSL_TEXT[n] ? `: ${MUSL_TEXT[n]} (os error ${n})` : m))).join('\n');
}
function check(row, got, T, { engine = 'node', libc = null } = {}) {
  const [rule, tree, cwdRel, argv, home, rc, out, err0] = row;
  const err = engine === 'node' ? nodeText(err0) : libc === 'musl' ? muslText(err0) : err0;
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
  const r = rgn.runRg(c.argv, { cwd: c.cwd, env: c.env, spawnSync: cp.spawnSync,
    ugrep: () => (alone ? null : UGREP), matchFiles: alone ? rgn.matchFilesAlone : undefined });
  return { T: c.T, got: { status: r.status, stdout: l1(r.stdout), stderr: l1(r.stderr) } };
}
function asyncRun(root, row) {
  const c = rowCall(root, row);
  return new Promise((resolve) => {
    const child = rgn.rgExecFile(c.argv, { cwd: c.cwd, env: c.env, encoding: 'buffer' }, (e, so, se) => resolve({ T: c.T,
      got: { status: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: l1(so), stderr: l1(se) } }),
    'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP });
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
        const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP };
        const s = rgn.runRg(argv, { ...ctx, cwd, env });
        const a = await new Promise((res) => {
          const c = rgn.rgExecFile(argv, { cwd, env, encoding: 'buffer' }, (err, so, se) => res({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: l1(so), stderr: l1(se) }), 'rg', ctx);
          if (c.stdin) c.stdin.end();
        });
        out.push({ sync: { status: s.status, stdout: l1(s.stdout), stderr: l1(s.stderr) }, async: a });
      }
      const se = globalThis.__tjs_fs_sync && globalThis.__tjs_fs_sync.strerror;
      process.stdout.write('PROBE:' + JSON.stringify({ strerror0: se ? se(0) : null, out }) + '\\n');
    })();
  `);
  try {
    const res = runLoader(prog, [], { timeout: 180000 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    const { strerror0, out: got } = JSON.parse(line.slice('PROBE:'.length));
    const libc = process.platform === 'linux' ? engineLibc(strerror0) : null;
    if (process.platform === 'linux') assert.ok(libc, `a Linux engine whose libc its strerror(0) does not tell: ${JSON.stringify(strerror0)}`);
    assert.strictEqual(got.length, P9_NATIVE.length);
    P9_NATIVE.forEach((row, i) => { const T = path.join(root, row[1]); check(row, got[i].sync, T, { engine: 'tjs', libc }); check(row, got[i].async, T, { engine: 'tjs', libc }); });
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
        ugrep: () => null, matchFiles: rgn.matchFilesAlone });
      assert.strictEqual(r.stdout.toString('latin1'), expectedOrder(path.join(root, tree), tree, rel, lifo), `${tree} ${j.join(' ') || '(parallel)'}`);
    }
  }
}));
test('RG-WALK-ORDER: native\'s -j1 order is ours exactly, and its parallel order on a small tree is ours at least once in 10 on macOS, the same records elsewhere (native)',
  { skip: POSIX || (!NATIVE ? NATIVE_SKIP : false) }, () => withTrees((root) => {
    const env = { PATH: process.env.PATH, HOME: path.join(root, 'empty') };
    const native = (argv, cwd) => cp.spawnSync(NATIVE, ['--no-config', ...argv], { cwd, argv0: 'rg', env, encoding: 'latin1' }).stdout;
    const ours = (argv, cwd) => rgn.runRg(argv, { cwd, env, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone }).stdout.toString('latin1');
    for (const [tree, rel] of [['repo', '.'], ['badig', '.'], ['nested', 'top']]) {
      const argv = ['-j1', '-l', '--hidden', 'needle', rel], cwd = path.join(root, tree);
      assert.strictEqual(ours(argv, cwd), native(argv, cwd), `${tree}: -j1`);
    }
    // The parallel walk: ours (LIFO over readdir) is among native's orders on a small tree where that was MEASURED as
    // native's commonest, macOS (20 of 20). Elsewhere it is not: in an ubuntu:24.04 container on a 12-thread Xeon
    // (grep-native Task 11, 2026-10-05) native printed nested/tree as a,deep,sub and deep,a,sub over 10 runs, never
    // ours' deep,sub,a; ruling G15 already scoped the modal order to small macOS trees. There the order is what
    // normalization 1 forgives (scripts/lib/rg-probe.cjs), and the records must still be native's exactly.
    for (const [tree, cwdRel, rel] of [['repo', '.', 'code'], ['nested', 'top', 'tree']]) {
      const argv = ['-l', '--hidden', 'needle', rel], cwd = path.join(root, tree, cwdRel);
      const o = ours(argv, cwd);
      const seen = Array.from({ length: 10 }, () => native(argv, cwd));
      if (process.platform === 'darwin') {
        assert.ok(seen.includes(o), `${tree}/${rel}: native's parallel orders ${JSON.stringify([...new Set(seen)])} never once ours ${JSON.stringify(o)}`);
      } else {
        for (const n of new Set(seen)) assert.strictEqual(normalizeRg(Buffer.from(o, 'latin1'), argv), normalizeRg(Buffer.from(n, 'latin1'), argv), `${tree}/${rel}`);
      }
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
      const s = rgn.runRg(argv, { cwd: dir, spawnSync: cp.spawnSync, ugrep: () => UGREP });
      const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd: dir, encoding: 'buffer' }, (e, so, se) => res({ status: e ? e.code : 0, stdout: so, stderr: se }),
        'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP }));
      for (const g of [s, a]) {
        assert.deepStrictEqual([g.status, l1(g.stdout), lines(l1(g.stderr))], [2, out, lines(err)], how);
      }
    }
  } finally {
    for (const p of ['locked', 'noread.txt']) try { fs.chmodSync(path.join(dir, p), 0o755); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- RG-STDERR-ORDER ---------------------------------------------------------------------------------------------
// On one thread rg writes each message where its walk meets it: an ignore file that does not parse when its
// directory is entered, a file it cannot read when that file is searched. quaude's rg used to write every file
// ugrep could not read FIRST, before the walk's messages (grep-native Task 10 re-review 2, minor 4; ruling G29 (4)).
// Native 2.1.283 darwin-arm64, measured 2026-10-04, 3 runs each, the same bytes every run. The trees make the
// order the filesystem's readdir cannot change: A's .ignore is read on entering the root, before any entry of it;
// B's two roots are walked in the order named.
const STDERR_ORDER_IGNORE = "rg: ./.ignore: line 1: error parsing glob '[': unclosed character class; missing ']'\n";
const STDERR_ORDER = [
  ['A', ['-j1', 'needle', '.'], './d/a.txt:needle\n', `${STDERR_ORDER_IGNORE}rg: ./locked.txt: Permission denied (os error 13)\n`],
  ['A', ['-j1', '-l', 'needle', '.'], './d/a.txt\n', `${STDERR_ORDER_IGNORE}rg: ./locked.txt: Permission denied (os error 13)\n`],
  ['A', ['-j1', '-c', 'needle', '.'], './d/a.txt:1\n', `${STDERR_ORDER_IGNORE}rg: ./locked.txt: Permission denied (os error 13)\n`],
  ['B', ['-j1', 'needle', 'b', 'a'], 'b/x.txt:needle\na/ok.txt:needle\n',
    "rg: b/.ignore: line 1: error parsing glob '[': unclosed character class; missing ']'\nrg: a/locked.txt: Permission denied (os error 13)\n"],
  ['B', ['-j1', '-l', 'needle', 'b', 'a'], 'b/x.txt\na/ok.txt\n',
    "rg: b/.ignore: line 1: error parsing glob '[': unclosed character class; missing ']'\nrg: a/locked.txt: Permission denied (os error 13)\n"],
  ['B', ['-j1', '-c', 'needle', 'b', 'a'], 'b/x.txt:1\na/ok.txt:1\n',
    "rg: b/.ignore: line 1: error parsing glob '[': unclosed character class; missing ']'\nrg: a/locked.txt: Permission denied (os error 13)\n"],
  ['B', ['-j1', 'needle', 'a', 'b'], 'a/ok.txt:needle\nb/x.txt:needle\n',
    "rg: a/locked.txt: Permission denied (os error 13)\nrg: b/.ignore: line 1: error parsing glob '[': unclosed character class; missing ']'\n"],
];
test('RG-STDERR-ORDER: on one thread the walk\'s messages and the search\'s errors are written in walk order (native; both twins)', {
  skip: needUgrep.skip || ((process.getuid && process.getuid() === 0) ? 'root reads a chmod 000 file' : false),
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-stderr-order-')));
  const locked = ['A/locked.txt', 'B/a/locked.txt'];
  try {
    for (const [p, d] of [['A/.ignore', '[\n'], ['A/d/a.txt', 'needle\n'], ['A/locked.txt', 'needle\n'],
      ['B/a/locked.txt', 'needle\n'], ['B/a/ok.txt', 'needle\n'], ['B/b/.ignore', '[\n'], ['B/b/x.txt', 'needle\n']]) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), d);
    }
    for (const p of locked) fs.chmodSync(path.join(dir, p), 0);
    for (const [tree, argv, out, err] of STDERR_ORDER) {
      const cwd = path.join(dir, tree);
      const s = rgn.runRg(argv, { cwd, spawnSync: cp.spawnSync, ugrep: () => UGREP });
      const a = await new Promise((res) => rgn.rgExecFile(argv, { cwd, encoding: 'buffer' }, (e, so, se) => res({ status: e ? e.code : 0, stdout: so, stderr: se }),
        'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => UGREP }));
      for (const [how, g] of [['sync', s], ['async', a]]) {
        assert.deepStrictEqual([g.status, l1(g.stdout), l1(g.stderr)], [2, out, err], `${tree} ${argv.join(' ')} (${how})`);
      }
    }
  } finally {
    for (const p of locked) try { fs.chmodSync(path.join(dir, p), 0o644); } catch { /* gone */ }
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
  const opts = { spawnSync: cp.spawnSync, ugrep: () => null };
  const long = rgTypes.versionText();
  for (const [argv, want] of [[['--version'], long], [['-V'], VERSION_SHORT], [['-l', 'needle', '.', '--version'], long]]) {
    const r = rgn.runRg(argv, opts);
    assert.deepStrictEqual([r.status, r.stdout.toString(), r.stderr.toString()], [0, want, ''], argv.join(' '));
  }
  if (VERSION_NATIVE[process.arch]) assert.strictEqual(long, VERSION_NATIVE[process.arch]);
  // the bundle's first-use probe (2.1.283's DQ, what /doctor reports as "rg works"): `rg --version` through
  // execFile, stdout starting `ripgrep `
  const out = await new Promise((res) => rgn.rgExecFile(['--version'], {}, (e, so) => res(e ? null : so), 'rg', { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => null }));
  assert.ok(String(out).startsWith('ripgrep '), String(out));
});
test('RG-TYPE-LIST: --type-list prints native\'s table (its first lines and size, measured; the whole of it, where a native is at hand)', () => {
  const r = rgn.runRg(['--type-list'], { spawnSync: cp.spawnSync, ugrep: () => null });
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
    const r = rgn.runRg(['-l', 'needle', '.'], { cwd: dir, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone });
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
  try { r = rgn.runRg(['-l', '--hidden', 'needle', '.'], { cwd, spawnSync: cp.spawnSync, ugrep: () => UGREP }); } finally { fs.statSync = stat; }
  const listed = r.stdout.toString().split('\n').filter(Boolean).map((p) => path.resolve(cwd, p));
  assert.ok(listed.length >= 15, `${listed.length} files listed`);
  assert.deepStrictEqual(listed.filter((p) => seen.includes(p)), []);
}));

// ---- the async twin keeps the loop turning over a large walk (Task 9 review I-2) ----------------------------------
// The match pass sniffs each walked file's first bytes for a BOM (an open, a 4-byte read, a close); over 18.7k
// files that held the event loop 915 ms under tjs, 2.6 s under load, in one stretch (Glob, Task 10, walks every
// file). 30,000 files, two directory levels; the loop must keep turning.
//
// WHAT IS ASSERTED, AND WHY NOT A WALL-CLOCK BOUND. This held to "the longest gap < 600 ms" (Task 7's bound) until the
// full suite failed it at 602 ms on 2026-11-19 (d40fd9b) while it passed alone: the gap scales with machine load, the
// defect's and the fixed walk's alike. Measured on this tree under tjs (darwin arm64, 8 cores; 'defect' = rg-native.cjs
// with matchPlanGen's every-SNIFF_SLICE `yield` removed, which is the I-2 sync sniff this gate exists to catch):
//     load                     fixed: maxGap / walk ms           defect: maxGap / walk ms
//     alone                    112-123 / ~3,200   (0.035-0.038)  1,289-1,408 / ~3,250  (0.40-0.42)
//     8 CPU hogs (1x cores)    191-295 / ~7,300   (0.026-0.041)  2,730-2,814 / ~6,850  (0.40-0.41)
//     16+ CPU hogs (2x+)       455-497 / ~14,100  (0.033-0.035)  5,283-5,445 / ~13,050 (0.40-0.42)
// The absolute gap crosses 600 ms under load with the fix in place (and the defect's alone is only 2.2x that), but the
// share of the walk spent in its single longest hold does not move with load: <= 0.041 fixed, >= 0.40 defect. The bound
// is 0.15: 3.7x above the worst fixed share measured, 2.7x below the best defect share. Both are written here so a
// re-measurement can move it with a stated margin, never by bumping a number.
const HELD_SHARE_MAX = 0.15;
test('RG-WALK-*: the async twin keeps the loop turning over a walk of 30,000 files (tjs)', { skip: needUgrep.skip || NO_TJS }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-walk-gap-')));
  try {
    const tree = path.join(dir, 'w');
    for (let a = 0; a < 60; a++) {
      for (let b = 0; b < 50; b++) {
        const d = path.join(tree, `pkg${a}`, `lib${b}`);
        fs.mkdirSync(d, { recursive: true });
        for (let c = 0; c < 10; c++) fs.writeFileSync(path.join(d, `file${c}.js`), `module.exports = ${c};\n`);
      }
    }
    const prog = path.join(dir, 'probe.cjs');
    fs.writeFileSync(prog, `
      const rgn = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-native.cjs'))});
      const cp = require('child_process');
      const ctx = { spawn: cp.spawn, spawnSync: cp.spawnSync, ugrep: () => ${JSON.stringify(UGREP)} };
      (async () => {
        const t0 = Date.now(); let last = t0, maxGap = 0;
        const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
        const a = await new Promise((res) => rgn.rgExecFile(['-l', '--hidden', 'nothing-matches-this', 'w'], { cwd: ${JSON.stringify(dir)}, encoding: 'buffer', timeout: 120000 },
          (e, so) => res({ code: e ? e.code : 0, bytes: so.length }), 'rg', ctx));
        clearInterval(iv);
        process.stdout.write('PROBE:' + JSON.stringify({ maxGap, ms: Date.now() - t0, ...a }) + '\\n');
      })();
    `);
    const res = runLoader(prog, [], { timeout: 240000 });
    const got = JSON.parse(((res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:')) || 'PROBE:null').slice(6));
    assert.ok(got, `the tjs probe printed nothing (exit ${res.status}): ${(res.stderr || '').slice(0, 1500)}`);
    assert.deepStrictEqual([got.code, got.bytes], [1, 0], JSON.stringify(got));
    const share = got.maxGap / got.ms;
    assert.ok(share < HELD_SHARE_MAX, `the loop was held ${got.maxGap} ms in one stretch of a ${got.ms} ms walk (${share.toFixed(3)} of it; `
      + `the bound is ${HELD_SHARE_MAX}: the fixed walk measured <= 0.041 under any load, the sync sniff >= 0.40)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RG-ERROR-TEXT on a musl engine: native\'s glibc words read through musl\'s, by errno, and nothing else', () => {
  assert.strictEqual(engineLibc('No error information'), 'musl');
  assert.strictEqual(engineLibc('Success'), 'glibc');
  assert.strictEqual(engineLibc('Undefined error: 0'), null);
  assert.strictEqual(muslText('rg: ./self: Too many levels of symbolic links (os error 40)\nrg: x: File name too long (os error 36)\nrg: ./gone: No such file or directory (os error 2)\n'),
    'rg: ./self: Symbolic link loop (os error 40)\nrg: x: Filename too long (os error 36)\nrg: ./gone: No such file or directory (os error 2)\n');
});
