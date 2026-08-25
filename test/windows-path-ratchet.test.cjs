'use strict';
// WINDOWS PATH BUGS: A RATCHET, NOT A RESOLUTION.
//
// In one day we shipped five of these, each invisible until the one before it
// was fixed, and every one of them only reachable on a platform nobody here can
// run:
//
//   c4be23c  path.join(buildDir, 'tjsc')          — no .exe, so "tjsc did not build"
//   9c599b6  tjsc handed an ABSOLUTE Windows path — backslashes became a C identifier
//   0dd9553  which() joined dir+name, no PATHEXT  — never found ugrep.exe, ever
//   0dd9553  spawn tested only for '/'            — C:\t\ugrep.exe read as a bare name
//   0dd9553  a third hand-rolled PATH walk        — same bug, third copy
//
// They share four shapes. This file refuses to let a NEW instance of any of them
// in, on any host, at commit time — which is the only place we can catch them,
// since the behaviour itself needs Windows.
//
// WHAT THIS IS NOT. It is a spelling checker. It cannot catch a shape we have
// not met, and passing it is not evidence that anything works on Windows. The
// deeper ratchet — driving every path/exec function with win32 injected, the way
// test/bun-shim-which.test.cjs does — catches behaviour, and is the better tool
// where it exists. This is the cheap net under it.
//
// HOW TO ANSWER A FAILURE. Fix the code, or add the site to ALLOWED with a
// reason. Counts are EXACT, both directions: adding an instance fails, and
// removing one also fails, telling you to lower the number. That is what makes
// it a ratchet — the allowlist can only shrink unless someone deliberately
// writes down why it grew.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const RULES = {
  'path-walk': {
    re: /process\.env\.PATH/,
    why: 'resolving an executable by walking PATH has ONE home — clode-hosttools.findTool, which '
       + 'probes PATHEXT on Windows. Three hand-rolled copies existed and two were broken (0dd9553).',
  },
  'x-ok-exec': {
    re: /accessSync\([^)]*X_OK/,
    why: 'X_OK does not test executability on Windows. Under quaude fs.accessSync IS the CRT _access, '
       + 'and UCRT rejects mode 1 with EINVAL for every path — so this answers "not executable" always. '
       + 'Branch on win32 (statSync().isFile()), as clode-hosttools.isExecutableFile does.',
  },
  'slash-only-pathedness': {
    re: /includes\('\/'\)|lastIndexOf\('\/'\)|indexOf\('\/'\)/,
    why: 'on win32 a path may be C:\\x or a\\b, so "/" alone decides neither pathedness nor basename. '
       + 'Mirror child_process.cjs resolveExe: slash, plus backslash and drive-letter when isWin.',
  },
  'c-file-url-sep': {
    // NEW KIND, 2026-08-25. clode injects C into the engine (scripts/build-tjs.mjs
    // fixups). One fixup builds `import.meta.url` as a file:// URL from a module name.
    // On Windows tjs__normalize_pathsep has ALREADY rewritten '/' to '\\' in that name,
    // so a POSIX-shaped guard (`buf[0] == '/'`) never fires and the URL body carries
    // backslashes. Both legs failed with "fileURLToPath: not a file URL" while every
    // POSIX leg passed — invisible here, obvious there, which is this file's whole
    // subject.
    //
    // A count, not a proof: it cannot check that a given site normalizes. Its job is to
    // make a NEW file:// construction impossible to add without reading this note. The
    // proof for the existing site is the assertion below.
    roots: ['scripts'],
    re: /"file:\/\/"/,
    why: 'building a file:// URL from a path in injected C must treat BOTH separators as '
       + "absolute and emit forward slashes in the body — on Windows the module name "
       + 'already contains backslashes. See fixupImportMetaRequire.',
  },
  'bare-npm-spawn': {
    // THE mechanism that actually bit. On Windows npm is npm.cmd, and
    // execFileSync('npm', ...) is ENOENT there: libuv's path_search_walk_ext tries
    // only .com and .exe, and node's child_process has no .bat/.cmd handling. Same
    // family as the shebang stand-in that made the rg spawn-parity row unrunnable.
    // scripts/lib/npm-cli.cjs exists precisely for this -- run npm's own JS CLI
    // under THIS node -- and its header says so.
    roots: ['libexec', 'scripts', 'test'],
    re: /(?:execFileSync|spawnSync|spawn|exec)\(\s*['"]npm['"]/,
    why: 'spawning `npm` by bare name is ENOENT on Windows (npm is npm.cmd, and node '
       + 'cannot exec a .cmd). Use npmCliPath() from scripts/lib/npm-cli.cjs.',
  },
  'npm-global-layout': {
    // Wider than the others ON PURPOSE: this bug lives in test FIXTURES, which is
    // exactly where it bit. The other rules stay off test/ because tests there
    // legitimately walk PATH and test pathedness (bun-shim-which.test.cjs IS the
    // PATH-walking test), and baselining that noise would dull the whole file.
    roots: ['libexec', 'scripts', 'test'],
    re: /lib\/node_modules|'lib',\s*'node_modules'/,
    skip: /win32/,
    why: "npm's global root is <prefix>/lib/node_modules on POSIX but <prefix>/node_modules on "
       + 'Windows. Ask `npm root -g` rather than assuming a layout: a hardcoded POSIX shape made '
       + 'test/find-provider.test.cjs pass on darwin and linux and fail on windows-latest, while '
       + 'the shipped script -- which does ask npm -- was fine.',
  },
  'exe-join-no-win32': {
    re: /path\.join\([^)]*['"](tjsc|tjs|node|clode|claude|ugrep|bfs|naude|quaude)['"]\s*\)/,
    skip: /win32|\.exe/,
    why: 'an executable is NAME.exe on Windows. build-tjs joined buildDir with "tjsc" and threw '
       + '"tjsc did not build" the instant the compile was fixed (c4be23c).',
  },
};

// Block comments are replaced by their OWN newlines rather than deleted: removing
// them shifts every line number after the first /* ... */, and a gate that names
// the wrong line is worse than no gate. (Found by this file's own first run.)
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'deps' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const DEFAULT_ROOTS = ['libexec', 'scripts'];

function scan(repo = REPO, roots = null) {
  const hits = {};
  const all = roots || [...new Set(Object.values(RULES).flatMap((r) => r.roots || DEFAULT_ROOTS))];
  for (const root of all) {
    for (const file of walk(path.join(repo, root))) {
      const rel = path.relative(repo, file).split(path.sep).join('/');
      // This file quotes the very patterns it hunts for, in its rule text.
      if (rel === 'test/' + path.basename(__filename)) continue;
      stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        for (const [rule, spec] of Object.entries(RULES)) {
          if (!(spec.roots || DEFAULT_ROOTS).includes(root)) continue;
          if (!spec.re.test(line)) continue;
          if (spec.skip && spec.skip.test(line)) continue;
          const byFile = hits[rule] || (hits[rule] = {});
          (byFile[rel] || (byFile[rel] = [])).push(i + 1);
        }
      });
    }
  }
  return hits;
}

