'use strict';
// rg-walk.cjs — quaude's rg's WALK: which files a directory search reaches, in which order, as native's
// embedded rg decides (grep-native Task 9). ripgrep 14.1.1's ignore crate 0.4.23 (walk.rs, dir.rs,
// gitignore.rs, overrides.rs, types.rs) and globset 0.4.15 (glob.rs), read from the crates, and each
// rule measured against native 2.1.283 and pinned by a same-named test with native's literals
// (test/rg-walk.test.cjs). It hands rg-native.cjs the file list ugrep then searches; ugrep never walks.
//
// THE RULES:
//   RG-GLOB-DIALECT    rg's glob dialect (globset): `*` and `?` stop at `/`, `**` as a whole component
//                      (`**/`, `/**`, `/**/`), `[...]` (`!`/`^` negate, `-` ranges, a leading `]`),
//                      `{a,b}` (never nested; an empty branch matches nothing), `\` escapes; matched
//                      against the path's BYTES (a non-ASCII letter is its UTF-8 bytes, a class of one such letter a class of its bytes);
//                      a glob that does not parse is rg's error, rc 2, nothing searched
//   RG-GLOB-LINE       a --glob, and each line of an ignore file, read as a gitignore line: `#` a comment,
//                      trailing white space dropped (unless `\ `), `!` inverts, a leading `/` anchors, a
//                      trailing `/` matches directories only, no `/` matches at any depth, `X/**` what is
//                      under X; the last line that matches decides
//   RG-GLOB-ROOT       --glob and --iglob are matched relative to rg's working directory (its canonical
//                      path, as getcwd gives it): a path under it loses that prefix, any other is matched
//                      as it is spelled (so `/private` anchors to the cwd, not to the searched directory);
//                      --iglob is case-insensitive (ASCII) and every --iglob comes after every --glob
//   RG-GLOB-EXCLUDES-DIRS  a `!G` glob that matches a DIRECTORY excludes it and all under it
//   RG-GLOB-DENY-RULES the --iglob shapes 2.1.283's Grep tool writes for Read-deny rules (`!/S`, and `!/S`
//                      beside `!/S/**`; `!**/S`; `!**`; braces as `[{]`), walked as rg walks any glob: what
//                      native excludes, ours excludes (Task 6 review M-1)
//   RG-GLOB-WHITELIST  a glob without `!` whitelists what it matches over every ignore rule and over
//                      hiding, and once there is one, a FILE no glob matches is excluded (a directory
//                      no glob matches falls through to the ignore rules)
//   RG-IGNORE-FILES    in each directory: .rgignore over .ignore over .gitignore over .git/info/exclude
//                      over the global excludes; within a kind the deepest directory's matching line wins
//   RG-IGNORE-REPO     .gitignore, .git/info/exclude and the global excludes apply only in a git repo (a
//                      `.git`, file or directory, in the directory or above it), and .gitignore files
//                      only up to the directory holding that `.git`; .ignore and .rgignore always apply
//   RG-IGNORE-PARENTS  ignore files in the searched directory's ancestors apply, matched against the
//                      canonical searched directory joined with the entry's path relative to ITS OWN
//                      directory (rg's dir.rs rebuild, measured: top/.ignore's `tree/sub/b.txt` misses
//                      top/tree/sub/b.txt searched from top/tree, and hits every b.txt searched from sub)
//   RG-IGNORE-GLOBAL   the global excludes: ~/.gitconfig's core.excludesFile (`~` is HOME), else
//                      $XDG_CONFIG_HOME/git/config's (or ~/.config/git/config's), else
//                      $XDG_CONFIG_HOME/git/ignore (or ~/.config/git/ignore); HOME and XDG_CONFIG_HOME are
//                      the CHILD's environment, as rg's are
//   RG-IGNORE-FILE-ERRORS  a line of an ignore file that does not parse is skipped and named on stderr
//                      (`rg: PATH: line N: error parsing glob ...`, rc unchanged); a line that is not
//                      UTF-8 ends that file silently; one in an ANCESTOR's file is an error (rc 2)
//   RG-NO-IGNORE       --no-ignore: none of the ignore files, ancestors' or global
//   RG-HIDDEN          a name starting with `.` is skipped unless --hidden, or a glob, ignore line or type
//                      whitelists it; `.git` is an ordinary hidden directory (searched under --hidden)
//   RG-TYPE            --type T selects files whose NAME matches one of T's globs (rg-types.cjs, from
//                      native), --type-not T rejects them, the last that matches decides; once one is
//                      selected a file matching none is excluded; `all` is every type; an unknown name is
//                      rg's error; a --glob decides before a type does
//   RG-WALK-SYMLINK    a symlink the walk finds is neither followed nor searched; a NAMED one is followed
//   RG-WALK-ORDER      -j1 (and rg's single-threaded cases): depth first, each directory in the order the
//                      OS's readdir gives it (30 of 30). Otherwise rg walks in parallel and the order is
//                      not fixed: its MODAL order is a LIFO stack over readdir order (each directory's
//                      entries last-first, a subdirectory walked when it is popped; 6 of 6 and 33 of 40,
//                      Task 7 review), which quaude's rg prints; rg-differential forgives order there,
//                      and only there. ONE behaviour everywhere: a host with one CPU runs native rg on one
//                      thread (available_parallelism, a performance choice), and quaude's rg still walks
//                      as the parallel walk's mode. Several roots: each in turn, as given (native has no
//                      modal order across roots: 8 runs, 6 orders).
//   RG-WALK-ERROR      a directory that cannot be read is rg's error (rc 2, the rest searched):
//                      `rg: DIR: ERR` in the parallel walk, `rg: DIR: IO error for operation on DIR: ERR` in
//                      the single-threaded one
//   RG-REFUSE-NAME-NOT-UTF8  a name that is not UTF-8 cannot be carried through this engine's readdir,
//                      open and ugrep's argv, so the search refuses by name, never answering without it
//
// NOT MODELLED (and measured to be beyond the matrix): Windows' path spelling (`\` joins, FILE_ATTRIBUTE_HIDDEN
// as hidden; unmeasured, rg's own per-platform rules there are real platform facts); rg's max-filesize,
// --follow, --one-file-system, --ignore-file, --no-ignore-* and --no-require-git (refused by name by
// rg-native.cjs's argv reader). Loaded by rg-native.cjs as `require(__dirname + '/rg-walk.cjs')`, so it
// travels beside it (test/shim-companions.test.cjs), with its own companion rg-types.cjs. Node builtins only.

