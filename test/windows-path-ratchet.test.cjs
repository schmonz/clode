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
//
// MIGRATED 2026-09-04 (phase 5, task 9), because `stripComments()` was a regex
// (`/\*[\s\S]*?\*\//g` for block comments) applied to the WHOLE FILE with no idea
// that a `/*` or `*/` can appear as literal TEXT inside a string, template literal,
// or regex literal. build-tjs.mjs, clode-fuse.cjs and others inject C/JS source
// through template literals that contain those characters for real (they are
// comments in the INJECTED language, not in the JS that holds them), and the
// non-greedy regex paired an opening `/*` inside one literal with the next `*/`
// it could find ANYWHERE later in the file — including inside a completely
// unrelated later literal — blanking every real line of code in between. Found by
// ACCIDENT (BACKLOG.md, 2026-08-29) when reordering two `const` declarations in
// build-tjs.mjs shifted that pairing and unmasked two pre-existing
// `process.env.PATH` sites this file had never seen.
//
// MEASURED before touching anything (see task-9-report.md for the exact
// commands): the old regex-based `stripComments()` blanked 24,937 lines across
// 421 scanned files — the overwhelming majority of that is CORRECT (real
// comments). Comparing every one of those files against a real tokenizer (the
// replacement below) isolates the part that is a BUG rather than intended
// behaviour: 1,950 lines across 45 files were blanked by the old regex that a
// correct tokenizer shows are real code, not comment — the actual, measured size
// of "roughly 1,335 lines across 14 files" once someone counted it rather than
// estimated it. Re-scanning every RULE against that newly-visible text surfaced
// exactly ONE previously-invisible rule match (test/run.mjs, `npm-global-layout`
// — see ALLOWED below for the disposition); the rest of the newly-visible text
// simply never matched any RULES pattern.
//
// FIXED by replacing the regex with a real tokenizer (`stripComments` below) that
// tracks string/template-literal/regex-literal state exactly the way a JS lexer
// must, so `/*`/`//` inside any of those is never mistaken for a real comment —
// while STILL emitting string/template/regex bodies unchanged (not blanked),
// because that is exactly where the sites this file hunts for were hiding. The
// same regex-vs-division heuristic (`REGEX_OK_AFTER_WORD`) already lives, reviewed
// and shipped, in libexec/scc-merge.cjs's `lexicalCodeMask` — this file has its
// own copy rather than importing that one because scc-merge's mask conflates
// "string" and "comment" into a single "leave verbatim" bit (right for renaming,
// wrong here, where a comment must be blanked but a string must not).
//
// Also migrated to test/guard.cjs's defineGuard/guardTests (Task 1), with `floor`
// set to the measured lines-EXAMINED count (real, non-comment lines the scan
// actually inspected) — NOT total scanned lines, on purpose: a total-lines floor
// would not move even if the mis-pairing regression above came back, because that
// bug does not change how many lines exist, only how many of them the scanner can
// see. A floor on the SURVIVING (non-blanked) lines is the one that goes BROKEN
// the day a future "simplification" reintroduces the old regex.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

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
//
// A real tokenizer, not a regex: it tracks whether it is inside a STRING, a
// TEMPLATE LITERAL (including nested `${ ... }` interpolation, which can itself
// hold strings/templates/regexes), or a REGEX LITERAL, and ONLY treats `/*` or
// `//` as a real comment when none of those is open. Everything that is not a
// comment — code, and string/template/regex BODIES — passes through completely
// unchanged (never blanked): a template literal injecting C or JS source is
// exactly where the sites this file hunts for were hiding (build-tjs.mjs,
// clode-fuse.cjs), so their content must stay visible to the RULES below, not
// be swallowed as if it were a comment.
//
// Regex-vs-division is undecidable in general without a real parser; this uses
// the same "previous significant token" heuristic already reviewed and shipped
// in libexec/scc-merge.cjs's `lexicalCodeMask` (`REGEX_OK_AFTER_WORD`) — a
// separate copy, not an import, because that mask conflates "string" and
// "comment" into one "leave verbatim" bit, which is right for renaming and wrong
// here (a comment must be blanked, a string must not).
const REGEX_OK_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