// EXACT counts, each with the reason it is not a bug. Every entry here was read
// and judged; none is "probably fine".
const ALLOWED = {
  'c-file-url-sep': {
    // The one injected file:// construction: fixupImportMetaRequire's import.meta.url.
    // Verified to handle both separators by the assertion at the end of this file.
    'scripts/build-tjs.mjs': 1,
  },
  'path-walk': {
    // Bun.which's own implementation and spawn's Bun-parity existence check.
    // These ARE the lookup — they now go through the PATHEXT-aware walk (0dd9553).
    'libexec/bun-shim.cjs': 2,
    // node's documented resolveExe semantics for child_process; already handles
    // backslash and drive-letter, and must stay independent of the shim's applets.
    'libexec/node-shim/modules/child_process.cjs': 2,
  },
  'x-ok-exec': {
    // Both sides of the win32/POSIX branch in the fixed which(); the win32 side
    // never reaches X_OK.
    'libexec/bun-shim.cjs': 2,
    // isExecutableFile — the one home, and it branches on isWin.
    'libexec/clode-hosttools.cjs': 1,
    // whichClaude — already PATHEXT-correct; runs under real Node, where libuv's
    // fs__access consults the mode only for W_OK.
    'libexec/clode-resolve.cjs': 1,
  },
  'slash-only-pathedness': {
    // 641/646 are GLOBS, where "/" is the glob's own semantics, not a path
    // separator. 837 is _exeIsPathed, which tests backslash and drive-letter too.
    'libexec/bun-shim.cjs': 3,
    // The loader's internal module ids are POSIX-canonical by construction.
    'libexec/node-shim/loader.cjs': 2,
    // resolveExe: the correct implementation everything else mirrors.
    'libexec/node-shim/modules/child_process.cjs': 1,
    // This IS the path module; :188 already tests both separators.
    'libexec/node-shim/modules/path.cjs': 2,
    // bytecodeSymbolBase deliberately mirrors tjsc's get_c_name, which splits on
    // "/" ONLY — modelling the tool's real behaviour, including the bug (9c599b6).
    'scripts/build-tjs.mjs': 1,
    // Repo-relative paths are POSIX-canonical on purpose: the recipe hash must be
    // identical on every host.
    'scripts/engine-recipe.mjs': 2,
  },
  'npm-global-layout': {
    // Each of these is the POSIX HALF of a correctly-branched pair; the Windows
    // layout is on the adjacent line (npm-cli.cjs even tries Windows FIRST), so the
    // line-scoped `skip: /win32/` cannot see it. Reviewed, all three.
    'scripts/lib/npm-cli.cjs': 1,
    'test/npm-cli-helper.test.cjs': 1,
    'test/find-provider.test.cjs': 1,
  },
  'exe-join-no-win32': {
    // Directory names ('share'/'clode', 'cache'/'clode'), not executables.
    'libexec/clode-paths.cjs': 4,
    // clode's CANONICAL storage name for the carved provider, which is never
    // executed — see the comment at binaryFor().
    'libexec/clode-update.cjs': 1,
    // A working-directory name, not an executable.
    'libexec/naude-entry.cjs': 1,
  },
};