let _types = null;
const rgTypes = () => _types || (_types = require(__dirname + '/rg-types.cjs'));

// A path's (or a glob character's) BYTES as a string of one char per byte: globs match bytes (globset
// builds its regexes with (?-u)).
const bytesOf = (s) => Buffer.from(String(s), 'utf8').toString('latin1');

// ---- globset: rg's glob dialect --------------------------------------------------------------------
// A glob's error, as rg prints it: `error parsing glob 'G': KIND`. `usage`: rg stops before searching.
class GlobError extends Error {
  constructor(original, kind) { super(`error parsing glob '${original}': ${kind}`); this.name = 'GlobError'; this.kind = kind; }
}
const KIND = {
  unclosedClass: 'unclosed character class; missing \']\'',
  unclosedAlt: 'unclosed alternate group; missing \'}\' (maybe escape \'{\' with \'[{]\'?)',
  nestedAlt: 'nested alternate groups are not allowed',
  dangling: 'dangling \'\\\'',
  range: (a, b) => `invalid range; '${a}' > '${b}'`,
};
// globset's Parser, step for step (glob.rs Parser::parse and its helpers): tokens
// { t: 'lit', c } | { t: 'any' } | { t: 'zom' } | { t: 'rprefix' } | { t: 'rsuffix' } | { t: 'rzom' } |
// { t: 'class', neg, ranges: [[c, c]] } | { t: 'alt', alts: [tokens] }. Throws { kind }.
function parseGlob(glob) {
  const chars = Array.from(glob);
  const isSep = (c) => c === '/';
  let i = 0, prev = null, cur = null;
  const stack = [[]];
  const bump = () => { prev = cur; cur = i < chars.length ? chars[i++] : null; return cur; };
  const peek = () => (i < chars.length ? chars[i] : null);
  const top = () => stack[stack.length - 1];
  const push = (t) => top().push(t);
  const fail = (kind) => { throw { kind }; };
  const zom2 = () => { push({ t: 'zom' }); push({ t: 'zom' }); };
  const star = () => {
    const p = prev;
    if (peek() !== '*') { push({ t: 'zom' }); return; }
    bump();
    if (top().length === 0) {
      if (!(peek() === null || isSep(peek()))) zom2();
      else { push({ t: 'rprefix' }); bump(); }
      return;
    }
    if (!(p !== null && isSep(p)) && (stack.length <= 1 || (p !== ',' && p !== '{'))) { zom2(); return; }
    let suffix;
    const pk = peek();
    if (pk === null) { bump(); suffix = true; } else if ((pk === ',' || pk === '}') && stack.length >= 2) suffix = true;
    else if (isSep(pk)) { bump(); suffix = false; } else { zom2(); return; }
    const last = top().pop();
    push(last.t === 'rprefix' ? last : last.t === 'rsuffix' ? last : { t: suffix ? 'rsuffix' : 'rzom' });
  };
  const klass = () => {
    const ranges = [];
    let neg = false;
    if (peek() === '!' || peek() === '^') { bump(); neg = true; }
    let first = true, inRange = false;
    const extend = (c) => {
      const r = ranges[ranges.length - 1];
      r[1] = c;
      if (r[1].codePointAt(0) < r[0].codePointAt(0)) fail(KIND.range(r[0], r[1]));
    };
    for (;;) {
      const c = bump();
      if (c === null) fail(KIND.unclosedClass);
      if (c === ']') { if (first) ranges.push([']', ']']); else break; }
      else if (c === '-') {
        if (first) ranges.push(['-', '-']);
        else if (inRange) { extend('-'); inRange = false; } else inRange = true;
      } else { if (inRange) extend(c); else ranges.push([c, c]); inRange = false; }
      first = false;
    }
    if (inRange) ranges.push(['-', '-']);
    push({ t: 'class', neg, ranges });
  };
  for (let c; (c = bump()) !== null;) {
    if (c === '?') push({ t: 'any' });
    else if (c === '*') star();
    else if (c === '[') klass();
    else if (c === '{') { if (stack.length > 1) fail(KIND.nestedAlt); stack.push([]); }
    else if (c === '}') { const alts = []; while (stack.length >= 2) alts.push(stack.pop()); push({ t: 'alt', alts }); }
    else if (c === ',') { if (stack.length <= 1) push({ t: 'lit', c }); else stack.push([]); }
    else if (c === '\\') { const e = bump(); if (e === null) fail(KIND.dangling); push({ t: 'lit', c: e }); }
    else push({ t: 'lit', c });
  }
  if (stack.length > 1) fail(KIND.unclosedAlt);
  return stack[0];
}
// A byte class as regex-syntax reads globset's escaped class (`[\xc3\xa9-\xc3\xb1]`: a range's ends are
// its first char's LAST byte and its second char's FIRST byte), ASCII case folded under (?i), then
// negated, as a JS character class over one-char-per-byte strings.
const hex2 = (b) => `\\x${b.toString(16).padStart(2, '0')}`;
function classSource(neg, ranges, ci) {
  const set = new Uint8Array(256);
  for (const [a, b] of ranges) {
    const A = Buffer.from(a, 'utf8'), B = Buffer.from(b, 'utf8');
    if (a === b) { for (const x of A) set[x] = 1; continue; }
    for (let k = 0; k < A.length - 1; k++) set[A[k]] = 1;
    for (let x = A[A.length - 1]; x <= B[0]; x++) set[x] = 1;
    for (let k = 1; k < B.length; k++) set[B[k]] = 1;
  }
  if (ci) for (let x = 0x41; x <= 0x5a; x++) if (set[x] || set[x + 32]) { set[x] = 1; set[x + 32] = 1; }
  if (neg) for (let x = 0; x < 256; x++) set[x] ^= 1;
  let out = '';
  for (let x = 0; x < 256; x++) {
    if (!set[x]) continue;
    let y = x;
    while (y + 1 < 256 && set[y + 1]) y++;
    out += y === x ? hex2(x) : `${hex2(x)}-${hex2(y)}`;
    x = y;
  }
  return out ? `[${out}]` : '(?!)';
}
function literalSource(c, ci) {
  let out = '';
  for (const b of Buffer.from(c, 'utf8')) {
    const lower = b | 0x20;
    out += ci && lower >= 0x61 && lower <= 0x7a ? `[${String.fromCharCode(lower - 32)}${String.fromCharCode(lower)}]` : hex2(b);
  }
  return out;
}
const ANY_BYTE = '[\\s\\S]';
function tokensSource(tokens, o) {
  let re = '';
  for (const tok of tokens) {
    if (tok.t === 'lit') re += literalSource(tok.c, o.ci);
    else if (tok.t === 'any') re += o.literalSeparator ? '[^/]' : ANY_BYTE;
    else if (tok.t === 'zom') re += o.literalSeparator ? '[^/]*' : `${ANY_BYTE}*`;
    else if (tok.t === 'rprefix') re += `(?:/?|${ANY_BYTE}*/)`;
    else if (tok.t === 'rsuffix') re += `/${ANY_BYTE}*`;
    else if (tok.t === 'rzom') re += `(?:/|/${ANY_BYTE}*/)`;
    else if (tok.t === 'class') re += classSource(tok.neg, tok.ranges, o.ci);
    else {
      const parts = tok.alts.map((a) => tokensSource(a, o)).filter((s) => s !== '');
      if (parts.length) re += `(?:${parts.join('|')})`;
    }
  }
  return re;
}
// A glob compiled as globset compiles it (Tokens::to_regex_with): a RegExp over one-char-per-byte paths.
// opts: literalSeparator (`*`/`?` stop at `/`), ci (ASCII case-insensitive). Throws { kind }.
function compileGlob(glob, o = {}) {
  const tokens = parseGlob(glob);
  if (tokens.length === 1 && tokens[0].t === 'rprefix') return new RegExp(`^${ANY_BYTE}*$`);
  return new RegExp(`^${tokensSource(tokens, o)}$`);
}