// Scans a candidate regex-literal BODY starting right after an opening `/` at `start`
// (i.e. src[start - 1] === '/'). Handles backslash escapes and `[...]` char classes the
// same way a real regex literal would; a regex literal can never contain a literal
// newline, so the scan always stops there. Returns `{ end, closed }` — `end` is the
// index right after the last character examined (either just past a found closing `/`
// plus trailing flags, or at the newline/EOF if none was found); `closed` says which.
// PURE. Shared by stripComments() (real recognition, when `!prevIsValue` says to try it
// for real) and by findAmbiguousRegexDivisionSites() below (speculative: "what WOULD
// this scan find here, even at a position the heuristic decided not to try") — one
// implementation, so the two can never quietly drift apart.
function scanRegexBody(src, start) {
  const n = src.length;
  let j = start;
  let inClass = false;
  let closed = false;
  while (j < n) {
    const cj = src[j];
    if (cj === '\\') { j += 2; continue; }
    if (cj === '\n') break;
    if (cj === '[') { inClass = true; j++; continue; }
    if (cj === ']') { inClass = false; j++; continue; }
    if (cj === '/' && !inClass) { j++; closed = true; break; }
    j++;
  }
  if (closed) {
    while (j < n && /[a-z]/i.test(src[j])) j++; // trailing flags
  }
  return { end: j, closed };
}