test('no new Windows-path bug shapes in shipped JS', () => {
  const hits = scan();
  const problems = [];
  for (const [rule, byFile] of Object.entries(hits)) {
    for (const [file, lines] of Object.entries(byFile)) {
      const allowed = (ALLOWED[rule] || {})[file] || 0;
      if (lines.length > allowed) {
        problems.push(`${rule}: ${file} has ${lines.length} (allowed ${allowed}) at lines `
          + `${lines.join(', ')}\n    ${RULES[rule].why}`);
      }
    }
  }
  assert.deepStrictEqual(problems, [],
    `\n\n${problems.join('\n\n')}\n\nFix it, or add the site to ALLOWED in ${path.basename(__filename)} `
    + 'with the reason it is not a bug.\n');
});

test('the allowlist only shrinks — a removed instance must lower its count', () => {
  const hits = scan();
  const stale = [];
  for (const [rule, byFile] of Object.entries(ALLOWED)) {
    for (const [file, allowed] of Object.entries(byFile)) {
      const actual = ((hits[rule] || {})[file] || []).length;
      if (actual < allowed) stale.push(`${rule}: ${file} allows ${allowed} but only ${actual} remain`);
    }
  }
  assert.deepStrictEqual(stale, [],
    `\n\n${stale.join('\n')}\n\nGood news — these were fixed. Lower the numbers in ALLOWED so the `
    + 'ratchet holds the gain.\n');
});

// ---- artifact scan: a host path must never reach a committed artifact --------
//
// 9c599b6 generalised: tjsc named a generated C symbol after the path it was
// handed, so an absolute Windows path became `tjs__internal_D:\a\_temp\...`.
// The build-time guard for that lives in build-tjs (it asserts the emitted
// symbol). This is the committed-file half: a generated patch that carries
// someone's home directory or a drive letter is a build that was not
// reproducible, and it will differ per machine forever after.
test('generated patches carry no host absolute paths', () => {
  const dir = path.join(REPO, 'spike/quickjs/patches');
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.patch'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    src.split('\n').forEach((line, i) => {
      // A drive letter followed by a backslash, or a real home directory. Not
      // /usr or /etc — those are legitimate content in portability patches.
      const m = line.match(/[A-Za-z]:\\[\\A-Za-z0-9_.-]|\/(?:Users|home)\/[A-Za-z0-9_.-]+\//);
      if (m) offenders.push(`${name}:${i + 1}: ${m[0]}  in: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    `\n\n${offenders.join('\n')}\n\nA generated artifact must not embed the machine that generated it. `
    + 'Regenerate with a repo-relative path.\n');
});

module.exports = { RULES, ALLOWED, scan, stripComments };

// The PROOF for the counted `c-file-url-sep` rule above. A count cannot tell whether a
// given file:// construction normalizes separators; this reads the injected C and checks
// the two things that were actually wrong on Windows.
test('injected C that builds a file:// URL handles Windows separators', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'build-tjs.mjs'), 'utf8');
  const start = src.indexOf('"file://"');
  assert.ok(start > 0, 'expected exactly one injected file:// construction to verify');
  // Window around the construction: guard above it, body conversion below.
  const chunk = src.slice(Math.max(0, start - 900), start + 900);
  assert.match(chunk, /buf\[0\] == '\/' \|\| buf\[0\] == '\\\\\\\\'/,
    'the absolute-path guard must accept a BACKSLASH too: on Windows the module name '
    + 'has already been separator-normalized, so a "/"-only guard never fires');
  assert.match(chunk, /\*tjs__p == '\\\\\\\\'/,
    'the URL body must convert backslashes to forward slashes');
});