// ---- gitignore: one matcher's lines (gitignore.rs) -----------------------------------------------------
// Rust's char::is_whitespace (White_Space), for trim_right: JS's trimEnd differs (U+FEFF, U+0085).
const WHITE_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
function trimRight(s) {
  let e = s.length;
  while (e > 0 && WHITE_SPACE.has(s.charCodeAt(e - 1))) e--;
  return s.slice(0, e);
}
const stripDotSlash = (p) => (p.startsWith('./') ? p.slice(2) : p);
class Gitignore {
  // root: the directory its lines are relative to, as a one-char-per-byte string
  constructor(root) { this.root = stripDotSlash(root); this.globs = []; this.ci = false; }
  get empty() { return this.globs.length === 0; }
  // GitignoreBuilder::add_line: null, or the GlobError of a line that does not parse.
  addLine(raw) {
    let line = raw;
    if (line.startsWith('#')) return null;
    if (!line.endsWith('\\ ')) line = trimRight(line);
    if (line === '') return null;
    const original = line;
    let whitelist = false, absolute = false, onlyDir = false;
    if (line.startsWith('\\!') || line.startsWith('\\#')) { line = line.slice(1); absolute = line[0] === '/'; }
    else {
      if (line.startsWith('!')) { whitelist = true; line = line.slice(1); }
      if (line.startsWith('/')) { line = line.slice(1); absolute = true; }
    }
    if (line.endsWith('/')) { onlyDir = true; line = line.slice(0, -1); if (line.endsWith('\\')) line = line.slice(0, -1); }
    let actual = line;
    if (!absolute && !line.includes('/') && !(actual.startsWith('**/') || actual === '**')) actual = `**/${actual}`;
    if (actual.endsWith('/**')) actual = `${actual}/*`;
    let re;
    try { re = compileGlob(actual, { literalSeparator: true, ci: this.ci }); } catch (e) {
      if (e && e.kind) return new GlobError(original, e.kind);
      throw e;
    }
    this.globs.push({ re, whitelist, onlyDir });
    return null;
  }
  get numIgnores() { return this.globs.filter((g) => !g.whitelist).length; }
  // Gitignore::strip, on one-char-per-byte paths
  strip(p) {
    p = stripDotSlash(p);
    if (this.root !== '.' && p.includes('/') && p.startsWith(this.root)) {
      p = p.slice(this.root.length);
      if (p.startsWith('/')) p = p.slice(1);
    }
    return p;
  }
  // 'ignore' | 'whitelist' | null: the last matching line that applies (a dir-only line to a directory)
  matched(p, isDir) {
    if (this.empty) return null;
    const s = this.strip(p);
    for (let k = this.globs.length - 1; k >= 0; k--) {
      const g = this.globs[k];
      if (g.re.test(s) && (!g.onlyDir || isDir)) return g.whitelist ? 'whitelist' : 'ignore';
    }
    return null;
  }
}
const EMPTY_GI = new Gitignore('');

