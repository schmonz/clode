'use strict';
// The rg differential's instrument: the fixture trees, the argv matrix, the two runners and the
// comparer that test/fidelity/rg-differential.test.cjs judges with.
//
//   makeRgTree(dir, kind)       writes one fixture tree (kinds: RG_TREE_KINDS)
//   RG_MATRIX, cellArgv()       every argv upstream's Grep and Glob tools build, per tree kind
//   runNativeRg(bin, argv, cwd) native Claude Code's EMBEDDED rg, reached as upstream reaches it
//   runOursRg(argv, cwd)        quaude's rg under tjs, through the interception the bundle hits
//   compareRg(a, b)             stdout bytes + exit code, after the three named normalizations
//
// Measurements behind every choice here: .superpowers/sdd/2026-09-26-netbsd-fixes/report-grep.md
// section 1 (the argv the tools build, how rg is spawned native vs quaude, the walk order, the
// residual classes and the trees that show them).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProbeOurs } = require('./text-probe.cjs');

// ---- the fixture trees ------------------------------------------------------------------------
// GENERATED, never committed: binaries and invalid UTF-8 do not belong in git, and a generator
// states every byte. These are the trees report-grep.md measured (its scratch fx/root, fx/nogit,
// fx/bin2), byte for byte:
//   root   a git repo (a `.git` DIRECTORY is what rg's ignore rules key on): text, an early-NUL
//          binary, invalid UTF-8, unicode and wide text, CRLF, a >500-column line, hidden and
//          .gitignored files, nested dirs, a symlink, an empty file, a file with no final newline
//   nogit  .gitignore AND .ignore with no repo (rg ignores the first, honours the second there),
//          plus ts/tsx/js files for globs and --type
//   bin2   an explicitly named-able binary (NUL at 19) and one whose NUL lies past rg's first
//          64 KiB read (a match at 0, NUL at 120030)
// Non-ASCII is built from code points (the Write/Edit tool hazard: never a literal in source).
const RG_TREE_KINDS = ['root', 'nogit', 'bin2'];
const cp = (...c) => String.fromCodePoint(...c);
const EARLY_NUL = Buffer.concat([Buffer.from('text needle before\n'), Buffer.from([0, 1, 2, 0x0a]), Buffer.from('needle after nul\n')]);
const LATE_NUL = Buffer.concat([Buffer.from('first needle line\n' + 'filler line\n'.repeat(10000) + 'near needle\n'),
  Buffer.from([0, 0x0a]), Buffer.from('after needle\n')]);

// [relative path, bytes | { symlink: target }], in the order their mtimes are assigned.
function treeEntries(kind) {
  if (kind === 'root') {
    return [
      ['.git/HEAD', 'ref: needle\n'],
      ['.gitignore', 'ignored.txt\n'],
      ['ignored.txt', 'ignored needle\n'],
      ['.hidden.txt', 'hidden needle\n'],
      ['a.txt', 'alpha needle one\nbeta\ngamma needle two needle\ndelta\nepsilon\nzeta needle\n'],
      ['bin.dat', EARLY_NUL],
      ['code.js', 'const needle = 1;\n'],
      ['crlf.txt', 'one needle\r\ntwo\r\nthree needle\r\n'],
      ['empty.txt', ''],
      ['latin1.txt', Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' needle\n')])],
      ['link.txt', { symlink: 'a.txt' }],
      ['long.txt', 'short needle\n' + 'x'.repeat(600) + ' needle ' + 'y'.repeat(10) + '\n' + 'c'.repeat(700) + '\nafter needle\n'],
      ['nonl.txt', 'last needle no newline'],
      ['sub/deep/nested.txt', 'nested needle\nctx\n'],
      ['uni.txt', `caf${cp(0xe9)} needle ${cp(0x4e2d, 0x6587)} needle\n${cp(0x1f600)} NEEDLE wide\nplain\n`],
      // last, so the files above keep their mtimes: under -U rg's searcher reads from where the last match ended,
      // so `ab|^c.d` matches `c\nd` there (RG-MULTILINE-SLICE) and widens line 1's block to line 2
      ['sp.txt', 'abc\nd\nxab\ncd\n'],
    ];
  }
  if (kind === 'nogit') {
    return [
      ['.gitignore', 'ignored.txt\n'],
      ['.ignore', 'skipme.txt\n'],
      ['ignored.txt', 'needle\n'],
      ['kept.txt', 'needle\n'],
      ['skipme.txt', 'needle\n'],
      ['sub/x.ts', 'needle\n'],
      ['sub/y.tsx', 'needle\n'],
      ['sub/z.js', 'needle\n'],
    ];
  }
  if (kind === 'bin2') return [['early.dat', EARLY_NUL], ['late.dat', LATE_NUL]];
  throw new Error(`makeRgTree: unknown tree kind ${JSON.stringify(kind)} (kinds: ${RG_TREE_KINDS.join(', ')})`);
}

// Distinct, fixed mtimes, oldest first in treeEntries order (NOT name order), so Glob's
// --sort=modified has one right answer and it is not the alphabetical one.
const MTIME_BASE = 1700000000;

// rg reads ignore rules from a tree's ANCESTORS as well as the tree: a `.git` above it makes it
// part of a repo (so .gitignore applies, which a `nogit` tree exists to show it does not), and
// a `.ignore`/`.rgignore` above it applies to every file. A fixture under one (an os.tmpdir()
// inside a checkout) would quietly measure something else, so it is refused, naming the file.
const ANCESTOR_RULES = ['.git', '.ignore', '.rgignore'];
function assertNoAncestorRules(dir) {
  let d = path.dirname(path.resolve(dir));
  for (;;) {
    for (const m of ANCESTOR_RULES) {
      if (fs.existsSync(path.join(d, m))) {
        throw new Error(`makeRgTree: ${path.join(d, m)} is above ${dir}; rg would read it, so this fixture would not `
          + 'measure what it is for. Put the fixture somewhere with no repo or ignore file above it.');
      }
    }
    const up = path.dirname(d);
    if (up === d) return;
    d = up;
  }
}

function makeRgTree(dir, kind) {
  const entries = treeEntries(kind);
  assertNoAncestorRules(dir);
  fs.mkdirSync(dir, { recursive: true });
  entries.forEach(([rel, data], i) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (data && data.symlink) { fs.symlinkSync(data.symlink, p); return; }
    fs.writeFileSync(p, data);
    const t = MTIME_BASE + 60 * i;
    fs.utimesSync(p, t, t);
  });
  return dir;
}