// `opts.onAmbiguousSlash(info)`, when supplied, fires once for every bare `/` the
// `prevIsValue` heuristic reads as division (skipping the real regex-literal scan)
// whose SPECULATIVE regex body — what scanRegexBody() would have found had it been
// tried here — contains a raw `/*`. That is FIX ROUND 1's residual, made continuously
// enforceable instead of a one-time manual check: it is exactly the shape that runs
// away, because the real tokenizer below, having decided this `/` is division, goes on
// to read that embedded `/*` as an ordinary (unconditional) comment opener — and if a
// REAL, unrelated `*/` exists later in the file (not just at EOF, which the branch below
// already guards), it silently deletes everything in between. Purely an observer: it
// never changes what stripComments() outputs, so callers that don't pass it see
// identical behaviour to before this hook existed.
function stripComments(src, opts) {
  const onAmbiguousSlash = opts && opts.onAmbiguousSlash;
  let out = '';
  let i = 0;
  const n = src.length;
  // Stack of frames: 'template' (raw template text) or 'code' (the root, or an
  // interpolation opened by a template's `${`). An `interp` frame tracks its own
  // unmatched '{' depth so the `}` that closes it is told apart from a nested
  // block or object literal inside the expression.
  const stack = [{ kind: 'code', interp: false, depth: 0 }];
  let prevIsValue = false; // true => a bare `/` here is division, not a regex start

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const frame = top();
    const c = src[i];

    if (frame.kind === 'template') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; stack.pop(); prevIsValue = true; continue; }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'; i += 2;
        stack.push({ kind: 'code', interp: true, depth: 0 });
        prevIsValue = false;
        continue;
      }
      out += c; i++;
      continue;
    }

    // frame.kind === 'code'
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      if (j + 1 < n) {
        // A real closing "*/" was found: commit to the comment.
        const end = j + 2;
        out += src.slice(i, end).replace(/[^\n]/g, '');
        i = end;
        prevIsValue = false;
        continue;
      }
      // FIX ROUND 1 (2026-09-04, coordinator finding): no closing "*/" anywhere before
      // EOF. Every file this guard scans is syntactically valid JS, and valid JS never
      // contains a real, unterminated block comment — so reaching EOF unclosed is proof
      // this "/*" was NOT a real comment opener. It was inside a regex literal the
      // `!prevIsValue` heuristic below failed to recognize (the same "inherent ambiguity
      // after ), ], or an identifier" scc-merge.cjs's own regexAllowed() comment already
      // names): e.g. `fn() /[/*]/.test(x)` — `)` sets prevIsValue, so the regex-literal
      // scan below is never attempted, and the SECOND `/` of the char class `[/*]` reads
      // as an ordinary `/*` right here, which (before this fix) then ran away to the next
      // `*/` anywhere in the file — or to EOF, silently deleting every real line after it,
      // including a genuine `process.env.PATH` site (see the regression test below).
      // Back off: treat this ONE character as ordinary punctuation and let the normal
      // dispatch re-examine everything from here, one character at a time, rather than
      // committing to a "comment" this file's own validity already disproves.
      //
      // NOT A FULL FIX for the family: if a REAL, unrelated block comment happens to sit
      // later in the SAME file, this same misjudged `/*` still runs away and pairs with
      // THAT comment's `*/` instead of reaching EOF, and this fallback cannot tell the
      // difference (a real closing marker exists, just the wrong one). Solving that
      // requires resolving the regex-vs-division ambiguity itself, which needs a real
      // parser; both are the same as the pre-existing "/`*` might be regex-code, might be
      // division" limitation the comment on the regex branch below already documents.
      // FIX ROUND 2 (2026-09-04, coordinator finding): a one-time manual measurement that
      // this residual does not occur today is not enough — the next file to acquire the
      // shape would be swallowed silently, with no record this analysis ever happened.
      // findAmbiguousRegexDivisionSites() below (wired into the
      // `windows-path-ratchet-regex-division-ambiguity` guard) makes the SAME check the
      // one below performs (via onAmbiguousSlash — see that hook) run on every scan, not
      // once by hand.
      prevIsValue = false;
      out += c; i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      i = j; // stop before the newline; it is emitted on the next iteration
      prevIsValue = false;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '\n') break; // an unescaped newline can't appear in '/" strings
        else j++;
      }
      const end = Math.min(j + 1, n);
      out += src.slice(i, end);
      i = end;
      prevIsValue = true;
      continue;
    }
    if (c === '`') {
      out += c; i++;
      stack.push({ kind: 'template' });
      continue;
    }
    if (c === '/' && !prevIsValue) {
      // Candidate regex literal. A `[...]` char class suspends the closing-slash
      // test, same as a real JS lexer; no closing slash on this line means it was
      // not a regex after all (division by something on the next line is not
      // valid JS either way, so this cannot misfire on real code).
      const { end, closed } = scanRegexBody(src, i + 1);
      if (closed) {
        out += src.slice(i, end);
        i = end;
        prevIsValue = true;
        continue;
      }
      prevIsValue = false;
      out += c; i++;
      continue;
    }
    // FIX ROUND 2 (2026-09-04, coordinator finding): `c === '/' && prevIsValue` falls
    // through to the default punctuation branch below UNCHANGED — this block only
    // REPORTS, via onAmbiguousSlash(), when doing so is dangerous. See the function
    // header for what this detects and why.
    if (c === '/' && prevIsValue && onAmbiguousSlash) {
      const { end } = scanRegexBody(src, i + 1);
      const body = src.slice(i + 1, end);
      if (body.includes('/*')) {
        onAmbiguousSlash({
          line: src.slice(0, i).split('\n').length,
          snippet: src.slice(i, Math.min(end, i + 60)),
        });
      }
    }
    if (frame.interp) {
      if (c === '{') { frame.depth++; out += c; i++; prevIsValue = false; continue; }
      if (c === '}') {
        if (frame.depth > 0) { frame.depth--; out += c; i++; prevIsValue = false; continue; }
        out += c; i++; stack.pop(); prevIsValue = false; continue; // closes the `${ ... }`
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      out += word;
      i = j;
      prevIsValue = !REGEX_OK_AFTER_WORD.has(word);
      continue;
    }
    if (c === ')' || c === ']') { prevIsValue = true; out += c; i++; continue; }
    if (/\s/.test(c)) { out += c; i++; continue; } // whitespace never changes context
    prevIsValue = false;
    out += c; i++;
  }
  return out;
}

