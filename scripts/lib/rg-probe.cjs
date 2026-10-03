'use strict';
// The rg differential's instrument: the fixture trees, the argv matrix, the two runners and the
// comparer that test/fidelity/rg-differential.test.cjs judges with.
//
//   makeRgTree(dir, kind)       writes one fixture tree (kinds: RG_TREE_KINDS)
//   RG_MATRIX, cellArgv()       every argv upstream's Grep and Glob tools build, per tree kind
//   runNativeRg(bin, argv, cwd) native Claude Code's EMBEDDED rg, reached as upstream reaches it
//   runOursRg(argv, cwd)        quaude's rg under tjs, through the interception the bundle hits
//   compareRg(a, b)             stdout bytes + exit code, after the two named normalizations
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

// The variants report-grep measured, and the content-only flags. Patterns come from the regex
// dialect Rust regex and ugrep read the same way (the written divergence).
const GREP_VARIANTS = [
  ['plain', {}], ['-i', { i: true }], ['glob *.txt', { glob: '*.txt' }], ['glob **/*.{ts,tsx}', { glob: '**/*.{ts,tsx}' }],
  ['type ts', { type: 'ts' }], ['multiline', { multiline: true, pattern: 'one.beta' }],
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
const STDIN_VARIANTS = new Set(['plain', '-i', 'multiline', '-o', '-C 1', '-B 1 -A 2']);

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

// One cell's argv against the tree it runs in (`treeDir`: absolute, as the target for ABS).
function cellArgv(cell, treeDir) {
  if (cell.tool === 'Version') return ['--version'];
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
// stdout BYTES and the exit code. Two differences are forgiven, each here and nowhere else:
//
//   1. WALK ORDER. rg searches a tree in parallel and prints each file as it finishes, so the
//      ORDER of files is not deterministic (measured 2026-09-27, report-grep.md
//      native-evidence.txt: 6 runs of -l over one tree, 2 different orders). Unless the argv
//      asks rg to sort (--sort/--sortr, as the Glob tool does), each file's record is sorted
//      before comparing: `path\0` for -l/--files with --null (a line without it), `path\0N\n`
//      for -c, and for --json one file's begin..end messages as one record, the summary after
//      them. The records themselves, and the number of them, must still match exactly.
//   2. ELAPSED TIMES in --json: `"elapsed":{...}` in each end message's stats and
//      `"elapsed_total":{...}` in the summary are wall-clock readings; their contents are
//      blanked. Every other stat must match.
const L = (b) => Buffer.from(b || '').toString('latin1');   // one char per byte, both ways
const rgSorts = (argv) => argv.some((x) => /^--sortr?(=|$)/.test(x));
function recordShape(argv) {
  if (argv.includes('--json')) return 'json';
  if (argv.includes('--files') || argv.includes('-l') || argv.includes('--files-with-matches')) {
    return argv.includes('--null') || argv.includes('-0') ? '\0' : '\n';
  }
  if (argv.includes('-c') || argv.includes('--count') || argv.includes('--count-matches')) return '\n';
  return null;   // the standard printer: nothing measured calls for reordering it
}
const splitAfter = (s, sep) => { const out = []; let i = 0; for (let j; (j = s.indexOf(sep, i)) !== -1; i = j + 1) out.push(s.slice(i, j + 1)); if (i < s.length) out.push(s.slice(i)); return out; };
function normalizeRg(stdout, argv) {
  let s = L(stdout);
  const shape = recordShape(argv);
  if (shape === 'json') s = s.replace(/"(elapsed|elapsed_total)":\{[^{}]*\}/g, '"$1":{}');
  if (!shape || rgSorts(argv)) return s;
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
function compareRg(a, b) {
  const argv = a.argv || b.argv || [];
  const why = [];
  if (a.status !== b.status || (a.signal || null) !== (b.signal || null)) {
    why.push(`exit ${a.status}${a.signal ? ` (${a.signal})` : ''} vs ${b.status}${b.signal ? ` (${b.signal})` : ''}`);
  }
  const x = normalizeRg(a.stdout, argv), y = normalizeRg(b.stdout, argv);
  if (x !== y) {
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    why.push(`stdout differs at byte ${i} of ${x.length} vs ${y.length}${recordShape(argv) && !rgSorts(argv) ? ' (walk order normalized)' : ''}: `
      + `native ${snip(x, i)} ours ${snip(y, i)}`);
  }
  if (why.length && b.stderr && b.stderr.length) {
    const said = L(b.stderr).split('\n').find((l) => l.trim());
    if (said) why.push(`ours said ${JSON.stringify(said.slice(0, 200))}`);
  }
  return { same: why.length === 0, why: why.join('; ') };
}

module.exports = { RG_TREE_KINDS, makeRgTree, treeEntries, RG_MATRIX, cellArgv, grepArgv, globArgv, VCS_DIRS, flagLiterals, builderFlagLiterals, matrixDrift,
  consumerUsageErrorRegex, refusalDrift,
  runNativeRg, nativeRgVersion, runOursRg, cellInput, assertNoAncestorRules, runOursRgBatch, compareRg, normalizeRg };