// ---- the argv matrix ----------------------------------------------------------------------------
// The Grep tool's argv, as 2.1.283's builder (`_In`) writes it, in its order: --hidden, a
// `--glob !<dir>` per VCS directory (`fIn`), --max-columns 500 ALWAYS, -U --multiline-dotall for
// multiline, -i, the mode flag (-l, or -c -H), --json for content else --null, then for content
// -n, -o and the context flags (`context`, else -C, else -B and -A), the pattern (after -e when
// it starts with -), --type, one --glob per piece of the glob parameter (split on whitespace,
// then on commas unless the piece holds braces), one --iglob per Read-deny rule, and the target.
// (Its version-dir and task-output exclusions need paths this fixture does not have, and no
// cell has deny rules, so no cell carries those or an --iglob.)
//
// SHAPED LIKE THE BUILDER ON PURPOSE, statement for statement: test/build-gates/rg-probe-gates
// .test.cjs compares the flag literals of this function, in source order, with the flag literals
// of the carve's own builder (matrixDrift below), so the day upstream adds, drops, reorders or
// re-values a flag (as 2.1.251 did when content mode became --json) this matrix goes red instead
// of judging an argv the tool no longer builds. For a FILE target the builder takes one more
// branch, for a task-output file only (`zOt`: a path under the config dir's tasks/), which feeds
// the file on stdin and drops every --glob; no fixture file is one, so no cell takes it.
const VCS_DIRS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
function grepArgv(p, target) {
  const mode = p.mode || 'files_with_matches';
  const a = ['--hidden'];
  const glob = (g) => a.push('--glob', g);
  for (const d of VCS_DIRS) glob(`!${d}`);
  a.push('--max-columns', '500');
  if (p.multiline) a.push('-U', '--multiline-dotall');
  if (p.i) a.push('-i');
  if (mode === 'files_with_matches') a.push('-l');
  else if (mode === 'count') a.push('-c', '-H');
  a.push(mode === 'content' ? '--json' : '--null');
  if (mode === 'content') a.push('-n');
  if (p.o && mode === 'content') a.push('-o');
  if (mode === 'content') {
    if (p.context !== undefined) a.push('-C', String(p.context));
    else if (p.C !== undefined) a.push('-C', String(p.C));
    else { if (p.B !== undefined) a.push('-B', String(p.B)); if (p.A !== undefined) a.push('-A', String(p.A)); }
  }
  if (p.pattern.startsWith('-')) a.push('-e', p.pattern); else a.push(p.pattern);
  if (p.type) a.push('--type', p.type);
  if (p.glob) {
    const pieces = [];
    for (const w of p.glob.split(/\s+/)) {
      if (w.includes('{') && w.includes('}')) pieces.push(w); else pieces.push(...w.split(',').filter(Boolean));
    }
    for (const g of pieces.filter(Boolean)) glob(g);
  }
  for (const g of p.iglob || []) a.push('--iglob', g);
  a.push(target);
  return a;
}
// The Glob tool's argv, as 2.1.283's builder (`eIn`) writes it with its defaults
// (CLAUDE_CODE_GLOB_NO_IGNORE and CLAUDE_CODE_GLOB_HIDDEN both default to true). Compared with
// the carve's the same way.
const globArgv = (pattern, target) => ['--files', '--null', '--glob', pattern, '--sort=modified', '--no-ignore', '--hidden', target];