// PURE. Runs stripComments() purely for its onAmbiguousSlash side channel and returns
// every site it reported: a `/` the heuristic reads as division whose candidate regex
// body contains a raw `/*` — the exact shape FIX ROUND 1's EOF-only guard cannot fully
// close (if a REAL, unrelated `*/` exists later in the same file, the runaway pairs with
// THAT instead of reaching EOF). This converts "verified absent across the corpus on one
// occasion" into something a future run checks again on every file, every time.
function findAmbiguousRegexDivisionSites(src) {
  const findings = [];
  stripComments(src, { onAmbiguousSlash: (info) => findings.push(info) });
  return findings;
}

// EXACT counts, same shape as ALLOWED above, both directions. Empty today (see
// task-9-report.md, Fix Round 2: measured zero occurrences across all 421 files this
// guard scans) — a genuine future false positive (a real, deliberately-written regex
// whose char class or escape happens to contain `/*`, at a position the heuristic reads
// as division) costs one entry here with the reason it is safe, same as the main table.
const AMBIGUITY_ALLOWED = {};

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
const ALL_ROOTS = [...new Set(Object.values(RULES).flatMap((r) => r.roots || DEFAULT_ROOTS))];

// read() — the only I/O in this guard: walk every root any RULE cares about and read
// every file once. Returns raw {rel, src} pairs; scan() below is pure.
function readFiles(repo = REPO, roots = ALL_ROOTS) {
  const files = [];
  for (const root of roots) {
    const dir = path.join(repo, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = path.relative(repo, file).split(path.sep).join('/');
      // This file quotes the very patterns it hunts for, in its rule text.
      if (rel === 'test/' + path.basename(__filename)) continue;
      files.push({ rel, src: fs.readFileSync(file, 'utf8') });
    }
  }
  return files;
}

// PURE. Collects raw hits (rule -> file -> line numbers) AND `examined`, the count of
// non-blank lines left after stripping (real code, never comment) across every scanned
// file. `examined` is the number that DROPS if the stripper regresses to its old
// runaway-pairing behaviour (that bug does not change how many lines exist, only how
// many a scanner can still see), which is exactly what defineGuard's floor needs to catch.
function collectHits(files, rules = RULES, defaultRoots = DEFAULT_ROOTS) {
  const hits = {};
  let examined = 0;
  for (const { rel, src } of files) {
    const root = rel.split('/')[0];
    stripComments(src).split('\n').forEach((line, i) => {
      if (line.trim() !== '') examined++;
      for (const [rule, spec] of Object.entries(rules)) {
        if (!(spec.roots || defaultRoots).includes(root)) continue;
        if (!spec.re.test(line)) continue;
        if (spec.skip && spec.skip.test(line)) continue;
        const byFile = hits[rule] || (hits[rule] = {});
        (byFile[rel] || (byFile[rel] = [])).push(i + 1);
      }
    });
  }
  return { hits, examined };
}

// PURE. The shape defineGuard's `scan` requires: {findings, examined}. Both directions of
// the ratchet — a NEW instance of a rule beyond what ALLOWED permits, and a stale ALLOWED
// entry whose count no longer matches reality — are findings here, same as the file's
// original two separate tests.
function scanFiles({ files, rules = RULES, allowed = ALLOWED, defaultRoots = DEFAULT_ROOTS }) {
  const { hits, examined } = collectHits(files, rules, defaultRoots);

  const findings = [];
  for (const [rule, byFile] of Object.entries(hits)) {
    for (const [file, lines] of Object.entries(byFile)) {
      const allow = (allowed[rule] || {})[file] || 0;
      if (lines.length > allow) {
        findings.push(`${rule}: ${file} has ${lines.length} (allowed ${allow}) at lines `
          + `${lines.join(', ')}\n    ${rules[rule].why}`);
      }
    }
  }
  for (const [rule, byFile] of Object.entries(allowed)) {
    for (const [file, allow] of Object.entries(byFile)) {
      const actual = ((hits[rule] || {})[file] || []).length;
      if (actual < allow) {
        findings.push(`${rule}: ${file} allows ${allow} but only ${actual} remain — good `
          + `news, this was fixed; lower ALLOWED so the ratchet holds the gain.`);
      }
    }
  }
  return { findings, examined };
}