// ---- ignore files on disk -------------------------------------------------------------------------------
// One ignore file's lines into `gi` (GitignoreBuilder::add): BufRead::lines (\n, a \r before it dropped), a
// line that is not UTF-8 ends the reading; returns its errors' texts and whether the only one is an I/O
// error (rg drops those: maybe_push_ignore_io).
function addFile(fs, gi, file, shown) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return { errs: [], io: true }; }
  const errs = [];
  let io = false;
  let start = 0, n = 0;
  const td = new TextDecoder('utf-8', { fatal: true });
  while (start < bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    const next = end === -1 ? bytes.length : end + 1;
    if (end === -1) end = bytes.length;
    let e = end;
    if (end < bytes.length && e > start && bytes[e - 1] === 0x0d) e--;
    n++;
    let line;
    try { line = td.decode(bytes.subarray(start, e)); } catch {
      errs.push(`${shown}: line ${n}: stream did not contain valid UTF-8`); io = true; break;
    }
    const err = gi.addLine(line);
    if (err) errs.push(`${shown}: line ${n}: ${err.message}`);
    start = next;
  }
  return { errs, io: io && errs.length === 1 };
}

// ---- the walk's matcher tree (dir.rs Ignore) --------------------------------------------------------------
// A node per directory: its ignore files, its parent, whether it is one of the searched root's ANCESTORS
// (an "absolute parent"), the canonical root those are matched against, and whether it holds a `.git`.
function makeWalker(spec, ctx) {
  const fs = require('fs'), path = require('path');
  const cwd = ctx.cwd || process.cwd();
  const env = ctx.env || process.env;
  const at = (p) => path.resolve(cwd, p);
  const exists = (p) => { try { fs.statSync(at(p)); return true; } catch { return false; } };
  const no = !!spec.noIgnore;
  const opts = { hidden: !spec.hidden, ignore: !no, parents: !no, gitGlobal: !no, gitIgnore: !no, gitExclude: !no, requireGit: true, custom: !no };
  const anyRules = opts.ignore || opts.gitGlobal || opts.gitIgnore || opts.gitExclude || opts.custom;
  const joinPath = (dir, name) => dir + (dir.endsWith('/') ? '' : '/') + name;

  // RG-TYPE (types.rs): the selections in argv order, `all` every type. Throws rg's error for a name it lacks.
  const typeGlobs = [];
  let hasSelected = false;
  if (spec.types && spec.types.length) {
    const defs = new Map(rgTypes().typeDefs());
    const selections = [];
    for (const [kind, name] of spec.types) {
      const neg = kind === 'typeNot';
      if (name === 'all') { for (const n of defs.keys()) selections.push({ name: n, neg }); } else selections.push({ name, neg });
    }
    for (const sel of selections) {
      const globs = defs.get(sel.name);
      if (!globs) throw new WalkUsage(`unrecognized file type: ${sel.name}`);
      if (!sel.neg) hasSelected = true;
      for (const g of globs) typeGlobs.push({ re: compileGlob(g, { literalSeparator: true }), neg: sel.neg });
    }
  }
  const typesMatched = (p, isDir) => {
    if (isDir || !typeGlobs.length) return null;
    const name = fileName(p);
    if (name === null) return hasSelected ? 'ignore' : null;
    for (let k = typeGlobs.length - 1; k >= 0; k--) if (typeGlobs[k].re.test(name)) return typeGlobs[k].neg ? 'ignore' : 'whitelist';
    return hasSelected ? 'ignore' : null;
  };

  // RG-GLOB-ROOT / RG-GLOB-WHITELIST (overrides.rs): rooted at rg's canonical cwd; --glob then --iglob.
  let canonCwd = cwd;
  try { canonCwd = fs.realpathSync(cwd); } catch { /* as given */ }
  const overrides = new Gitignore(bytesOf(canonCwd));
  for (const kind of ['glob', 'iglob']) {
    overrides.ci = kind === 'iglob';
    for (const [k, g] of spec.globs) {
      if (k !== kind) continue;
      const e = overrides.addLine(g);
      if (e) throw new WalkUsage(e.message);
    }
  }
  const overrideWhitelists = overrides.numIgnores;
  const overridesMatched = (p, isDir) => {
    if (overrides.empty) return null;
    const m = overrides.matched(p, isDir);
    if (m) return m === 'ignore' ? 'whitelist' : 'ignore';
    return overrideWhitelists > 0 && !isDir ? 'ignore' : null;
  };

  // RG-IGNORE-GLOBAL (gitignore.rs gitconfig_excludes_path), read once.
  const global = new Gitignore('');
  if (opts.gitGlobal) {
    const file = globalExcludesPath(fs, path, env);
    if (file) { try { if (fs.statSync(file).isFile()) addFile(fs, global, file, file); } catch { /* none */ } }
  }

  // dir.rs add_child_path: one directory's matchers. `gitType`: what `.git` in it is, following links.
  function childNode(parent, dir, { absParent = false } = {}) {
    let gitType = null;
    if (opts.requireGit && (opts.gitIgnore || opts.gitExclude)) {
      try { const st = fs.statSync(at(joinPath(dir, '.git'))); gitType = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'; } catch { /* none */ }
    }
    const errs = [];
    const fileGi = (dirForFile, name) => {
      const gi = new Gitignore(bytesOf(dir));
      const file = joinPath(dirForFile, name);
      if (exists(file)) { const r = addFile(fs, gi, at(file), file); if (!r.io) errs.push(...r.errs); }
      return gi;
    };
    const node = {
      dir, dirB: bytesOf(dir), parent, absParent, absoluteBase: parent ? parent.absoluteBase : null,
      custom: opts.custom ? fileGi(dir, '.rgignore') : EMPTY_GI,
      ignore: opts.ignore ? fileGi(dir, '.ignore') : EMPTY_GI,
      gi: opts.gitIgnore ? fileGi(dir, '.gitignore') : EMPTY_GI,
      ex: EMPTY_GI,
      hasGit: gitType !== null,
      errs,
    };
    if (opts.gitExclude) {
      const gd = gitCommonDir(fs, at, joinPath, dir, gitType);
      if (gd.dir) node.ex = fileGi(gd.dir, 'info/exclude');
      else if (gd.error) errs.push(gd.error);
    }
    return node;
  }
  const ROOT = { dir: '', dirB: '', parent: null, absParent: true, absoluteBase: null, custom: EMPTY_GI, ignore: EMPTY_GI, gi: EMPTY_GI, ex: EMPTY_GI, hasGit: false, errs: [] };
  // dir.rs add_parents: the root's ancestors, each an absolute parent, from `/` down. Errors: rc 2.
  function withParents(P) {
    if (!opts.parents && !opts.gitIgnore && !opts.gitExclude && !opts.gitGlobal) return { node: ROOT, errs: [] };
    let canon;
    try { canon = fs.realpathSync(at(P)); } catch { return { node: ROOT, errs: [] }; }
    const chain = [];
    for (let d = canon; path.dirname(d) !== d;) { d = path.dirname(d); chain.push(d); }
    let node = ROOT;
    const errs = [];
    for (const parent of chain.reverse()) {
      const n = childNode(node, parent, { absParent: true });
      n.absoluteBase = canon;
      n.hasGit = opts.requireGit && opts.gitIgnore ? exists(path.join(parent, '.git')) : false;
      errs.push(...n.errs);
      node = n;
    }
    return { node, errs };
  }
  const chainOf = function* (node) { for (let n = node; n; n = n.parent) yield n; };
  // dir.rs matched_ignore, on one-char-per-byte paths
  function matchedIgnore(node, p, isDir) {
    let mC = null, mI = null, mG = null, mX = null;
    let anyGit = !opts.requireGit;
    for (const n of chainOf(node)) if (n.hasGit) { anyGit = true; break; }
    let sawGit = false;
    const visit = (n, q) => {
      if (!mC) mC = n.custom.matched(q, isDir);
      if (!mI) mI = n.ignore.matched(q, isDir);
      if (anyGit && !sawGit && !mG) mG = n.gi.matched(q, isDir);
      if (anyGit && !sawGit && !mX) mX = n.ex.matched(q, isDir);
      sawGit = sawGit || n.hasGit;
    };
    let n = node;
    for (; n && !n.absParent; n = n.parent) visit(n, p);
    if (opts.parents && node.absoluteBase) {
      // RG-IGNORE-PARENTS: rg's rebuild, a byte-prefix strip of the entry's own directory
      const prefix = stripDotSlash(node.dirB);
      let rel = p.startsWith(prefix) ? p.slice(prefix.length) : null;
      let q;
      if (rel === null) q = joinAbs(bytesOf(node.absoluteBase), p);
      else { if (rel.startsWith('/')) rel = rel.slice(1); q = joinAbs(bytesOf(node.absoluteBase), rel); }
      for (; n; n = n.parent) visit(n, q);
    }
    const mGlobal = anyGit ? global.matched(p, isDir) : null;
    return mC || mI || mG || mX || mGlobal;
  }
  // dir.rs Ignore::matched + matched_dir_entry (RG-HIDDEN), on the entry's path as walked.
  function skip(node, entryPath, isDir) {
    const p = stripDotSlash(bytesOf(entryPath));
    let m = overridesMatched(p, isDir);
    if (!m) {
      let whitelisted = null;
      const ig = anyRules ? matchedIgnore(node, p, isDir) : null;
      if (ig === 'ignore') return true;
      if (ig === 'whitelist') whitelisted = ig;
      const ty = typesMatched(p, isDir);
      if (ty === 'ignore') return true;
      if (ty === 'whitelist') whitelisted = ty;
      m = whitelisted;
    }
    if (m === 'ignore') return true;
    if (m === null && opts.hidden) { const name = fileName(p); if (name !== null && name.startsWith('.')) return true; }
    return false;
  }

  // A directory's entries, in the OS's readdir order: [{ name, type: 'dir' | 'file' | 'symlink' | 'other' }].
  function readDir(dir) {
    const d = fs.opendirSync(at(dir));
    const out = [];
    try {
      for (let e; (e = d.readSync()) !== null;) {
        let type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : null;
        if (type === null) {
          try { const st = fs.lstatSync(at(joinPath(dir, e.name))); type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'; } catch { type = 'other'; }
        }
        // RG-REFUSE-NAME-NOT-UTF8: a name the engine decoded with U+FFFD it cannot open again by that name
        if (e.name.includes(REPLACEMENT) && !lexists(fs, at(joinPath(dir, e.name)))) {
          throw new WalkRefusal(`${joinPath(dir, e.name)} is a name that is not UTF-8, which quaude's rg cannot carry through its engine `
            + '(RG-REFUSE-NAME-NOT-UTF8)');
        }
        out.push({ name: e.name, type });
      }
    } finally { try { d.closeSync(); } catch { /* closed */ } }
    return out;
  }

  // The walk of one directory root P: yields { file } (a file to search, its path as rg spells it),
  // { message } (stderr, rc unchanged), { error } (stderr, rc 2), and `tick` every so often.
  function* walk(P, { sequential = false, errText = String, tick = null } = {}) {
    const { node: top, errs: perrs } = withParents(P);
    if (perrs.length) yield { error: `rg: ${perrs.join('\n')}` };
    let n = 0;
    // The parallel walk reads a directory before its ignore files (walk.rs Work::read_dir), the
    // single-threaded one after (walkdir yields the directory, then fails to read it).
    const visitDir = function* (parent, dir) {
      let node = sequential ? childNode(parent, dir) : null;
      if (node && node.errs.length) yield { message: `rg: ${node.errs.join('\n')}` };
      let list;
      try { list = readDir(dir); } catch (e) {
        if (e instanceof WalkRefusal) throw e;
        yield { error: `rg: ${dir}: ${sequential ? `IO error for operation on ${dir}: ` : ''}${errText(e)}` };
        return;
      }
      if (!node) {
        node = childNode(parent, dir);
        if (node.errs.length) yield { message: `rg: ${node.errs.join('\n')}` };
      }
      const kept = [];
      for (const c of list) {
        const p = joinPath(dir, c.name);
        if (tick && ++n % 256 === 0) yield tick;
        if (skip(node, p, c.type === 'dir')) continue;
        if (sequential) {
          if (c.type === 'dir') yield* visitDir(node, p);
          else if (c.type === 'file') yield { file: p };
        } else kept.push({ p, type: c.type });
      }
      for (let k = kept.length - 1; k >= 0; k--) {
        if (kept[k].type === 'dir') yield* visitDir(node, kept[k].p);
        else if (kept[k].type === 'file') yield { file: kept[k].p };
      }
    };
    yield* visitDir(top, P);
  }
  return { walk };
}

// rg's usage error before any search (an unknown type, a glob that does not parse): `rg: MESSAGE`, rc 2.
class WalkUsage extends Error { constructor(m) { super(m); this.name = 'WalkUsage'; } }
// What quaude's rg cannot walk as native does: a refusal naming the rule.
class WalkRefusal extends Error { constructor(m) { super(m); this.name = 'WalkRefusal'; } }

// U+FFFD, what a decoder writes for bytes that are not UTF-8 (built from its code point: never a literal).
const REPLACEMENT = String.fromCharCode(0xfffd);
function lexists(fs, p) { try { fs.lstatSync(p); return true; } catch { return false; } }
// pathutil.rs file_name: the last component, none for an empty path or one ending in `.` or `..`.
function fileName(p) {
  if (p === '' || p === '.' || p.endsWith('.') || p.endsWith('..')) return null;
  return p.slice(p.lastIndexOf('/') + 1);
}
// PathBuf::join on one-char-per-byte strings: an absolute `rel` replaces the base.
const joinAbs = (base, rel) => (rel.startsWith('/') ? rel : base + (base.endsWith('/') ? '' : '/') + rel);

// dir.rs resolve_git_commondir: where `.git/info/exclude` is read from. { dir } | { error } | {}.
function gitCommonDir(fs, at, joinPath, dir, gitType) {
  const gitDir = joinPath(dir, '.git');
  if (gitType !== 'file') return { dir: gitDir };
  const firstLine = (p) => { const s = fs.readFileSync(at(p), 'utf8'); const i = s.indexOf('\n'); return i === -1 ? s : s.slice(0, i).replace(/\r$/, ''); };
  let line;
  try { line = firstLine(gitDir); } catch (e) { return { error: `${gitDir}: ${e.message}` }; }
  if (!line.startsWith('gitdir: ')) return {};
  const real = line.slice('gitdir: '.length);
  let common;
  try { common = firstLine(joinPath(real, 'commondir')); } catch { return {}; }
  return { dir: common.startsWith('.') ? joinPath(real, common) : common };
}

// gitignore.rs gitconfig_excludes_path, over the child's environment.
function globalExcludesPath(fs, path, env) {
  const home = env.HOME ? env.HOME : require('os').homedir();
  const xdg = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : home ? path.join(home, '.config') : null;
  const read = (p) => { try { return fs.readFileSync(p).toString('latin1'); } catch { return null; } };
  const parse = (data) => {
    if (data === null) return null;
    const WS = '[\\t\\n\\x0b\\f\\r ]';
    const m = new RegExp(`(?:^|\\n)${WS}*excludesfile${WS}*=${WS}*"?${WS}*([^\\t\\n\\x0b\\f\\r ]+?)${WS}*"?${WS}*(?=\\n|$)`, 'i').exec(data);
    if (!m) return null;
    let s;
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(m[1], 'latin1')); } catch { return null; }
    return home ? s.split('~').join(home) : s;
  };
  return (home && parse(read(path.join(home, '.gitconfig')))) || (xdg && parse(read(path.join(xdg, 'git', 'config'))))
    || (xdg ? path.join(xdg, 'git', 'ignore') : null);
}

module.exports = { makeWalker, compileGlob, parseGlob, Gitignore, WalkUsage, WalkRefusal, GlobError, bytesOf };