// The flag literals of a builder's source text, in order: every quoted string that is a flag
// (starts with -) or a number. The ONE reading both sides of the comparison below go through.
function flagLiterals(src) {
  return [...String(src).matchAll(/(["'])(-[^"'\\\n]*|\d+)\1/g)].map((m) => m[2]);
}

// The two builders in a carve's (decoded) text, each found BY STRUCTURE and required exactly
// once, and cut to the span that writes the argv this matrix models:
//   Grep (`_In` in 2.1.283): from the `["--hidden"]` that starts the argv to its first
//        `"--iglob"` push, anchored on the one `"-U","--multiline-dotall"` push;
//   Glob (`eIn`): from the array that starts `"--files","--null","--glob"` to its first
//        `"--iglob"` push (exclusive: globArgv models no deny rules).
// Returns { grep, glob }, each { literals } or { missing: why }.
const GREP_ANCHOR = '"-U","--multiline-dotall"';
const GLOB_ANCHOR = '"--files","--null","--glob"';
function builderFlagLiterals(text) {
  const t = String(text);
  const once = (needle) => { const i = t.indexOf(needle); return i !== -1 && t.indexOf(needle, i + 1) === -1 ? i : -1; };
  const out = {};
  const g = once(GREP_ANCHOR);
  const gStart = g === -1 ? -1 : t.lastIndexOf('["--hidden"]', g);
  const gEnd = g === -1 ? -1 : t.indexOf('"--iglob"', g);
  out.grep = g === -1 ? { missing: `${GREP_ANCHOR} is not in the carve exactly once` }
    : gStart === -1 || gEnd === -1 ? { missing: 'the Grep builder has no ["--hidden"] before its -U push or no --iglob after it' }
      : { literals: flagLiterals(t.slice(gStart, gEnd + '"--iglob"'.length)) };
  const f = once(GLOB_ANCHOR);
  const fEnd = f === -1 ? -1 : t.indexOf('"--iglob"', f);
  out.glob = f === -1 ? { missing: `${GLOB_ANCHOR} is not in the carve exactly once` }
    : fEnd === -1 ? { missing: 'the Glob builder has no --iglob after its argv' }
      : { literals: flagLiterals(t.slice(f, fEnd)) };
  return out;
}

// What differs between this matrix's argv builders and the carve's: [] when they agree, else
// one finding per builder naming both literal lists. Each side is read through flagLiterals.
function matrixDrift(text) {
  const carve = builderFlagLiterals(text);
  const ours = { grep: flagLiterals(grepArgv.toString()), glob: flagLiterals(globArgv.toString()) };
  const findings = [];
  for (const k of ['grep', 'glob']) {
    if (carve[k].missing) { findings.push(`${k}: ${carve[k].missing}`); continue; }
    if (JSON.stringify(carve[k].literals) !== JSON.stringify(ours[k])) {
      findings.push(`${k}: the carve's builder writes ${JSON.stringify(carve[k].literals)}, `
        + `scripts/lib/rg-probe.cjs ${k}Argv ${JSON.stringify(ours[k])}`);
    }
  }
  return findings;
}

// THE CONSUMER'S USAGE-ERROR TEST, read from a carve BY STRUCTURE. The Grep/Glob consumer
// (`oX` in 2.1.283) shows the model an rc-2 run as an error ONLY when its stderr passes one
// regex (`TQ`), and then throws the class whose message begins "Search failed — ripgrep rejected
// the pattern, glob, or file type without searching" (`CD`); any other rc 2 with no output it
// reads as "no results". quaude's refusal (rg-native.cjs rgRefusal) must pass THAT regex, read
// from the carve, never a copy of it. Found by structure, never by those names:
//   1. the class whose constructor's super() message is that "Search failed ..." text;
//   2. the `<re>.test(<stderr>)){<reject>(new <that class>(` call that throws it;
//   3. `<re>=/.../<flags>`, the regex literal bound to that name.
// Returns { regex } or { missing: why }.
const ID = '[\\w$]+';
function consumerUsageErrorRegex(text) {
  const t = String(text);
  const all = (re) => [...t.matchAll(re)];
  const cls = all(new RegExp(`class (${ID}) extends ${ID}\\{constructor\\(${ID}\\)\\{super\\(\`Search failed[^\`]*?ripgrep rejected the pattern`, 'g'));
  if (cls.length !== 1) return { missing: `the "Search failed ... ripgrep rejected the pattern" class is in the carve ${cls.length} times, not once` };
  const esc = (n) => n.replace(/\$/g, '\\$');
  const use = all(new RegExp(`(${ID})\\.test\\(${ID}\\)\\)\\{${ID}\\(new ${esc(cls[0][1])}\\(`, 'g'));
  if (use.length !== 1) return { missing: `the test that throws ${cls[0][1]} is in the carve ${use.length} times, not once` };
  const def = all(new RegExp(`(?:^|[^\\w$])${esc(use[0][1])}=\\/((?:[^/\\\\\\n]|\\\\.)+)\\/([a-z]*)`, 'g'));
  if (def.length !== 1) return { missing: `the regex ${use[0][1]} is bound in the carve ${def.length} times, not once` };
  return { regex: new RegExp(def[0][1], def[0][2]) };
}

// What differs between quaude's refusal and the consumer's test: [] when every refusal shape
// (with a flag, and without one) passes it, else one finding per shape that does not.
function refusalDrift(text) {
  const { rgRefusal } = require('../../libexec/rg-native.cjs');
  const c = consumerUsageErrorRegex(text);
  if (c.missing) return [`usage-error regex: ${c.missing}`];
  const findings = [];
  for (const r of [rgRefusal('a reason', { flag: '--json' }), rgRefusal('a reason')]) {
    const line = r.stderr.toString('utf8');
    if (!c.regex.test(line)) {
      findings.push(`usage-error regex: the carve's ${c.regex} does not pass quaude's refusal ${JSON.stringify(line)}, `
        + 'so the model would read it as "no results"');
    }
  }
  return findings;
}

// ---- every rg argv the carve builds (grep-native Task 10 fix round, review I-1) --------------------------
// THE RATCHET for "a production flag refused": Task 10 refused --max-depth, which 2.1.283 passes in production
// (the orphaned-plugin-version listing, rt, the sandbox scan), and --follow (the FileIndex fallback) had been
// refused all along; nothing judged the argv the bundle builds OUTSIDE the Grep and Glob tools. This reads
// them from the carve BY STRUCTURE, never by minified names:
//   - every array literal that starts `["--files"` (each rg listing the bundle builds: the Glob tool, the
//     orphaned versions, rt, the sandbox scan, the file count, the FileIndex fallback, the markdown loader),
//     with the flags pushed onto it before it is handed to the runner (the code up to the next `await`,
//     `return` or `catch`);
//   - the Grep tool's builder, through grepArgv (matrixDrift holds it equal to the carve's), every mode;
//   - the first-use probe: `"--version"]` within 400 bytes before `.startsWith("ripgrep ")`;
//   - each of those again with `-j 1` first, where the runner's EAGAIN retry prepends it (`?["-j","1"]:[]`).
// A flag's value that is a string or template literal in the carve is taken (`${...}` as `x`); any other
// expression (`String(r)`, a variable) stands as a placeholder of the flag's kind. The argv ends with `.`.
// Returns [{ where, argv }]: `where` names the shape by its offset and first flags (stable to read, not a name).
const RG_VALUE_FLAGS = new Map([['--glob', 'x*'], ['-g', 'x*'], ['--iglob', 'x*'], ['--max-depth', '4'], ['--maxdepth', '4'], ['-d', '4'],
  ['-j', '1'], ['--threads', '1'], ['--type', 'ts'], ['-t', 'ts'], ['--type-not', 'ts'], ['-T', 'ts'], ['--sort', 'modified'],
  ['--sortr', 'modified'], ['-e', 'x'], ['--regexp', 'x'], ['-A', '1'], ['-B', '1'], ['-C', '1'], ['-M', '500'], ['--max-columns', '500'],
  ['--max-filesize', '4M']]);
// The string and template literals of a stretch of carve text, in order: [{ value, start, end, template }].
function jsLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== '"' && q !== '\'' && q !== '`') continue;
    let j = i + 1, v = '';
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') { v += src[j + 1]; j += 2; continue; }
      if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
        let depth = 1; j += 2;
        while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
        v += 'x';
        continue;
      }
      v += src[j++];
    }
    out.push({ value: v, start: i, end: j + 1, template: q === '`' });
    i = j;
  }
  return out;
}
// The end of the array literal that opens at `open` (its `[`), skipping strings: the index after its `]`.
function arrayEnd(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === '\'' || c === '`') {
      for (i++; i < t.length && t[i] !== c; i++) if (t[i] === '\\') i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i + 1;
  }
  return -1;
}
function argvOfRegion(region) {
  const lits = jsLiterals(region), argv = [];
  for (let k = 0; k < lits.length; k++) {
    const L = lits[k];
    if (!L.value.startsWith('-') || L.value === '-') continue;
    argv.push(L.value);
    if (!RG_VALUE_FLAGS.has(L.value)) continue;
    const next = lits[k + 1];
    const between = next ? region.slice(L.end, next.start) : '';
    if (next && /^\s*,\s*$/.test(between)) { argv.push(next.value); k++; } else argv.push(RG_VALUE_FLAGS.get(L.value));
  }
  return argv;
}
// THE RUNNERS, by structure (fix round 2, review N2: an argv the bundle built in a variable, or handed to a runner
// that is not oX, had been missed; the environment scan eo() runs `-o -H --no-messages ... --max-filesize 4M -e ...`
// through dTo, and quaude's rg refused it while this guard stayed green):
//   - a function that destructures the bundle's rg resolution, `{rgPath:A,rgArgs:B,argv0:C}=F()` (bD, NQ, dTo in
//     2.1.283), or that takes the sandbox's `X={command:"rg"}` default and destructures `{command:` from it (jv);
//   - and, to a fixpoint, a function that hands its own first parameter on as a runner's first argument (oX).
// Every call of a runner whose first argument is an array literal, or a variable holding one that starts with a
// flag, is a shape: the literal, plus what `NAME.push(...)` adds between the definition and the call.
const isIdent = (c) => c !== undefined && /[\w$]/.test(c);
// The index after the parenthesised group that opens at `open` (its `(`), skipping strings.
function parenEnd(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === '\'' || c === '`') { for (i++; i < t.length && t[i] !== c; i++) if (t[i] === '\\') i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}
// The name and first parameter of the function whose `function NAME(` most nearly precedes `at`.
function enclosingFunction(t, at) {
  const re = new RegExp(`function (${ID})\\((${ID})?`, 'g');
  const from = Math.max(0, at - 20000);
  let m, last = null;
  re.lastIndex = from;
  while ((m = re.exec(t)) && m.index < at) last = { name: m[1], first: m[2] || null, index: m.index };
  return last;
}
function carveRunners(t) {
  const runners = new Map();   // name -> where defined
  for (const m of t.matchAll(new RegExp(`function (${ID})\\([^)]*\\)\\{let\\{rgPath:${ID},rgArgs:${ID},argv0:${ID}\\}=${ID}\\(\\)`, 'g'))) runners.set(m[1], m.index);
  for (const m of t.matchAll(new RegExp(`function (${ID})\\(${ID},[^)]*${ID}=\\{command:"rg"\\}\\)\\{let\\{command:`, 'g'))) runners.set(m[1], m.index);
  // wrappers, to a fixpoint: a function that passes its own first parameter to a runner, near that runner
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, defAt] of [...runners]) {
      for (let i = t.indexOf(`${name}(`); i !== -1; i = t.indexOf(`${name}(`, i + 1)) {
        if (isIdent(t[i - 1]) || t[i - 1] === '.' || Math.abs(i - defAt) > 50000) continue;
        const f = enclosingFunction(t, i);
        if (!f || !f.first || runners.has(f.name) || !t.startsWith(`${name}(${f.first},`, i)) continue;
        runners.set(f.name, f.index);
        grew = true;
      }
    }
  }
  return runners;
}
// The argv a runner call at `i` (the index of `NAME(`) is handed, as the flags it reads: its first argument when that
// is an array literal, or a variable bound to one (`X=[` within 6000 bytes before) plus what `X.push(...)` adds
// between the binding and the call; null when the argument is neither, or does not start with a flag.
function runnerCallArgv(t, i, name) {
  const a = i + name.length + 1;
  let region = null;
  if (t[a] === '[') {
    const end = arrayEnd(t, a);
    if (end !== -1) region = t.slice(a, end);
  } else {
    const v = new RegExp(`^(${ID})[,)]`).exec(t.slice(a, a + 80));
    if (!v) return null;
    const X = v[1], back = t.slice(Math.max(0, i - 6000), i), base = Math.max(0, i - 6000);
    let def = -1;
    for (const m of back.matchAll(new RegExp(`(?<![\\w$.])${X.replace(/\$/g, '\\$')}=\\[`, 'g'))) def = base + m.index + X.length + 1;
    if (def === -1) return null;
    const end = arrayEnd(t, def);
    if (end === -1 || end > i) return null;
    const parts = [t.slice(def, end)];
    const pushes = t.slice(end, i);
    for (const m of pushes.matchAll(new RegExp(`(?<![\\w$.])${X.replace(/\$/g, '\\$')}\\.push\\(`, 'g'))) {
      const open = end + m.index + m[0].length - 1, close = parenEnd(t, open);
      if (close !== -1 && close <= i) parts.push(t.slice(open, close));
    }
    region = parts.join(',');
  }
  if (!region) return null;
  const first = jsLiterals(region)[0];
  if (!first || !first.value.startsWith('-')) return null;
  return argvOfRegion(region);
}
// Every argv a runner is called with: [{ where, argv }].
function runnerCallShapes(t, runners) {
  const shapes = [];
  for (const name of runners.keys()) {
    for (let i = t.indexOf(`${name}(`); i !== -1; i = t.indexOf(`${name}(`, i + 1)) {
      if (isIdent(t[i - 1]) || t[i - 1] === '.' || t.slice(Math.max(0, i - 9), i) === 'function ') continue;
      const flags = runnerCallArgv(t, i, name);
      if (!flags) continue;
      // a search with no -e reads its pattern from a positional the carve computes: stand one in
      const searches = !flags.includes('--files') && !flags.includes('--version') && !flags.includes('-e') && !flags.includes('--regexp');
      const argv = [...flags, ...(searches ? ['x'] : []), '.'];
      shapes.push({ where: `@${i} ${name}(${flags.slice(0, 3).join(' ')} ...)`, argv });
    }
  }
  return shapes;
}
function carveRgArgvShapes(text) {
  const t = String(text);
  const shapes = runnerCallShapes(t, carveRunners(t));
  for (let i = t.indexOf('["--files"'); i !== -1; i = t.indexOf('["--files"', i + 1)) {
    const end = arrayEnd(t, i);
    if (end === -1) continue;
    const rest = t.slice(end, end + 600);
    const stop = Math.min(...['await ', 'return ', 'catch', 'return}'].map((w) => { const j = rest.indexOf(w); return j === -1 ? rest.length : j; }));
    const argv = [...argvOfRegion(t.slice(i, end) + rest.slice(0, stop)), '.'];
    shapes.push({ where: `@${i} ${argv.slice(0, 4).join(' ')}`, argv });
  }
  for (const mode of ['files_with_matches', 'count', 'content']) {
    for (const p of [{}, { multiline: true, i: true }, { glob: '*.txt', type: 'ts' }, { o: true, C: 1 }, { B: 1, A: 2 }]) {
      const argv = grepArgv({ pattern: 'needle', mode, ...p }, '.');
      shapes.push({ where: `the Grep builder ${mode} ${JSON.stringify(p)}`, argv });
    }
  }
  for (let i = t.indexOf('.startsWith("ripgrep ")'); i !== -1; i = t.indexOf('.startsWith("ripgrep ")', i + 1)) {
    if (t.slice(Math.max(0, i - 400), i).includes('"--version"]')) { shapes.push({ where: `@${i} the first-use probe`, argv: ['--version'] }); break; }
  }
  // The runner's retry after EAGAIN prepends `-j 1` to whatever it runs (`?["-j","1"]:[]`): each shape again so.
  if (t.includes('?["-j","1"]:[]')) for (const s of shapes.slice()) shapes.push({ where: `${s.where} (retried: -j 1)`, argv: ['-j', '1', ...s.argv] });
  const seen = new Set();
  return shapes.filter((s) => { const k = JSON.stringify(s.argv); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- every reference to the rg resolution, and every call of a runner (grep-native Task 10b Step 0, ruling G29 (3)) --
// THE LOUD NETS. carveRunners finds a runner by its SHAPE; a new runner of another shape (one that reads
// `Q4().rgPath` into a variable, or spawns the accessor's `.command`) would be missed with only the shape floor
// to notice. So every reference to the resolution is accounted for, and so is every call of a runner it found:
//   - each `rgPath` in the carve, and each call of the accessor that Q4 itself reads (`let e=am();return{rgPath:
//     e.command,...}`), is inside a runner's destructure (carveRunners) or matches one NAMED non-runner below,
//     each with why it never runs rg;
//   - each call of a found runner (scoped: in the runner's own chunk, or in a chunk that imports it from there,
//     by its local name) is read as an argv shape (runnerCallArgv) or FORWARDS: it passes the enclosing
//     function's own first parameter, and that function is a runner too (oX hands its argv to bD).
// Anything else is a finding: a new runner, or a new reader of the resolution, must be classified by hand.
const RG_RESOLUTION_NON_RUNNERS = [
  { name: 'the resolution (Q4)', why: 'returns {rgPath,rgArgs,argv0} from the accessor; it runs nothing',
    re: `function ${ID}\\(\\)\\{let ${ID}=(${ID})\\(\\);return\\{rgPath:${ID}\\.command,rgArgs:${ID}\\.args,argv0:${ID}\\.argv0\\}\\}` },
  { name: 'the Grep target form (djn)', why: 'whether rgPath is absolute picks `.` + cwd or the absolute target, and refuses outside cwd for a bare name; a string test',
    re: `${ID}\\.isAbsolute\\(${ID}\\(\\)\\.rgPath\\)` },
  { name: 'the spawn cwd (hc)', why: 'hc(target, rgPath) picks the directory a runner spawns in; a string test',
    re: `(?<![\\w$.])${ID}\\(${ID},${ID}\\(\\)\\.rgPath\\)` },
  { name: 'the sandbox\'s ripgrep command', why: 'hands {command,args,argv0} to the sandbox, whose runner (jv, by its {command:"rg"} default) carveRunners finds',
    re: `\\{rgPath:${ID},rgArgs:${ID},argv0:${ID}\\}=${ID}\\(\\),${ID}=${ID}\\(\\)\\.map\\(\\(${ID}\\)=>${ID}\\?\\.sandbox\\?\\.ripgrep\\)` },
  { name: 'the sandbox\'s dependency check', why: 'checkDependencies({command}) asks Bun.which(command) on Linux and srt-win on Windows; it never runs rg',
    re: `\\{rgPath:${ID},rgArgs:${ID}\\}=${ID}\\(\\),${ID}=(?:await )?${ID}\\.checkDependencies(?:Async)?\\(\\{command:${ID},args:${ID}\\}\\)` },
  { name: 'the shell snapshot\'s rg (aAn)', why: 'writes the Bash tool\'s `alias rg=<rgPath>` into the snapshot (bun-shim\'s rewriteSnapshot answers `rg` there); it runs nothing',
    re: `if\\(${ID}\\.argv0\\)return\\{type:"function",snippet:${ID}\\("rg",${ID}\\.argv0\\)\\};let ${ID}=${ID}\\(\\[${ID}\\.rgPath\\]\\)` },
  { name: 'the ENOENT advice (YE)', why: 'reads the accessor\'s mode to word a spawn\'s ENOENT; it runs nothing',
    re: `if\\(${ID}\\.code==="ENOENT"&&${ID}\\(\\)\\.mode==="system"\\)` },
  { name: 'the status (uTo)', why: 'reports {mode,path,working} for /doctor; it runs nothing',
    re: `let ${ID}=${ID}\\(\\);return\\{mode:${ID}\\.mode,path:${ID}\\.command` },
  { name: 'the first-use probe (DQ)', why: 'runs `<command> --version`: read as the first-use probe shape by carveRgArgvShapes',
    re: `let ${ID}=${ID}\\(\\);try\\{let ${ID};if\\(${ID}\\.argv0\\)\\{let ${ID}=Bun\\.spawn\\(\\[${ID}\\.command,"--version"\\]` },
];
const CHUNK_MARK = 'import.meta.require = globalThis.__quaudeRequire;';
// The carve's chunks (one ESM module each, as extract-claude-js writes them): [{ start, end, path }]; the whole text
// is one chunk when it has no marks (the test's snippets).
function carveChunks(t) {
  const marks = [];
  for (let i = t.indexOf(CHUNK_MARK); i !== -1; i = t.indexOf(CHUNK_MARK, i + 1)) marks.push(i);
  if (!marks.length) return [{ start: 0, end: t.length, path: null }];
  const chunks = [{ start: 0, end: marks[0], path: null }];
  marks.forEach((m, k) => {
    const u = /import\.meta\.url = "file:\/\/([^"]+)"/.exec(t.slice(m, m + 300));
    chunks.push({ start: m, end: k + 1 < marks.length ? marks[k + 1] : t.length, path: u ? u[1] : null });
  });
  return chunks;
}
const chunkAt = (chunks, i) => chunks.find((c) => i >= c.start && i < c.end);
// Where a name defined in chunk `home` is called: [{ chunk, local }] for its own chunk and every chunk importing it.
function scopesOf(t, chunks, home, name) {
  const scopes = [{ chunk: home, local: name }];
  if (!home.path) return scopes;
  const esc = (n) => n.replace(/\$/g, '\\$');
  const spec = `from"${home.path}"`;
  for (let k = t.indexOf(spec); k !== -1; k = t.indexOf(spec, k + 1)) {
    const open = t.lastIndexOf('import{', k);
    if (open === -1) continue;
    const m = new RegExp(`[{,]${esc(name)}(?: as (${ID}))?[,}]`).exec(t.slice(open, k));
    const c = chunkAt(chunks, k);
    if (m && c && c !== home) scopes.push({ chunk: c, local: m[1] || name });
  }
  return scopes;
}
function callsIn(t, chunk, local) {
  const out = [];
  for (let i = t.indexOf(`${local}(`, chunk.start); i !== -1 && i < chunk.end; i = t.indexOf(`${local}(`, i + 1)) {
    if (isIdent(t[i - 1]) || t[i - 1] === '.' || t.slice(Math.max(0, i - 9), i) === 'function ') continue;
    out.push(i);
  }
  return out;
}
const around = (t, i) => JSON.stringify(t.slice(Math.max(0, i - 60), i + 60));
// Every reference to the resolution: [{ at, what, cls }], `cls` null when it is neither a runner's nor named.
function rgResolutionReferences(text) {
  const t = String(text), runners = carveRunners(t), chunks = carveChunks(t);
  const spans = [];
  for (const m of t.matchAll(new RegExp(`function (${ID})\\([^)]*\\)\\{let\\{rgPath:${ID},rgArgs:${ID},argv0:${ID}\\}=${ID}\\(\\)`, 'g'))) {
    if (runners.has(m[1])) spans.push({ start: m.index, end: m.index + m[0].length, cls: `the runner ${m[1]}` });
  }
  let accessor = null;
  for (const N of RG_RESOLUTION_NON_RUNNERS) {
    for (const m of t.matchAll(new RegExp(N.re, 'g'))) {
      spans.push({ start: m.index, end: m.index + m[0].length, cls: N.name });
      if (N.name === 'the resolution (Q4)') accessor = accessor || { name: m[1], at: m.index };
    }
  }
  const refs = [];
  const classify = (at, len) => { const s = spans.find((x) => at >= x.start && at + len <= x.end); return s ? s.cls : null; };
  for (const m of t.matchAll(/(?<![\w$])rgPath(?![\w$])/g)) refs.push({ at: m.index, what: 'rgPath', cls: classify(m.index, 6), context: around(t, m.index) });
  if (accessor) {
    const home = chunkAt(carveChunks(t), accessor.at);
    for (const { chunk, local } of scopesOf(t, chunks, home, accessor.name)) {
      for (const i of callsIn(t, chunk, local)) refs.push({ at: i, what: `${local}()`, cls: classify(i, local.length + 2), context: around(t, i) });
    }
  }
  return refs.sort((a, b) => a.at - b.at);
}
// Every call of a found runner: [{ at, runner, kind }], kind 'shape' | 'forward' | null.
function rgRunnerCalls(text) {
  const t = String(text), runners = carveRunners(t), chunks = carveChunks(t);
  const calls = [];
  for (const [name, defAt] of runners) {
    for (const { chunk, local } of scopesOf(t, chunks, chunkAt(chunks, defAt), name)) {
      for (const i of callsIn(t, chunk, local)) {
        let kind = runnerCallArgv(t, i, local) ? 'shape' : null;
        if (!kind) {
          const f = enclosingFunction(t, i);
          if (f && f.first && runners.has(f.name) && t.startsWith(`${local}(${f.first},`, i)) kind = `forward (${f.name} hands its argv on)`;
        }
        calls.push({ at: i, runner: name, local, kind, context: around(t, i) });
      }
    }
  }
  return calls.sort((a, b) => a.at - b.at);
}

// The variants report-grep measured, and the content-only flags. Patterns come from the regex
// dialect Rust regex and ugrep read the same way (the written divergence).
const GREP_VARIANTS = [
  ['plain', {}], ['-i', { i: true }], ['glob *.txt', { glob: '*.txt' }], ['glob **/*.{ts,tsx}', { glob: '**/*.{ts,tsx}' }],
  ['type ts', { type: 'ts' }], ['multiline', { multiline: true, pattern: 'one.beta' }],
  // -U's searcher, judged by the gate (Task 10 fix round): a match ending just after a \n ends its block there
  // (`needle.` takes the \n of `needle\n`), adjacent lines merge into one block (`^\w` matches at every line
  // start), and each find's haystack starts where the last match ended (`ab|^c.d`, root's sp.txt)
  ['multiline needle.', { multiline: true, pattern: 'needle.' }], ['multiline ^\\w', { multiline: true, pattern: '^\\w' }],
  ['multiline ab|^c.d', { multiline: true, pattern: 'ab|^c.d' }],
];
const CONTENT_VARIANTS = [['-o', { o: true }], ['-C 1', { C: 1 }], ['-B 1 -A 2', { B: 1, A: 2 }]];
const GREP_MODES = ['files_with_matches', 'count', 'content'];
const GLOB_PATTERNS = ['**/*.txt', '**/*.{ts,tsx}', '*'];
// The target forms. A DIRECTORY: native searches it as `.` with cwd = that directory (its rgPath
// is absolute, so `djn` asks for relative output); quaude's bare rgPath searches it by its
// absolute path. Both forms, every cell. A FILE (the Grep tool's path names one): both search it
// by its absolute canonical path; rg then treats a binary it was NAMED differently from one it
// found walking (report-grep class 10: convert mode, NUL counted as a line break), so bin2's
// early.dat is named in every Grep cell too. The Glob tool's path is always a directory.
const TARGETS = ['.', 'ABS'];
const FILE_TARGETS = { bin2: 'early.dat' };
// THE STDIN BRANCH (`STDIN`). For a task-output file (`zOt`) 2.1.283's builder opens the file,
// searches target `-` and pipes the file into rg's stdin, after splicing EVERY --glob out of the
// argv (the VCS excludes and the glob parameter alike); a glob or type parameter that would
// exclude the file makes it skip the search, so only the variants without one reach rg. The
// root tree's a.txt stands in for the task output.
const STDIN_FILE = { root: 'a.txt' };
const STDIN_VARIANTS = new Set(['plain', '-i', 'multiline', 'multiline needle.', 'multiline ^\\w', '-o', '-C 1', '-B 1 -A 2']);

const RG_MATRIX = [];
for (const kind of RG_TREE_KINDS) {
  const targets = FILE_TARGETS[kind] ? [...TARGETS, 'FILE'] : TARGETS;
  for (const mode of GREP_MODES) {
    for (const [name, v] of [...GREP_VARIANTS, ...(mode === 'content' ? CONTENT_VARIANTS : [])]) {
      for (const target of targets) {
        RG_MATRIX.push({ id: `${kind} Grep ${mode} ${name} ${target === 'FILE' ? FILE_TARGETS[kind] : target}`, kind,
          tool: 'Grep', target, spec: { pattern: 'needle', ...v, mode } });
      }
    }
  }
  if (STDIN_FILE[kind]) {
    for (const mode of GREP_MODES) {
      for (const [name, v] of [...GREP_VARIANTS, ...(mode === 'content' ? CONTENT_VARIANTS : [])]) {
        if (!STDIN_VARIANTS.has(name)) continue;
        RG_MATRIX.push({ id: `${kind} Grep ${mode} ${name} - (stdin: ${STDIN_FILE[kind]})`, kind, tool: 'Grep', target: 'STDIN',
          spec: { pattern: 'needle', ...v, mode } });
      }
    }
  }
  for (const pattern of GLOB_PATTERNS) {
    for (const target of TARGETS) RG_MATRIX.push({ id: `${kind} Glob ${pattern} ${target}`, kind, tool: 'Glob', target, spec: { pattern } });
  }
}
// rg --version: the bundle's first-use probe (`DQ` in 2.1.283) runs it and reads `ripgrep ` at
// the start of its stdout as "rg works" (what /doctor reports).
RG_MATRIX.push({ id: 'root rg --version', kind: 'root', tool: 'Version', target: '.', spec: {} });
// RG-WALK-ORDER's cells (ruling G15): the Grep tool's -l and -c argv over each tree, on ONE thread (-j1, which
// no upstream tool passes), where rg's walk order is fixed (depth first in readdir order) and compareRg judges
// it rather than forgiving it.
for (const kind of RG_TREE_KINDS) {
  for (const mode of ['files_with_matches', 'count']) {
    RG_MATRIX.push({ id: `${kind} Walk -j1 ${mode} .`, kind, tool: 'Walk', target: '.', spec: { pattern: 'needle', mode } });
  }
}

// One cell's argv against the tree it runs in (`treeDir`: absolute, as the target for ABS).
function cellArgv(cell, treeDir) {
  if (cell.tool === 'Version') return ['--version'];
  if (cell.tool === 'Walk') return ['-j1', ...grepArgv(cell.spec, '.')];
  if (cell.target === 'STDIN') {
    const a = grepArgv(cell.spec, '-');
    for (let i = a.length - 2; i >= 0; i--) if (a[i] === '--glob') a.splice(i, 2);   // the builder's splice
    return a;
  }
  const target = cell.target === 'ABS' ? treeDir
    : cell.target === 'FILE' ? path.join(treeDir, FILE_TARGETS[cell.kind]) : '.';
  return cell.tool === 'Glob' ? globArgv(cell.spec.pattern, target) : grepArgv(cell.spec, target);
}
// What a cell pipes into rg's stdin: the stdin branch's file, as bytes; nothing otherwise.
function cellInput(cell) {
  if (cell.target !== 'STDIN') return null;
  const entry = treeEntries(cell.kind).find(([rel]) => rel === STDIN_FILE[cell.kind]);
  return Buffer.from(entry[1]);
}

// ---- the runners ----------------------------------------------------------------------------------
// NATIVE: the claude binary with argv[0] `rg` and `--no-config`, exactly how upstream's embedded
// mode spawns it (`{ command: process.execPath, args: ['--no-config'], argv0: 'rg' }`; zsh's
// `ARGV0=rg <claude>` and bash's `exec -a rg <claude>` are the same thing). Never a host ripgrep.
function runNativeRg(bin, argv, cwd, { env, input } = {}) {
  const r = spawnSync(bin, ['--no-config', ...argv], { cwd, argv0: 'rg', env, input: input || undefined, encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
  if (r.error) throw new Error(`native rg (${bin}) did not run for ${JSON.stringify(argv)}: ${r.error.message}`);
  return { argv, status: r.status, signal: r.signal || null, stdout: r.stdout, stderr: r.stderr };
}

// The embedded rg's own --version, or null when this binary does not answer as rg here (a carve
// for another platform, or not a Claude Code binary at all). Refusing on that is the point: a
// native that did not run as rg looks exactly like "native found nothing".
function nativeRgVersion(bin) {
  const r = spawnSync(bin, ['--version'], { argv0: 'rg', encoding: 'utf8', timeout: 60000,
    env: { HOME: require('node:os').tmpdir() } });   // --version needs nothing from PATH
  const out = (r.stdout || '').trim();
  return !r.error && r.status === 0 && out.startsWith('ripgrep ') ? out : null;
}

// OURS: under tjs with bun-shim loaded, through the SAME interception the bundle hits — the
// bundle's own rg resolution (`Bun.which('rg') ?? 'rg'`, 2.1.283's `nm`) handed to
// child_process.execFile with the bundle's own options (`bD`: maxBuffer 20,000,000, timeout
// 20 s, killSignal SIGKILL), plus encoding 'buffer' so the bytes arrive unconverted.
// One tjs process runs a whole batch, one call after another.
const OURS_SOURCE = String.raw`
  const cp = require('child_process');
  // the bundle's resolution, over the PATH ours runs with (the tripwire's, in the gate)
  const rgPath = Bun.which('rg', input.env && input.env.PATH ? { PATH: input.env.PATH } : undefined) || 'rg';
  const b64 = (b) => Buffer.from(b == null ? '' : b).toString('base64');
  const run = (c) => new Promise((resolve) => {
    const child = cp.execFile(rgPath, c.argv, { cwd: c.cwd, env: input.env, encoding: 'buffer', maxBuffer: 20000000,
      timeout: 20000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ status, signal: (err && err.signal) || null,
        error: err && status === null && !err.signal ? String(err.code || err.message) : null,
        stdout: b64(stdout), stderr: b64(stderr) });
    });
    // the stdin branch: the file goes in through the child's stdin, as the bundle pipes it
    if (c.input != null && child.stdin) child.stdin.end(Buffer.from(c.input, 'base64'));
  });
  return (async () => {
    const results = [];
    for (const c of input.cells) results.push(await run(c));
    return { rgPath, results };
  })();
`;

function runOursRgBatch(cells, { env } = {}) {
  if (cells.length === 0) return [];
  const wire = cells.map((c) => ({ argv: c.argv, cwd: c.cwd, input: c.input ? Buffer.from(c.input).toString('base64') : null }));
  const got = runProbeOurs(OURS_SOURCE, { cells: wire, env: env || null }, 'rg-probe-');
  if (!got || !Array.isArray(got.results) || got.results.length !== cells.length) {
    throw new Error(`our rg probe answered ${got && got.results ? got.results.length : 'nothing'} of ${cells.length} cells`);
  }
  return got.results.map((r, i) => {
    if (r.error) throw new Error(`ours did not run for ${JSON.stringify(cells[i].argv)}: ${r.error}`);
    return { argv: cells[i].argv, status: r.status, signal: r.signal, rgPath: got.rgPath,
      stdout: Buffer.from(r.stdout, 'base64'), stderr: Buffer.from(r.stderr, 'base64') };
  });
}

function runOursRg(argv, cwd, opts = {}) { return runOursRgBatch([{ argv, cwd }], opts)[0]; }

// ---- the comparer ------------------------------------------------------------------------------
// stdout BYTES and the exit code. Three differences are forgiven, each here and nowhere else:
//
//   1. WALK ORDER. rg searches a tree in parallel and prints each file as it finishes, so the
//      ORDER of files is not deterministic (measured 2026-09-27, report-grep.md
//      native-evidence.txt: 6 runs of -l over one tree, 2 different orders; 2026-10-04, grep-native
//      Task 9: on the root of this matrix's kind of tree, 20 orders in 20 runs, on this Mac and in a
//      Linux container). Unless the argv asks rg to sort (--sort/--sortr, as the Glob tool does) or to
//      walk on ONE thread (-j1: depth first in readdir order, 20 of 20 on both, and quaude's rg walks
//      the same: RG-WALK-ORDER, ruling G15), each file's record is sorted before comparing: `path\0`
//      for -l/--files with --null (a line without it), `path\0N\n` for -c, and for --json one file's
//      begin..end messages as one record, the summary after them. The records themselves, and the
//      number of them, must still match exactly.
//   2. ELAPSED TIMES in --json: `"elapsed":{...}` in each end message's stats and
//      `"elapsed_total":{...}` in the summary are wall-clock readings; their contents are
//      blanked. Every other stat must match.
//   3. --version's simd(runtime) LINE, ON x86_64 ONLY (controller ruling 2026-10-04, under the user's
//      doctrine for performance artifacts; RG-VERSION-SIMD in libexec/rg-types.cjs): rg's x86_64 build
//      reads that line from the CPU (version.rs runtime_cpu_features: is_x86_feature_detected for SSE2,
//      SSSE3, AVX2), which quaude's rg, using no SIMD, does not; it prints the compile set there. On an
//      x86_64 host (`arch`, the one native and ours ran on) the line's contents are blanked in `rg
//      --version`'s output, and every other byte must match; on aarch64 the line is a build constant
//      (+NEON) and is judged.
const L = (b) => Buffer.from(b || '').toString('latin1');   // one char per byte, both ways
const rgSorts = (argv) => argv.some((x) => /^--sortr?(=|$)/.test(x));
// rg walks on one thread: -j1 / --threads=1, or the flag then `1`.
const rgOneThread = (argv) => argv.some((x, i) => x === '-j1' || x === '--threads=1' || ((x === '-j' || x === '--threads') && argv[i + 1] === '1'));
// The printer is the LAST of --json, -l and -c on the argv (rg's own rule, RG-ARGV: `--json -l` prints
// paths); --files lists files whatever else is asked.
function recordShape(argv) {
  const last = (...flags) => Math.max(...flags.map((f) => argv.lastIndexOf(f)));
  const json = last('--json'), files = last('-l', '--files-with-matches'), count = last('-c', '--count', '--count-matches');
  const sep = argv.includes('--null') || argv.includes('-0') ? '\0' : '\n';
  if (argv.includes('--files')) return sep;
  if (json > files && json > count) return 'json';
  if (files > count) return sep;
  if (count !== -1) return '\n';
  return null;   // the standard printer: nothing measured calls for reordering it
}
const splitAfter = (s, sep) => { const out = []; let i = 0; for (let j; (j = s.indexOf(sep, i)) !== -1; i = j + 1) out.push(s.slice(i, j + 1)); if (i < s.length) out.push(s.slice(i)); return out; };
const isVersion = (argv) => argv.length === 1 && argv[0] === '--version';
function normalizeRg(stdout, argv, { arch = process.arch } = {}) {
  let s = L(stdout);
  if (arch === 'x64' && isVersion(argv)) s = s.replace(/^simd\(runtime\):.*$/m, 'simd(runtime):');
  const shape = recordShape(argv);
  if (shape === 'json') s = s.replace(/"(elapsed|elapsed_total)":\{[^{}]*\}/g, '"$1":{}');
  if (!shape || rgSorts(argv) || rgOneThread(argv)) return s;
  if (shape !== 'json') return splitAfter(s, shape).sort().join('');
  const files = []; const rest = []; let cur = null;
  for (const line of splitAfter(s, '\n')) {
    if (line.startsWith('{"type":"begin"')) { cur = [line]; files.push(cur); continue; }
    if (cur) { cur.push(line); if (line.startsWith('{"type":"end"')) cur = null; continue; }
    rest.push(line);
  }
  return files.map((f) => f.join('')).sort().join('') + rest.join('');
}

const snip = (s, i) => JSON.stringify(s.slice(Math.max(0, i - 24), i + 40));
function compareRg(a, b, { arch = process.arch } = {}) {
  const argv = a.argv || b.argv || [];
  const why = [];
  if (a.status !== b.status || (a.signal || null) !== (b.signal || null)) {
    why.push(`exit ${a.status}${a.signal ? ` (${a.signal})` : ''} vs ${b.status}${b.signal ? ` (${b.signal})` : ''}`);
  }
  const x = normalizeRg(a.stdout, argv, { arch }), y = normalizeRg(b.stdout, argv, { arch });
  if (x !== y) {
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    why.push(`stdout differs at byte ${i} of ${x.length} vs ${y.length}${recordShape(argv) && !rgSorts(argv) && !rgOneThread(argv) ? ' (walk order normalized)' : ''}: `
      + `native ${snip(x, i)} ours ${snip(y, i)}`);
  }
  if (why.length && b.stderr && b.stderr.length) {
    const said = L(b.stderr).split('\n').find((l) => l.trim());
    if (said) why.push(`ours said ${JSON.stringify(said.slice(0, 200))}`);
  }
  return { same: why.length === 0, why: why.join('; ') };
}

// ---- RG-MMAP-EVERYWHERE: the one written platform divergence -------------------------------------------
// (user ruling 2026-10-04; libexec/rg-native.cjs states the rule.) quaude's rg answers a NAMED binary as rg
// searching a memory map does, on every host. rg's own predicate maps named files everywhere but macOS, a
// clause grep-searcher 0.1.14's mmap.rs:73-75 calls a guess ("I guess memory maps on macOS aren't great.
// Should re-evaluate."), so on macOS the expectation for these cells is LINUX native's answer, and macOS
// native's own is kept beside it as the record of the divergence. NOT A LOOSENING: on macOS each cell must
// still find macOS native printing exactly its recorded literal (else the record is stale: a finding), and
// ours must print exactly Linux native's (any other difference is a finding); every other cell, and every
// cell off macOS (native is Linux's answer there), is judged against native as it runs. The cells are the
// ones whose macOS and Linux answers differ: bin2's early.dat named, in content mode. Literals: normalizeRg
// of native 2.1.283 (darwin-arm64; linux-x64 in a node:24.21.0-bookworm container), the tree spelled
// <TREE>, measured 2026-10-04 (generator: grep-native task-8 report, gencells.cjs).
const MMAP_EVERYWHERE = { rule: 'RG-MMAP-EVERYWHERE', cells: {
  "bin2 Grep content plain early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":670,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":670,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":514,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":514,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content -i early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":670,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":670,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":514,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":514,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content glob *.txt early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":670,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":670,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":514,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":514,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content glob **/*.{ts,tsx} early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":670,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":670,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":514,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":514,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content type ts early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":670,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":670,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":514,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":514,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content -o early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":670,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":670,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":514,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":514,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content -C 1 early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"context\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"\\n\"},\"line_number\":2,\"absolute_offset\":19,\"submatches\":[]}}\n{\"type\":\"context\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"\\u0001\\u0002\\n\"},\"line_number\":3,\"absolute_offset\":20,\"submatches\":[]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":1100,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":1100,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"context\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"\\u0000\\u0001\\u0002\\n\"},\"line_number\":2,\"absolute_offset\":19,\"submatches\":[]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":689,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":689,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
  "bin2 Grep content -B 1 -A 2 early.dat": {
    macos: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"context\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"\\n\"},\"line_number\":2,\"absolute_offset\":19,\"submatches\":[]}}\n{\"type\":\"context\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"\\u0001\\u0002\\n\"},\"line_number\":3,\"absolute_offset\":20,\"submatches\":[]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":4,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":40,\"bytes_printed\":1100,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":1100,\"bytes_searched\":40,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
    linux: { status: 0, stdout: "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"}}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"text needle before\\n\"},\"line_number\":1,\"absolute_offset\":0,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":5,\"end\":11}]}}\n{\"type\":\"context\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"\\u0000\\u0001\\u0002\\n\"},\"line_number\":2,\"absolute_offset\":19,\"submatches\":[]}}\n{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"lines\":{\"text\":\"needle after nul\\n\"},\"line_number\":3,\"absolute_offset\":23,\"submatches\":[{\"match\":{\"text\":\"needle\"},\"start\":0,\"end\":6}]}}\n{\"type\":\"end\",\"data\":{\"path\":{\"text\":\"<TREE>/early.dat\"},\"binary_offset\":19,\"stats\":{\"elapsed\":{},\"searches\":1,\"searches_with_match\":1,\"bytes_searched\":19,\"bytes_printed\":689,\"matched_lines\":2,\"matches\":2}}}\n{\"data\":{\"elapsed_total\":{},\"stats\":{\"bytes_printed\":689,\"bytes_searched\":19,\"elapsed\":{},\"matched_lines\":2,\"matches\":2,\"searches\":1,\"searches_with_match\":1}},\"type\":\"summary\"}\n" },
  },
} };
// A recorded literal in this tree, as native prints it there: <TREE> spelled as `tree` the way serde_json
// writes a string (`"` and `\` escaped, every C0 control as \b \f \n \r \t or \u00XX, everything else
// its UTF-8 bytes: RG-JSON-ESCAPE), and each file's bytes_printed (its begin, match and context messages,
// RG-JSON) and the summary's sum counted again in BYTES, since the path is in each. A Buffer of those bytes.
const serdeString = (s) => s.replace(/["\\\u0000-\u001f]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c]
  || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
function inTree(literal, tree) {
  const lines = literal.split('<TREE>').join(serdeString(tree)).split('\n');
  let file = 0, total = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\{"type":"(?:begin|match|context)"/.test(l)) file += Buffer.byteLength(l, 'utf8') + 1;
    else if (l.startsWith('{"type":"end"')) { lines[i] = l.replace(/"bytes_printed":\d+/, `"bytes_printed":${file}`); total += file; file = 0; }
    else if (/"type":"summary"\}$/.test(l)) lines[i] = l.replace(/"bytes_printed":\d+/, `"bytes_printed":${total}`);
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}
// What a cell is judged against on `platform` (where native ran): null when nothing is excepted, else
// { expected: Linux native's answer in this tree, stale: a finding when macOS native no longer prints its
// recorded answer, else null }.
function mmapEverywhere(id, native, argv, tree, platform) {
  const rec = MMAP_EVERYWHERE.cells[id];
  if (!rec || platform !== 'darwin') return null;
  const nat = normalizeRg(native.stdout, argv), was = normalizeRg(inTree(rec.macos.stdout, tree), argv);
  const stale = native.status === rec.macos.status && nat === was ? null
    : `${MMAP_EVERYWHERE.rule}'s record of native macOS no longer holds (exit ${native.status}, recorded ${rec.macos.status}; `
      + `stdout ${nat === was ? 'as recorded' : 'differs'}): re-measure the divergence`;
  const expected = { argv, status: rec.linux.status, signal: null, stdout: inTree(rec.linux.stdout, tree), stderr: Buffer.alloc(0) };
  return { expected, stale };
}

module.exports = { RG_TREE_KINDS, makeRgTree, treeEntries, RG_MATRIX, cellArgv, grepArgv, globArgv, VCS_DIRS, flagLiterals, builderFlagLiterals, matrixDrift,
  consumerUsageErrorRegex, refusalDrift, carveRgArgvShapes, carveRunners, rgResolutionReferences, rgRunnerCalls, RG_RESOLUTION_NON_RUNNERS,
  runNativeRg, nativeRgVersion, runOursRg, cellInput, assertNoAncestorRules, runOursRgBatch, compareRg, normalizeRg, rgOneThread, MMAP_EVERYWHERE, mmapEverywhere, inTree };