// Back-compat shape for anything still calling scan() directly for raw hits (none does,
// as of this migration, but the shape is cheap to keep and matches what the file's own
// header/comments already describe).
function scan(repo = REPO, roots = null) {
  return collectHits(readFiles(repo, roots || ALL_ROOTS)).hits;
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
    // provisionCosmocc PREPENDS cosmocc's bin dir to PATH so cmake's child
    // processes can exec cosmoar/cosmoranlib's per-arch backends by bare name.
    // It resolves nothing itself — no walk, no executable lookup — so PATHEXT
    // does not enter into it, and the cosmo leg is Linux-only besides.
    //
    // NOT A NEW SITE: it has been there since the cosmo leg landed. It became
    // VISIBLE to this scan on 2026-08-29, when reordering declarations in
    // build-tjs.mjs happened to change how the old REGEX stripComments() paired
    // `/*` with `*/` across the C that file injects in template literals. That
    // blindness (measured 2026-09-04: 1,950 lines of real code across 45 scanned
    // files — see the MIGRATED header note at the top of this file) is FIXED as
    // of this entry's own commit: stripComments() is now a tokenizer that tracks
    // string/template/regex state. This entry is the honest count for the two
    // lines this rule allows here, not a residue of the old blindness.
    'scripts/build-tjs.mjs': 2,
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
    // NEWLY VISIBLE 2026-09-04 (phase 5, task 9), once the tokenizer replaced the
    // regex stripper — the ONLY real rule match the fix surfaced anywhere in the
    // repo. test/run.mjs's own npmCliPath() is the fourth instance of the same
    // correctly-branched pair: line 237 tries the Windows dist layout
    // (`node_modules`) first, this POSIX line 239 (`'lib', 'node_modules'`) is the
    // fallback. Reviewed; not a bug, same disposition as the three siblings above.
    'test/run.mjs': 1,
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

// Step 2's failing-first fixture (phase 5, task 9): a template literal containing an
// unbalanced `/*` opener, followed by a REAL rule site, followed by a second template
// literal whose text happens to contain a `*/`. Under the old regex stripComments(),
// the non-greedy `/\*[\s\S]*?\*\//` paired the opener inside the FIRST template with the
// first `*/` it could find anywhere later in the file — which is inside the SECOND
// template — and blanked everything in between, including the real
// `process.env.PATH` line. It found nothing. The tokenizer treats each template
// literal's body as opaque text (never a comment boundary), so the site survives.
test('a process.env.PATH site after a template literal containing `/*` is FOUND', () => {
  const fixture = [
    "const a = `template has /* opening marker only`;",
    "process.env.PATH = 'should be visible';",
    "const b = `closing marker only */ here`;",
    '',
  ].join('\n');
  const stripped = stripComments(fixture);
  const found = stripped.split('\n').some((l) => RULES['path-walk'].re.test(l));
  assert.ok(found, `expected the process.env.PATH site to survive stripping; got:\n${stripped}`);
});

// FIX ROUND 1 regression (2026-09-04, coordinator finding): the regex-literal char class
// `[/*]` (matches either '/' or '*') after `fn()` — an ambiguous position the
// `!prevIsValue` heuristic reads as division, since `)` always sets it — put the second
// `/` of that class immediately before a `*`, which the (pre-fix) `/*` branch read as a
// real comment opener with no closing "*/" anywhere in this fixture, so it ran away to
// EOF and deleted the real `process.env.PATH` line after it. Verified BEFORE the EOF
// fallback above: this exact fixture returned `found === false`.
test('a process.env.PATH site after fn() /[/*]/ (a misjudged regex literal) is FOUND', () => {
  const fixture = [
    'fn() /[/*]/.test(x);',
    "process.env.PATH = 'real site';",
    '',
  ].join('\n');
  const stripped = stripComments(fixture);
  const found = stripped.split('\n').some((l) => RULES['path-walk'].re.test(l));
  assert.ok(found, `expected the process.env.PATH site to survive stripping; got:\n${stripped}`);
});

// FIX ROUND 1 regression, escaped-slash variant: `\/*` (an escaped literal slash followed
// by the `*` quantifier — "zero or more literal slashes") is the same shape without a
// character class, so this is a distinct code path through the regex-literal scan, not a
// duplicate of the test above.
test('a process.env.PATH site after a() /\\/*/ (escaped-slash regex) is FOUND', () => {
  const fixture = [
    'const re = a() /\\/*/;',
    "process.env.PATH = 'real site';",
    '',
  ].join('\n');
  const stripped = stripComments(fixture);
  const found = stripped.split('\n').some((l) => RULES['path-walk'].re.test(l));
  assert.ok(found, `expected the process.env.PATH site to survive stripping; got:\n${stripped}`);
});

// A GENUINE block comment must still be stripped — the other half of the ratchet this
// fix round must not trade away. Deliberately contains text that WOULD match a RULE if
// left visible, so a regression here would show up as a wrong verdict, not just a
// leftover comment.
test('a genuine /* process.env.PATH */ comment is still stripped', () => {
  const fixture = [
    '/* documentation mentions process.env.PATH here, in a real comment */',
    'const x = 1;',
    '',
  ].join('\n');
  const stripped = stripComments(fixture);
  const found = stripped.split('\n').some((l) => RULES['path-walk'].re.test(l));
  assert.ok(!found, `expected the comment to be stripped, not matched; got:\n${stripped}`);
});

// Migrated to test/guard.cjs's defineGuard/guardTests (Task 1) — see the MIGRATED header
// note at the top of this file for the measurement that drove the floor below.
const guard = defineGuard({
  name: 'windows-path-ratchet',
  // Measured 2026-09-04 (readFiles() + scanFiles() run directly, see task-9-report.md for
  // the exact command) against the real tree with the FIXED tokenizer: 50,892 non-blank
  // (real code) lines examined across 421 scanned files. If the stripper regressed to the
  // old regex's runaway `/*`...`*/` pairing, this same tree would examine roughly 1,950
  // fewer lines (the measured size of the blindness this task fixed — see the MIGRATED
  // header note) — about 48,946. The floor sits between the two: below today's real
  // count (leaving room for ordinary file churn) but above what a regression would leave
  // visible, so that regression reports BROKEN instead of quietly passing.
  floor: 50000,
  read: () => {
    const files = readFiles();
    if (files.length === 0) {
      return { skip: 'no files found under any scanned root (libexec/scripts/test) — '
        + 'repo layout changed; nothing to scan' };
    }
    return { files };
  },
  scan: scanFiles,
  // A synthetic corpus containing a rule violation this guard MUST report: a bare
  // process.env.PATH site in a file with no ALLOWED entry. Deliberately unrelated to the
  // real ALLOWED table (which describes THIS repo's reviewed sites, not a fixture), so
  // this control's pass/fail never depends on what the real tree currently allows.
  control: () => ({
    files: [{ rel: 'synthetic/control.cjs', src: "if (process.env.PATH) { doStuff(); }\n" }],
  }),
});
guardTests(guard);

// PURE. FIX ROUND 2's detector (coordinator finding): scans every file for the ambiguous
// `/` shape findAmbiguousRegexDivisionSites() defines, filters out reviewed
// AMBIGUITY_ALLOWED sites (both directions — a stale allowance is reported too, same as
// the main ALLOWED table), and returns {findings, examined}.
function scanAmbiguousSites({ files, allowed = AMBIGUITY_ALLOWED }) {
  const findings = [];
  const seenAllowed = new Set();
  let examined = 0;
  for (const { rel, src } of files) {
    examined += src.split('\n').length;
    const allowedLines = allowed[rel] || [];
    for (const site of findAmbiguousRegexDivisionSites(src)) {
      if (allowedLines.includes(site.line)) { seenAllowed.add(`${rel}:${site.line}`); continue; }
      findings.push(`${rel}:${site.line}: a \`/\` the division heuristic accepts has a `
        + `candidate regex body containing \`/*\` — the shape that can run away into a `
        + `real, unrelated \`*/\` elsewhere in the file (BACKLOG.md, Fix Round 1/2): `
        + `${JSON.stringify(site.snippet)}. Rewrite the regex so this is unambiguous, or `
        + `add ${rel}:${site.line} to AMBIGUITY_ALLOWED with the reason it is safe.`);
    }
  }
  for (const [file, lines] of Object.entries(allowed)) {
    for (const line of lines) {
      if (!seenAllowed.has(`${file}:${line}`)) {
        findings.push(`AMBIGUITY_ALLOWED names ${file}:${line} but it no longer produces `
          + `this shape — good news, lower the entry so the ratchet holds the gain.`);
      }
    }
  }
  return { findings, examined };
}

// Migrated 2026-09-04 (phase 5, task 9, Fix Round 2): converts the coordinator's finding
// — "verified absent across the corpus on one occasion" decays; enforce it continuously
// — into a standing guard. Measured (task-9-report.md): zero occurrences across all 421
// files this guard scans today, examined 79,286 total lines (the SAME 421-file corpus as
// the main guard above, counted differently — every line, not just non-blank ones, since
// this detector's job is "did we look at every file", not "how much comment-stripping
// survived").
const ambiguityGuard = defineGuard({
  name: 'windows-path-ratchet-regex-division-ambiguity',
  floor: 70000,
  read: () => {
    const files = readFiles();
    if (files.length === 0) {
      return { skip: 'no files found under any scanned root (libexec/scripts/test) — '
        + 'repo layout changed; nothing to scan' };
    }
    return { files };
  },
  scan: scanAmbiguousSites,
  // The coordinator's exact repro: `)` closing `fn()` sets prevIsValue, so the regex
  // scan is skipped for the next `/`, and its candidate body `[/*]` contains a raw `/*`.
  control: () => ({
    files: [{ rel: 'synthetic/ambiguous-control.cjs', src: 'fn() /[/*]/.test(x);\n' }],
  }),
});
guardTests(ambiguityGuard);

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

module.exports = { RULES, ALLOWED, scan, scanFiles, readFiles, stripComments,
  scanRegexBody, findAmbiguousRegexDivisionSites, AMBIGUITY_ALLOWED, scanAmbiguousSites };

// The PROOF for the counted `c-file-url-sep` rule above. A count cannot tell whether a
// given file:// construction normalizes separators; this reads the injected C and checks
// the two things that were actually wrong on Windows.
test('injected C that builds a file:// URL handles every absolute form', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'build-tjs.mjs'), 'utf8');
  const at = src.indexOf('"file://"');
  assert.ok(at > 0, 'expected exactly one injected file:// construction to verify');
  // Wide enough to hold the guard above and the body conversion below; the guard grew
  // when drive-letter paths were added and silently fell outside a tighter window.
  const chunk = src.slice(Math.max(0, at - 2000), at + 2000);

  // Built by character rather than written as a nested escape: this text passes through
  // a JS template literal into C, so a literal backslash is FOUR characters here, and
  // hand-counting them in a regex is how the previous version of this test broke.
  const BS = String.fromCharCode(92);
  const FOUR = BS + BS + BS + BS;

  assert.ok(chunk.includes("buf[0] == '/'"), 'must accept a POSIX absolute path');
  assert.ok(chunk.includes("buf[0] == '" + FOUR + "'"),
    'must accept a BACKSLASH: the module name is separator-normalized before this runs');
  // Drive letter: a WINDOWS-built Claude Code names its modules B:/~BUN/root/..., not
  // /$bunfs/root/..., so buf[0] is a letter and neither separator test fires. This
  // shipped TWICE: both Windows legs failed with "not a file URL" while 12 POSIX legs
  // passed, and the first fix only added the backslash.
  assert.ok(chunk.includes("buf[1] == ':'"),
    'must accept a DRIVE-LETTER path — Windows Bun uses B:/~BUN/root/, not /$bunfs/root/');
  assert.ok(chunk.includes("*tjs__p == '" + FOUR + "'"),
    'the URL body must convert backslashes to forward slashes');
});
