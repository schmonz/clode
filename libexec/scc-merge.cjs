'use strict';
// Merge one strongly connected component of the module graph into a SINGLE module, so no
// `import.meta.require(...)`/`require(...)` and no `import`/`export` crosses a module boundary
// inside the group. See docs/superpowers/specs/2026-08-28-cyclic-scc-merge-design.md for why:
// the engine cannot drive module evaluation to completion synchronously from inside a require,
// so any runtime bridge deadlocks or SIGSEGVs (six approaches measured dead — see the plan).
// Merging at COMPILE time sidesteps all of that: the cycle never crosses a module boundary the
// engine has to resolve at evaluation time.
//
// No JS parser is vendored (zero-deps). Renaming uses ONLY names `tjs.engine.moduleMeta` already
// reports (the engine's own parser told us these are real top-level bindings), so the only
// "parsing" this file does is finding the KNOWN specifier strings and KNOWN identifier tokens
// inside minified text — never inferring structure from scratch.
//
// KNOWN LIMITATION, not guarded against: object-literal SHORTHAND properties. `{shared}` means
// `{shared: shared}` — the same token is simultaneously a fixed property KEY (must never rename)
// and a binding reference (must rename when `shared` collides), and nothing distinguishes them
// by token shape alone. Detecting this reliably would mean knowing whether a given `{...}` span
// is an OBJECT EXPRESSION — as opposed to a block statement, a destructuring pattern, or a class
// body — which is not decidable from the token stream without an AST. Cheap pattern-matching
// (name immediately preceded by `{`/`,` and followed by `,`/`}`) was considered and rejected: an
// array element or a call argument (`[a, shared, b]`, `f(a, shared, b)`) has the EXACT same
// shape and is extremely common in real code, so that pattern would refuse constantly on
// ordinary, unrelated text rather than on the case it's meant to catch. If a merge ever produces
// a runtime value that looks like a colliding name landed in the wrong object property — no
// compile error, since renaming a shorthand key is syntactically valid either way — this is the
// first thing to suspect.

// THE MERGER'S OWN VERSION. libexec/quaude-fuse.js caches a merged graph beside the staged
// cli.cjs (merging the real 95-module group costs ~345s under tjs), and stamps this string into
// the cache entry. A cache entry whose recorded version differs is IGNORED and recomputed.
//
// BUMP THIS whenever an edit to this file could change the bytes mergeGroup emits. Forgetting to
// is not a cosmetic slip: every machine that has already built once keeps serving the OLD merge
// from its cache, so the edit appears to do literally nothing, on that machine only, forever.
var MERGER_VERSION = '12';

// `meta.locals` is the union of two engine tables (vardefs + closure_var) and can repeat a name
// across them, and it reports compiler-internal synthetic names in angle brackets (e.g.
// `<class_fields_init>`) that are not real user bindings and can never collide with one.
//
// "as"/"from" are deliberately NOT excluded here, even though both are also the JS keyword in
// import/export clause syntax our own code preserves everywhere — an earlier version of this
// file did exclude them (blanket-protecting the keyword by never renaming EITHER meaning), and
// the real 95-module group broke that too: one member has a genuine top-level `function as(){}`
// that collides with another member's own `as`, and leaving both un-renamed re-declares "as"
// twice in the merged scope (`Identifier 'as' has already been declared`). The keyword is
// instead protected POSITIONALLY, by `protectImportedExportNames` (below) masking exactly the
// syntax positions "as"/"from" can appear in — so a genuine `as`/`from` binding still renames
// correctly everywhere else.
function declaredNames(meta) {
  var out = new Set();
  if (!meta || !Array.isArray(meta.locals)) return out;
  for (var i = 0; i < meta.locals.length; i++) {
    var n = meta.locals[i];
    if (typeof n !== 'string' || n.indexOf('<') !== -1) continue;
    // A PRIVATE class field/method — `#e` in `class C { #e = 1 }` — reports with the `#`
    // included. It is not a module-scope binding at all: two classes' `#e` are unrelated
    // fields even with the identical name, private-per-class by JS semantics, so counting it
    // toward cross-member collisions is wrong on top of being unsafe. It's unsafe on its own
    // terms too — `#` is not an identifier character, so prefixing `#e` the way an ordinary
    // collision is renamed produces `__mK_#e`, a SyntaxError (`Unexpected identifier '#e'`) —
    // measured on the real 95-module group.
    if (n.charAt(0) === '#') continue;
    out.add(n);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// CODE MASK — the reason a real 7-module, 808KB group compiles instead of failing with
// "invalid regular expression flags" or worse (a regex whose BODY silently changed meaning,
// no error at all). Real minified modules reuse the same short names — `h`, `i`, `S`, `a` —
// across every member, so almost every single-letter local collides and gets renamed
// EVERYWHERE that token appears as its own identifier. Without this guard that includes
// inside string/template/regex literals and comments: renaming `i` inside `/foo/gi` turns a
// valid regex flag into `g__m0_i`, a SyntaxError; renaming it inside `/[i]/` or a string
// changes behaviour with no error at all. Measured on the real group: 128 single/short-name
// collisions, several landing inside real regex literals.
//
// This is NOT a JS parser — no AST, no expression semantics, nothing recorded but "is this
// byte inside a string/template/regex/comment". It marks each source byte 1 (ordinary code,
// safe to touch) or 0 (literal/comment content, leave verbatim). Every substitution in this
// file is routed through it.
//
// Regex-vs-division is the one place this needs a heuristic (undecidable in general without
// a real parser): `/` after a value (identifier, `)`, `]`) is division; after most everything
// else, including the handful of keywords that can be followed by a regex operand, it opens a
// regex literal. Only matters for MASKING — a wrong call here can at worst leave a token
// unmasked (protected) when it needn't be, which is always the safe direction.
var REGEX_OK_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'yield', 'case', 'do', 'else', 'await',
]);
function regexAllowed(prevTok) {
  if (!prevTok) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prevTok)) return REGEX_OK_AFTER_WORD.has(prevTok);
  if (/^[0-9]/.test(prevTok)) return false;
  if (prevTok === ')' || prevTok === ']') return false;
  return true;
}

// Character-code tests, not `RegExp.test()` on a one-char string. `codeMask` runs this
// character by character over every byte of every member, potentially several times per
// member as `src` is rewritten in place (import/export/require rewriting, then renaming) —
// measured necessary: the real 95-module group (6.5MB total) took over two minutes with
// per-character `.test()` calls under the tjs interpreter (no JIT) and single-digit seconds
// with charCode comparisons; behaviour is unchanged, this is pure hot-path arithmetic.
function isIdentStartCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36; // A-Z a-z _ $
}
function isIdentCode(c) {
  return isIdentStartCode(c) || (c >= 48 && c <= 57); // + 0-9
}
function isAsciiWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}
function isAsciiLetterCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function lexicalCodeMask(src) {
  var n = src.length;
  var mask = new Uint8Array(n);
  var i = 0;
  // Stack of template-literal states. 'template': scanning literal text (non-code) up to the
  // next `` ` `` or `${`. 'interp': scanning CODE inside a `${ ... }`, tracking its own nested
  // `{`/`}` depth so the interpolation's closing `}` isn't mistaken for an inner one.
  var stack = [];
  var prevTok = '';
  while (i < n) {
    var top = stack.length ? stack[stack.length - 1] : null;
    if (top && top.kind === 'template') {
      var cc = src.charCodeAt(i);
      if (cc === 92) { i += 2; continue; } // backslash
      if (cc === 96) { stack.pop(); i++; continue; } // `
      // Entering `${ ... }` starts a fresh expression — reset `prevTok` rather than leaving it
      // at the `)` set when the backtick itself opened. Without this, EVERY interpolation began
      // with `regexAllowed(')') === false`, so a regex literal that is the interpolation's first
      // token (`` `${/foo/.test(x)}` ``) was read as division, its body scanned as ordinary
      // code, and a colliding name inside it renamed with no compile error at all.
      if (cc === 36 && src.charCodeAt(i + 1) === 123) { stack.push({ kind: 'interp', depth: 0 }); i += 2; prevTok = ''; continue; } // ${
      i++; continue;
    }
    // Code state: top-level, or inside a `${ ... }` interpolation.
    var c = src.charCodeAt(i);
    if (c === 47 && src.charCodeAt(i + 1) === 47) { // //
      while (i < n && src.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 47 && src.charCodeAt(i + 1) === 42) { // /*
      i += 2;
      while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
      i = Math.min(i + 2, n);
      prevTok = ')';
      continue;
    }
    if (c === 34 || c === 39) { // " '
      var q = c; i++;
      while (i < n) {
        var qc = src.charCodeAt(i);
        if (qc === 92) { i += 2; continue; }
        if (qc === q) { i++; break; }
        i++;
      }
      prevTok = ')';
      continue;
    }
    if (c === 96) { stack.push({ kind: 'template' }); i++; prevTok = ')'; continue; } // `
    if (top && top.kind === 'interp' && c === 123) { top.depth++; mask[i] = 1; i++; prevTok = '{'; continue; } // {
    if (top && top.kind === 'interp' && c === 125) { // }
      if (top.depth === 0) { stack.pop(); i++; prevTok = ')'; continue; }
      top.depth--; mask[i] = 1; i++; prevTok = '}'; continue;
    }
    if (c === 47 && regexAllowed(prevTok)) { // /
      var j = i + 1, inClass = false, malformed = false;
      while (j < n) {
        var rc = src.charCodeAt(j);
        if (rc === 92) { j += 2; continue; } // backslash
        if (rc === 10) { malformed = true; break; } // \n
        if (rc === 91) { inClass = true; j++; continue; } // [
        if (rc === 93) { inClass = false; j++; continue; } // ]
        if (rc === 47 && !inClass) { j++; break; } // /
        j++;
      }
      if (!malformed) {
        while (j < n && isAsciiLetterCode(src.charCodeAt(j))) j++;
        i = j; prevTok = ')'; continue;
      }
      // Fell through: not a well-formed regex literal on this line. Treat `/` as division
      // (the safe default — worst case a byte that could have been masked stays protected).
    }
    if (isIdentStartCode(c)) {
      var start = i;
      while (i < n && isIdentCode(src.charCodeAt(i))) { mask[i] = 1; i++; }
      prevTok = src.slice(start, i);
      continue;
    }
    mask[i] = 1;
    if (!isAsciiWsCode(c)) prevTok = src[i];
    i++;
  }
  return mask;
}

function maskSpan(mask, start, len) {
  for (var i = 0; i < len; i++) mask[start + i] = 0;
}

// The complement of `maskSpan`: `propertyNames` builds a POSITIVE map of the bytes it found,
// which `codeMask` then subtracts from the code mask.
function markSpan(map, start, len) {
  for (var i = 0; i < len; i++) map[start + i] = 1;
}

// `\bas\b`/`\bfrom\b` inside `text` (found at absolute offset `absStart` in the real source)
// are ALWAYS the JS keyword when `text` is drawn from import/export clause syntax — the grammar
// has no other place a bare "as"/"from" token can appear there — so masking every occurrence is
// unconditionally safe, never a false protection of a real reference.
function maskKeywordTokens(mask, absStart, text) {
  var re = /\b(?:as|from)\b/g, m;
  while ((m = re.exec(text))) maskSpan(mask, absStart + m.index, m[0].length);
}

// FIXED SYNTAX inside import/export clauses — never a local binding, even though it is
// lexically ordinary code — must never be caught by the identifier-rename pass. Two real
// failures on the 95-module group forced this to cover as much as it does:
//  - a colliding LOCAL name in one member ("Yo") is ALSO, verbatim, the export name some OTHER
//    member imports from an unrelated, non-group chunk (`import{Yo}from"chunk"`) — renaming it
//    silently requested a nonexistent export, no compile error;
//  - a colliding name ("as") is ALSO literally the "as" KEYWORD inside completely unrelated
//    aliased imports (`import{types as UIe}from"util"`) — renaming it broke the syntax outright
//    (`Unexpected identifier '__m7_as'`) — and the opposite fix, excluding "as"/"from" from
//    rename ENTIRELY, broke just as fast the other way: the real bundle also has a genuine
//    top-level `function as(e){...}` in one member, colliding for real with another member's
//    own `as`, and leaving BOTH unrenamed re-declares "as" twice in the merged scope
//    (`Identifier 'as' has already been declared`). Only per-position protection — rename "as"
//    the identifier, never "as" the keyword — satisfies both real cases at once.
//
// `mergeGroup` separately rewrites any COLLIDING imported name into an explicit
// `imported as __mK_local` alias before this runs (`aliasCollidingNamedImports`), so a named
// import's LOCAL half (after `as`) stays independently renameable; everything masked below
// never corresponds to a binding in THIS module at all — an export-FROM re-export is indirect,
// no local variable is ever created for either side of it, regardless of what
// `aliasCollidingNamedImports` did (it only ever touches IMPORT clauses).
var ANY_SPEC = '"(?:[^"\\\\]|\\\\.)*"';

// LOAD-BEARING, AND THE REASON THIS FILE DISAGREED WITH ITSELF ACROSS ENGINES. node-shim's
// loader rewrites its dynamic-import operator — the keyword immediately followed by an open
// paren — to `__tjsDynImport(` in EVERY CJS file it evaluates, this one included
// (`DYN_IMPORT_RE` in libexec/node-shim/loader.cjs). That rewrite is a blind text
// substitution: it cannot tell code from a string or regex literal, and every pattern in this
// file that matches an import STATEMENT is that exact shape (keyword, then `(?:` for the
// optional default-import prefix). Written inline, those patterns loaded as
// `__tjsDynImport(?:...` under tjs and then silently never matched, while remaining perfect
// under node — so this file's unit tests and its behaviour on the real engine disagreed.
//
// Measured on the real 2.1.250 graph: the 95-module group died at compile with
// `Unexpected identifier '__m7_as'` (three patterns dead at once — the import-clause
// protection below, `aliasCollidingNamedImports`, and the cross-group import rewrite — so an
// `as` KEYWORD went unmasked and got renamed like a binding), and the 5- and 7-module groups
// merged to different, WRONG bytes than node produced with no error at all: every colliding
// named import lost its alias, `import{wt,ac}from"…"` becoming `import{__m0_wt,__m0_ac}` — a
// request for export names that do not exist.
//
// Keeping the keyword in this constant means the two characters never sit adjacent in this
// file's text, so the loader's transform is a no-op on it. test/scc-merge.test.cjs applies
// the loader's OWN transform (read out of loader.cjs, so the two cannot drift) to this file
// and re-runs the merger through it, which is what makes that stay true.
var IMPORT_KW = 'import';

function protectImportedExportNames(src, mask) {
  var m;

  // import { a, b as c } from "spec";  /  import def, { a } from "spec";  — the "imported"
  // half of every entry (before `as`, or the bare name) plus "as"/"from" are protected; the
  // LOCAL half (after `as`) is left alone, still renameable if it collides.
  var namedRe = new RegExp(IMPORT_KW + '(?:\\s+[A-Za-z0-9_$]+\\s*,)?\\s*\\{([^}]*)\\}\\s*from\\s*' + ANY_SPEC, 'g');
  while ((m = namedRe.exec(src))) {
    if (!mask[m.index]) continue;
    var closeIdx = m[0].indexOf('}', m[0].indexOf('{'));
    var innerStart = m.index + m[0].indexOf('{') + 1;
    // Group 1 = imported name (always masked). Groups 2-4, only present when this entry is
    // aliased, split the `\s+as\s+` gap so the KEYWORD's own offset can be computed exactly —
    // masking the keyword by scanning the whole entry blob for `\bas\b` instead would ALSO mask
    // a local alias name that happens to literally BE "as" (`x as as`), which must stay
    // renameable like any other colliding local name.
    var entryRe = /([A-Za-z0-9_$]+)(?:(\s+)(as)\s+[A-Za-z0-9_$]+)?/g, em;
    while ((em = entryRe.exec(m[1]))) {
      maskSpan(mask, innerStart + em.index, em[1].length);
      if (em[3]) maskSpan(mask, innerStart + em.index + em[1].length + em[2].length, em[3].length);
    }
    maskKeywordTokens(mask, m.index + closeIdx, m[0].slice(closeIdx)); // "from" after them
  }

  // import * as X from "spec";  /  export * as X from "spec";  — "as"/"from" protected; X is a
  // genuine local binding (import form) or a public re-export name with no binding at all
  // (export form) — either way, never a fixed reference this file needs to protect BESIDES the
  // keywords. Captured as separate groups (rather than scanning the whole match for `\bas\b`)
  // so the KEYWORD's exact offset is known even in the vanishingly unlikely case X is itself
  // named "as" or "from" — that identifier must stay renameable, only the keywords must not.
  var starAsRe = new RegExp('((?:import|export)\\s*\\*\\s*)(as)(\\s+[A-Za-z0-9_$]+\\s*)(from)(\\s*' + ANY_SPEC + ')', 'g');
  while ((m = starAsRe.exec(src))) {
    if (!mask[m.index]) continue;
    var asStart = m.index + m[1].length;
    maskSpan(mask, asStart, m[2].length);
    maskSpan(mask, asStart + m[2].length + m[3].length, m[4].length);
  }

  // import def from "spec";  — "from" protected; `def` is a genuine local binding, captured
  // separately for the same reason (`def` could itself be named "from").
  var defaultRe = new RegExp('(import\\s+[A-Za-z0-9_$]+\\s*)(from)\\s*' + ANY_SPEC, 'g');
  while ((m = defaultRe.exec(src))) {
    if (!mask[m.index]) continue;
    maskSpan(mask, m.index + m[1].length, m[2].length);
  }

  // export * from "spec";  — "from" protected (no names at all in this form).
  var starRe = new RegExp('export\\s*\\*\\s*from\\s*' + ANY_SPEC, 'g');
  while ((m = starRe.exec(src))) { if (mask[m.index]) maskKeywordTokens(mask, m.index, m[0]); }

  // export { a, b as c } from "spec";  — an INDIRECT re-export: neither side of any entry is a
  // local binding in THIS module, so the WHOLE clause (both names, "as", "from") is protected.
  var exportFromRe = new RegExp('export\\s*\\{([^}]*)\\}\\s*from\\s*' + ANY_SPEC, 'g');
  while ((m = exportFromRe.exec(src))) {
    if (!mask[m.index]) continue;
    var closeIdx2 = m[0].indexOf('}', m[0].indexOf('{'));
    var braceStart = m.index + m[0].indexOf('{') + 1;
    maskSpan(mask, braceStart, m[1].length); // both names in every entry — neither is a binding
    maskKeywordTokens(mask, m.index + closeIdx2, m[0].slice(closeIdx2)); // "from" after them
  }
}

// A `{` in EXPRESSION position opens an OBJECT (or a binding PATTERN, whose shorthand and
// `key: local` entries have the identical grammar); a `{` in statement position opens a BLOCK.
// These are the tokens after which an expression may start. `do`/`else`/`try`/`finally` are
// deliberately absent — they too are followed by a `{`, and it is always a block.
var OBJ_OPEN_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield',
  'case', 'await', 'let', 'var', 'const',
]);
// `{ get x(){}, set x(v){}, async f(){} }` and `class C { static m(){} }` — the member NAME
// follows the modifier, and it is a property name just the same.
var MEMBER_MODIFIER = new Set(['get', 'set', 'async', 'static']);
// `break lbl;` / `continue lbl;` — a LABEL reference, in the label namespace, not a binding.
var LABEL_JUMP = new Set(['break', 'continue']);

// CONTEXTUAL KEYWORDS ARE FIXED SYNTAX SPELLED LIKE IDENTIFIERS, and `of` is the one that cost a
// second CI round. It is NOT a reserved word, so a member may legitimately declare a top-level
// binding named `of` — the real darwin-arm64 2.1.251 graph has one doing
// `import{of}from"<chunk>"` — and when another member of the same cyclic group declares `of`
// too, it lands in the collision set. The rename then rewrote the KEYWORD in every for-of header
// in the merged module: `for(let o __m26_of t)`, 2137 of them, and the group stopped parsing
// (`expected 'of' or 'in' in for control expression`). `in` cannot do this — it IS reserved, so
// no member can declare it — which is why only `of` needs finding.
//
// Blanket-excluding the WORD is the wrong fix, the same way it was wrong for `as` (see
// `protectImportedExportNames`): a real binding named `of` still has to rename, or two members'
// `of` re-declare in the merged scope. So this locates the KEYWORD POSITION instead.
//
// Returns [start, end) of the token occupying the `of` slot of a for-of header — the first
// depth-1 identifier preceded by the end of a binding target (identifier, `]` or `}`), reached
// before any depth-1 `;` or `=`. A classic `for (let i = 0; ...)` returns null at the `=` (and
// would at the `;`), so `for (let i = of.length; ...)` correctly keeps `of` renameable. Returns
// whatever token is THERE, not necessarily the word `of`, so the output gate can use the same
// reading to check that nothing renamed it.
var DECL_KW = new Set(['let', 'const', 'var']);
function forHeadKeywordSlot(src, mask, fEnd) {
  var n = src.length, p = fEnd, q, ch, e, d = 0, pv, lastWord = '';
  while (p < n && mask[p] && isAsciiWsCode(src.charCodeAt(p))) p++;
  if (p >= n || !mask[p]) return null;
  if (isIdentStartCode(src.charCodeAt(p))) {                    // `for await (`
    e = p + 1;
    while (e < n && mask[e] && isIdentCode(src.charCodeAt(e))) e++;
    if (src.slice(p, e) !== 'await') return null;
    p = e;
    while (p < n && mask[p] && isAsciiWsCode(src.charCodeAt(p))) p++;
    if (p >= n || !mask[p]) return null;
  }
  if (src.charAt(p) !== '(') return null;
  for (q = p; q < n; q++) {
    if (!mask[q]) continue;
    ch = src.charAt(q);
    if (ch === '(' || ch === '[' || ch === '{') { d++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { d--; if (d <= 0) return null; continue; }
    if (d !== 1) continue;
    if (ch === ';' || ch === '=') return null;  // classic for, or a binding with an initializer
    if (!isIdentStartCode(src.charCodeAt(q))) continue;
    e = q + 1;
    while (e < n && mask[e] && isIdentCode(src.charCodeAt(e))) e++;
    pv = q - 1;
    while (pv >= 0 && mask[pv] && isAsciiWsCode(src.charCodeAt(pv))) pv--;
    if (pv >= 0 && mask[pv]) {
      var pc = src.charCodeAt(pv);
      // The keyword follows the binding TARGET. `for (const x of y)`: `x`. `for ([a] of y)`: `]`.
      // `for ({a} of y)`: `}`. The one identifier that is NOT a target is the declaration
      // keyword itself — without that exclusion `for (let o of xs)` reports `o` as the slot,
      // because `o` is an identifier preceded by the `t` of `let`.
      if ((isIdentCode(pc) && !DECL_KW.has(lastWord)) || pc === 93 || pc === 125) return [q, e];
    }
    lastWord = src.slice(q, e);
    q = e - 1;
  }
  return null;
}

// FIXED PROPERTY NAMES, AND THE ONE SHAPE THAT IS A NAME AND A REFERENCE AT ONCE.
//
// The `.` guard on the rename pass only ever covered `obj.shared`. Every OTHER position where an
// identifier is a fixed NAME rather than a value read was unguarded, and the real 2.1.250
// linux-x64 graph collected on that: `set` is a top-level binding in one member of the 95-module
// group and a property KEY in another — `function i6t(){let e;return{set:(t)=>{e=t},get:()=>e}}`
// — so the collision rename moved the property, `{__m29_set:(t)=>{e=t},get:()=>e}`. That
// compiles, boots, prints `--help`, and dies on the first real turn with `TypeError: not a
// function` at `t.installed.set(r)`, three frames from anything that names the merger. 367
// property keys were renamed in that one group; 336 in the darwin-arm64 graph, which merely
// never called one during the build's own smoke — a passing build was not evidence.
//
// This is still not a JS parser: it tracks bracket nesting and classifies each `{` as opening an
// OBJECT/PATTERN, a CLASS body, or a BLOCK, which is all that is needed to tell a property name
// from a reference. Misclassifying an object as a block only restores the old behaviour (the
// safe direction); the reverse would refuse to rename a real reference, so the object side is
// deliberately the narrow one — an explicit operator, `(`, `,`, `[`, `:`, or one of the words
// above, never "anything that is not a block".
//
// Returns BOTH halves of the problem:
//   `keys`      — bytes that are fixed property names. Masked, so nothing renames them.
//   `shorthand` — `{ set }` positions, which mean `{ set: set }`: simultaneously a fixed KEY and
//                 a real binding reference, so neither masking nor renaming is right on its own.
//                 `expandCollidingShorthand` splits them into the explicit pair first.
function propertyNames(src, mask) {
  var n = src.length;
  var keys = new Uint8Array(n);
  var shorthand = [];
  var stack = [];
  var classPending = false;
  var blockPending = false;   // the next `{` closes a `case`/`default`/label clause, so it is a BLOCK
  var pendingClause = -1;     // bracket depth at which such a clause is waiting for its `:`
  var i, c, end, pi, ni, pc, nc, enc, wStart, mod;

  // Previous / next non-whitespace CODE index. A literal, template or comment boundary reads as
  // "no token we can name", which classifies as a block — the safe direction.
  function prevIdx(p) {
    while (p >= 0 && mask[p] && isAsciiWsCode(src.charCodeAt(p))) p--;
    return (p >= 0 && mask[p]) ? p : -1;
  }
  function nextIdx(p) {
    while (p < n && mask[p] && isAsciiWsCode(src.charCodeAt(p))) p++;
    return (p < n && mask[p]) ? p : -1;
  }
  function wordStart(p) { // start of the identifier ending AT p (inclusive), or -1
    if (p < 0 || !isIdentCode(src.charCodeAt(p))) return -1;
    while (p > 0 && mask[p - 1] && isIdentCode(src.charCodeAt(p - 1))) p--;
    return isIdentStartCode(src.charCodeAt(p)) ? p : -1;
  }
  function braceKind(p) { // p = prevIdx of the `{`
    if (p < 0) return 'block';
    var ch = src.charAt(p);
    if (ch === '>' && p > 0 && src.charAt(p - 1) === '=') return 'block'; // arrow function body
    if (ch === ')' || ch === '}' || ch === ';') return 'block';
    if ('=(,[:?!&|+-*/%<>~^'.indexOf(ch) !== -1) return 'obj';
    var ws = wordStart(p);
    if (ws >= 0) return OBJ_OPEN_WORD.has(src.slice(ws, p + 1)) ? 'obj' : 'block';
    return 'block';
  }
  // An object-literal method name: `{ set(k, v){ ... } }`. The matched `)` must be followed by
  // `{` — otherwise `{ f(x) }` is a block containing a call, not an object containing a method.
  function methodTail(p) { // p = index of the `(`
    var d = 0, q;
    for (q = p; q < n; q++) {
      if (!mask[q]) continue;
      if (src.charAt(q) === '(') d++;
      else if (src.charAt(q) === ')') { d--; if (!d) break; }
    }
    var r = nextIdx(q + 1);
    return r >= 0 && src.charAt(r) === '{';
  }

  for (i = 0; i < n; i++) {
    if (!mask[i]) continue;
    c = src.charCodeAt(i);
    if (isAsciiWsCode(c)) continue;
    if (c === 123) {                                                   // {
      // A `{` after a `:` is `{ a: { b: 1 } }` — an object — OR the body of a `case`/`default`
      // clause or a labelled statement, which is a BLOCK. Only the colon itself can tell them
      // apart, so the two clause forms flag it as they go by. Getting this wrong is not
      // cosmetic: `case "uds": { let t = s.session, l = ... }` read as an object literal makes
      // `l =` look like a shorthand entry with a default, and expanding it produces
      // `let t = s.session, l: l = ...` — a SyntaxError. Measured on the real linux-x64 group.
      if (classPending) { stack.push('class'); classPending = false; blockPending = false; continue; }
      if (blockPending) { stack.push('block'); blockPending = false; continue; }
      stack.push(braceKind(prevIdx(i - 1)));
      continue;
    }
    blockPending = false; // only the token IMMEDIATELY after the clause's `:` can be its body
    if (c === 40 || c === 91) { stack.push('('); continue; }           // ( [
    if (c === 41 || c === 93 || c === 125) { stack.pop(); continue; }  // ) ] }
    if (c === 58) {                                                    // :
      if (pendingClause === stack.length) { pendingClause = -1; blockPending = true; }
      continue;
    }
    if (!isIdentStartCode(c)) continue;
    end = i + 1;
    while (end < n && mask[end] && isIdentCode(src.charCodeAt(end))) end++;
    // `src.slice` ONLY when the token could be the word we are looking for. This loop visits
    // every identifier of a 7MB merged body, and slicing each one to compare it against a
    // 5-character string is millions of throwaway substrings for a handful of hits.
    if (end - i === 5 && c === 99 /* c */ && src.slice(i, end) === 'class') classPending = true;
    // `for (x of y)` — the keyword sits in a fixed slot that only the header can locate.
    else if (end - i === 3 && c === 102 /* f */ && src.slice(i, end) === 'for') {
      var slot = forHeadKeywordSlot(src, mask, end);
      if (slot && src.slice(slot[0], slot[1]) === 'of') markSpan(keys, slot[0], slot[1] - slot[0]);
    }
    // `async function f(){}` — an identifier can never be followed by the `function` KEYWORD, so
    // this one is unambiguous without any surrounding context. (The other `async` positions —
    // `async x => y`, `async (x) => y` — are not, and are left alone.)
    else if (end - i === 5 && c === 97 /* a */ && src.slice(i, end) === 'async') {
      var af = end;
      while (af < n && mask[af] && isAsciiWsCode(src.charCodeAt(af))) af++;
      if (src.substr(af, 8) === 'function' && !isIdentCode(src.charCodeAt(af + 8))) markSpan(keys, i, end - i);
    }
    // `case <expr>:` / `default:` — the `:` handler turns this into "the next `{` is a block".
    else if ((end - i === 4 && c === 99 && src.slice(i, end) === 'case')
      || (end - i === 7 && c === 100 /* d */ && src.slice(i, end) === 'default')) {
      pendingClause = stack.length;
    }

    enc = stack.length ? stack[stack.length - 1] : 'block';
    pi = prevIdx(i - 1);
    ni = nextIdx(end);
    pc = pi >= 0 ? src.charCodeAt(pi) : -1;
    nc = ni >= 0 ? src.charCodeAt(ni) : -1;

    // THE RULE THAT NEEDS NO BRACKET CLASSIFICATION, and the one `assertNoRenamedFixedNames`
    // re-checks the finished merge against. An identifier between `{`/`,`/`;`/`}`/`)` and a `:`
    // is a property KEY or a statement LABEL — a fixed name either way, never a value read. The
    // two shapes where a `:` really does follow a reference are both excluded by what precedes
    // it: a ternary's consequent follows `?`, a `case` clause's follows the `case` keyword.
    //
    // Labels are protected for the same reason property keys are — a label lives in its own
    // namespace, so renaming one is never NEEDED — and protecting them here is what lets the
    // check above be unconditional: `{ e: for(;;){} }` inside a BLOCK would otherwise be
    // indistinguishable from a mis-classified object literal. `break e` / `continue e` are
    // protected with it, because renaming only one half is a syntax error.
    if (nc === 58 && (pc === 123 || pc === 44 || pc === 59 || pc === 125 || pc === 41)) {
      markSpan(keys, i, end - i);
      // After `;`, `}` or `)` a property key is impossible, so this is unambiguously a LABEL and
      // its `{`, if it has one, is a block. After `{` or `,` it could be either, and the ONE
      // shape that would go wrong (a labelled block as the first statement of a block) is left
      // reading as an object — see `braceKind`'s safe direction.
      if (pc === 59 || pc === 125 || pc === 41) pendingClause = stack.length;
      i = end - 1;
      continue;
    }
    if (isIdentCode(pc)) {
      wStart = wordStart(pi);
      // `break`/`continue` are the only two 5- and 8-character words this needs, so the length
      // test comes before the slice: minified code puts an identifier after a KEYWORD constantly
      // (`return x`, `typeof x`, `new X`), and slicing every one of them is pure waste.
      if (wStart >= 0 && (pi - wStart === 4 || pi - wStart === 7)
          && LABEL_JUMP.has(src.slice(wStart, pi + 1))) {
        markSpan(keys, i, end - i);
        i = end - 1;
        continue;
      }
    }

    if (enc === 'obj' || enc === 'class') {
      // Does a member START here — right after the opening brace or the previous member's
      // separator? (Object: `{` or `,`. Class body: `{`, `;`, or the `}` of a method.)
      var starts = enc === 'obj'
        ? (pc === 123 || pc === 44)
        : (pc === 123 || pc === 59 || pc === 125);
      // ... or right after a member modifier that itself starts one?
      mod = false;
      var modStart = -1;
      if (!starts) {
        wStart = wordStart(pi);
        if (wStart >= 0 && pi - wStart < 6 && MEMBER_MODIFIER.has(src.slice(wStart, pi + 1))) {
          var bp = prevIdx(wStart - 1), bc = bp >= 0 ? src.charCodeAt(bp) : -1;
          mod = enc === 'obj'
            ? (bc === 123 || bc === 44)
            : (bc === 123 || bc === 59 || bc === 125 || bp < 0);
          if (mod) modStart = wStart;
        }
      }
      if (starts || mod) {
        // `{ set: v }` needs no case here — the bracket-kind-independent rule above already
        // protected every `key:` in the file, whatever brace it sat in.
        if (nc === 40 /* ( */ && (enc === 'class' || mod || methodTail(ni))) {
          markSpan(keys, i, end - i);
          // `{ get x(){} }` — `get` is contextual keyword here, not a reference.
          // `{ __m0_get x(){} }` does not parse any more than `for (o __m0_of xs)` does.
          if (modStart >= 0) markSpan(keys, modStart, pi - modStart + 1);
        }
        else if (enc === 'class' && (nc === 61 || nc === 59 || nc === 125)) markSpan(keys, i, end - i);
        else if (enc === 'obj' && !mod && (nc === 44 || nc === 125
          || (nc === 61 && src.charCodeAt(ni + 1) !== 61 && src.charCodeAt(ni + 1) !== 62))) {
          shorthand.push([i, end - i]);                                     // { set } / { set = 1 }
        }
      }
    }
    i = end - 1;
  }
  return { keys: keys, shorthand: shorthand };
}

// `{ set }` is `{ set: set }` written once. Renaming it moves the property; not renaming it
// strands the reference. Splitting it into the explicit pair BEFORE the rename pass makes both
// halves reachable by the rules that already exist — the key is then masked by `propertyNames`,
// the value is an ordinary reference. Only colliding names are expanded, so a group with no
// collision in shorthand position is emitted byte for byte as before.
//
// `renamed` is the set phase 2 will actually rewrite in THIS member — its own declared names
// that collide, not the whole group's collision set. A name another member declares is left
// alone here for the same reason phase 2 leaves it alone: nothing is going to move.
function expandCollidingShorthand(src, renamed) {
  // Deliberately NOT `codeMask(src)` — that would run `propertyNames` to build the key mask and
  // then this would run it a second time for the shorthand half of the same answer. One pass.
  var mask = lexicalCodeMask(src);
  protectImportedExportNames(src, mask);
  var spans = propertyNames(src, mask).shorthand;
  var out = '', last = 0, i, name;
  for (i = 0; i < spans.length; i++) {
    name = src.substr(spans[i][0], spans[i][1]);
    if (!renamed.has(name)) continue;
    out += src.slice(last, spans[i][0]) + name + ': ' + name;
    last = spans[i][0] + spans[i][1];
  }
  return last ? out + src.slice(last) : src;
}

// THE RATCHET. The merge that shipped this bug compiled, booted, printed 257 lines of `--help`
// and passed the build's own PONG smoke on one platform's graph while 336 property keys sat
// renamed in it; the linux-x64 graph of the SAME upstream version had 367 and died on the first
// turn. Nothing between the merger and a user's session looked at the one thing that was wrong.
//
// So the finished merge is re-checked against the rule that needs no bracket classification: a
// `__m<k>_` token the merger itself minted can never sit between `{`/`,`/`;`/`}`/`)` and a `:`,
// because that position is a property key or a label and the rename pass is supposed to have
// left it alone. It is a different reading of the text from the one that produced it — no brace
// kinds, no member modifiers, no shorthand — so a regression in `propertyNames`'s classifier
// fails the BUILD, by name, in one scan, instead of a session somewhere.
// The only words that may legitimately follow a renamed binding with nothing but space
// between them. Three are real word-shaped OPERATORS (`__m0_a instanceof B`, `__m0_k in o`,
// `for (__m0_x of ys)`); the other two are module-clause syntax, and the merged module's own
// consolidated export list is full of the first one (`export { __m0_shared as __m0_export_ay }`).
// (\`extends\` follows the renamed CLASS NAME: \`class __m11_a9e extends Error {}\`.)
var WORD_AFTER_BINDING = new Set(['in', 'instanceof', 'of', 'as', 'from', 'extends']);

function assertNoRenamedFixedNames(mergedSource, groupIndex) {
  var mask = lexicalCodeMask(mergedSource);
  var m, n = mergedSource.length;

  // (b) A CONTEXTUAL KEYWORD position. `for (o __m26_of xs)` is the shape that broke the
  // darwin-arm64 2.1.251 graph; `{ __m0_get x(){} }` and `__m0_async function f(){}` are the
  // same mistake one position over. Both reduce to the same reading, which needs no header
  // parsing at all: a token the merger minted may never be IMMEDIATELY FOLLOWED by another
  // identifier token, because no JS grammar puts two identifiers side by side — except the three
  // word-shaped operators above.
  var idre = /(?<![A-Za-z0-9_$.])(__m\d+_[A-Za-z0-9_$]+)([ \t]+)([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = idre.exec(mergedSource))) {
    if (!mask[m.index]) continue;
    if (WORD_AFTER_BINDING.has(m[3])) continue;
    throw new Error('scc-merge: group ' + groupIndex + ' renamed ' + m[1]
      + ' into a contextual-keyword position — `'
      + mergedSource.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)
      + '`. Two identifiers cannot sit side by side: the merger renamed fixed syntax '
      + '(the `of` of a for-of header, a get/set/async/static member modifier, or the `async` '
      + 'of an async function) that only looks like an identifier.');
  }

  // (a) A PROPERTY KEY or LABEL position.
  var re = /(?<![A-Za-z0-9_$.])(__m\d+_[A-Za-z0-9_$]+)\s*:/g;
  while ((m = re.exec(mergedSource))) {
    if (!mask[m.index]) continue;
    var p = m.index - 1;
    while (p >= 0 && mask[p] && isAsciiWsCode(mergedSource.charCodeAt(p))) p--;
    if (p < 0 || !mask[p]) continue;
    var pc = mergedSource.charCodeAt(p);
    if (pc !== 123 && pc !== 44 && pc !== 59 && pc !== 125 && pc !== 41) continue; // { , ; } )
    throw new Error('scc-merge: group ' + groupIndex + ' renamed ' + m[1]
      + ' into a property-key/label position — `'
      + mergedSource.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)
      + '`. That is a fixed NAME, not a binding reference: the merged module would silently read '
      + 'and write the wrong property. propertyNames() failed to protect it.');
  }
  return n;
}

// ONE-ENTRY MEMO, worth roughly three quarters of all the masking work. mergeGroup routes ~20
// passes per member through maskedReplace, and a pass whose regex does not match hands the SAME
// string object to the next one. Measured on the real 99-module group: 3955 of 5124 codeMask
// calls — 1115MB of scanning — repeat the previous call's string by identity.
//
// Returning the same array is safe because the mask is a pure function of the text and NO caller
// writes to it: maskedReplace, localExportMap and hasExportDefault read it, and topLevelMask and
// clearClauseSpans build their own arrays from it. If a caller ever starts mutating a mask it
// did not build, this memo is the first thing to delete. It changes no output whatsoever, which
// is why it needs no MERGER_VERSION bump — asserted by re-merging the real graphs and comparing
// bytes.
//
// `===` on strings is VALUE equality, not reference identity, so this is correct on any engine
// (both node and tjs return an equal string from a replace that matched nothing — probed, not
// assumed). Both engines also compare identical references in constant time, and even a full
// memcmp of two 7MB strings is far less work than the two char-by-char scans it replaces.
// Measured on the real 99-module group: 28.0s -> 5.9s.
var codeMaskLastSrc = null, codeMaskLast = null;
function codeMask(src) {
  if (src === codeMaskLastSrc) return codeMaskLast;
  var mask = lexicalCodeMask(src);
  protectImportedExportNames(src, mask);
  var keys = propertyNames(src, mask).keys;
  for (var i = 0; i < mask.length; i++) if (keys[i]) mask[i] = 0;
  codeMaskLastSrc = src;
  codeMaskLast = mask;
  return mask;
}

// Apply `regex` (global) to `src`, but only where the match STARTS inside a code span — never
// inside a string/template/regex literal or a comment. Checking the start (not the whole span)
// is deliberate: a legitimate match like `require("spec")` spans INTO the nested string literal
// that is `"spec"` on purpose — that nested literal is correctly masked non-code by itself, but
// the match as a whole is real code because it STARTS there. What the mask must catch is a
// match that only ever occurred because it sits inside some OUTER, unrelated string, comment or
// regex — and that is exactly what a masked start position means. `replacerFn` has the normal
// `String.prototype.replace` callback signature.
function maskedReplace(src, regex, replacerFn) {
  var mask = codeMask(src);
  return src.replace(regex, function (match) {
    var args = Array.prototype.slice.call(arguments);
    var offset = args[args.length - 2];
    if (!mask[offset]) return match;
    return replacerFn.apply(null, args);
  });
}

// A JS identifier boundary, done by hand rather than `\b`: `\b` treats `$` as a non-word
// character, so `\b$foo\b` fails to bound correctly on a name that starts or ends with `$` —
// exactly the shape minifiers produce.
var IDENT_CHAR = 'A-Za-z0-9_$';

function specRegex(spec) {
  // Specifiers are matched as they appear verbatim inside a JS string literal: only `"` and `\`
  // need escaping to build a literal-match regex source for them.
  return escapeRe(spec).replace(/"/g, '\\\\?"');
}

// `\s*` before `{`, NOT `\s+`: minified code overwhelmingly writes `import{a,b}from"spec"` with
// zero whitespace after the keyword — `{` needs no separation from "import" the way an
// identifier would. `\s+` there is a real bug, not a stylistic choice: it silently never
// matches real minified text, so the statement it was meant to rewrite survives untouched.
// Measured live: it left cross-group `import{...}from"<member>"` statements in place across the
// 95-module group, referencing that member's ORIGINALLY-COMPILED (pre-merge) module object
// instead of the merged scope — no compile error, a wrong build. A default-import prefix
// (`import def, {...} from`) is the one place a space truly is mandatory — "importdef" would
// lex as one identifier — so that part keeps `\s+`, captured separately so callers that need
// the default local name (only the cross-group replacement does) can still get it.
var IMPORT_STMT_RES = function (spec) {
  var s = specRegex(spec);
  return [
    // import { a, b as c } from "spec";  /  import def, { a } from "spec";
    new RegExp(IMPORT_KW + '(?:\\s+([A-Za-z0-9_$]+)\\s*,)?\\s*\\{([^}]*)\\}\\s*from\\s*"' + s + '";?', 'g'),
    // import * as ns from "spec";
    new RegExp('import\\s*\\*\\s*as\\s+([A-Za-z0-9_$]+)\\s*from\\s*"' + s + '";?', 'g'),
    // import def from "spec";
    new RegExp('import\\s+([A-Za-z0-9_$]+)\\s*from\\s*"' + s + '";?', 'g'),
    // import "spec"; (side-effect only)
    new RegExp('import\\s*"' + s + '";?', 'g'),
  ];
};

var EXPORT_FROM_RES = function (spec) {
  var s = specRegex(spec);
  return [
    // export { a, b as c } from "spec";
    new RegExp('export\\s*\\{([^}]*)\\}\\s*from\\s*"' + s + '";?', 'g'),
    // export * from "spec";
    new RegExp('export\\s*\\*\\s*from\\s*"' + s + '";?', 'g'),
    // export * as ns from "spec";
    new RegExp('export\\s*\\*\\s*as\\s+([A-Za-z0-9_$]+)\\s*from\\s*"' + s + '";?', 'g'),
  ];
};

// `import.meta.require("spec")` MUST be matched before bare `require("spec")`, or the prefix is
// stranded in front of the replacement and produces `import.meta.__something` — undefined at
// runtime. That exact bug cost a full round on the predecessor plan.
function requireCallRegexes(spec) {
  var s = specRegex(spec);
  return [
    new RegExp('import\\.meta\\.require\\("' + s + '"\\)', 'g'),
    new RegExp('(?<!import\\.meta\\.)require\\("' + s + '"\\)', 'g'),
  ];
}

function nsVar(k) {
  return '__clode_scc_ns' + k;
}

// Parse an `{ a, b as c, ... }` clause into [{ imported, local }, ...].
function parseNamedClause(inner) {
  var parts = inner.split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var m = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(p);
    if (m) out.push({ imported: m[1], local: m[2] });
    else out.push({ imported: p, local: p });
  }
  return out;
}

// For EVERY named-import clause in `src` — any specifier, this member's own external
// dependencies included, not just cross-group ones — rewrite any entry whose LOCAL name
// collides into an explicit `imported as __mK_local` alias. Must run BEFORE the general
// collision-rename pass: an unaliased entry (`import{Yo}from"spec"`) uses the SAME token as
// both the fixed export name and the local binding, and the rename pass (which correctly never
// touches the export-name half — see `protectImportedExportNames`) has no other way to reach
// the local half if it stays fused to the export-name text. Splitting it into an explicit alias
// here gives the local half its own token to rename, while `protectImportedExportNames` makes
// sure the newly-explicit imported half is never itself mistaken for a reference needing rename
// (it can quite easily BE a colliding name too — see that function's comment).
function aliasCollidingNamedImports(src, colliding, k) {
  // Built from `IMPORT_KW`, never written as a literal — see that constant's comment.
  var re = new RegExp(IMPORT_KW + '(?:\\s+[A-Za-z0-9_$]+\\s*,)?\\s*\\{([^}]*)\\}\\s*from\\s*' + ANY_SPEC, 'g');
  return maskedReplace(src, re, function (whole, inner) {
    var entries = parseNamedClause(inner);
    var changed = false;
    var rebuilt = entries.map(function (e) {
      if (colliding.has(e.local)) {
        changed = true;
        return e.imported + ' as __m' + k + '_' + e.local;
      }
      return e.imported === e.local ? e.imported : (e.imported + ' as ' + e.local);
    });
    if (!changed) return whole; // nothing here collides — leave byte-for-byte untouched
    var braceStart = whole.indexOf('{'), braceEnd = whole.indexOf('}', braceStart);
    return whole.slice(0, braceStart + 1) + rebuilt.join(', ') + whole.slice(braceEnd);
  });
}

// Same clause grammar, export-statement roles: the name before `as` is the LOCAL binding, the
// name after it is the EXPORTED name (the reverse of an import clause's roles).
function parseExportClause(inner) {
  var parts = inner.split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var m = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(p);
    if (m) out.push({ local: m[1], exported: m[2] });
    else out.push({ local: p, exported: p });
  }
  return out;
}

// `moduleMeta.exports` gives export NAMES only — not the local binding backing each one. A
// minified bundle overwhelmingly exports through ONE trailing `export { a as PublicName, ... }`
// clause rather than `export const PublicName = ...`, so the local name is very often NOT the
// export name (measured on the real group: every one of the 7 members exports this way, several
// with every single entry aliased). This recovers the true mapping from the member's own bare
// `export { ... }` clause (never one with a trailing `from`, which is a re-export with no local
// binding of its own and is handled separately).
function localExportMap(src) {
  var map = {};
  var mask = codeMask(src);
  var re = /export\s*\{([^}]*)\}(?!\s*from\b)/g, m;
  while ((m = re.exec(src))) {
    if (!mask[m.index]) continue;
    var entries = parseExportClause(m[1]);
    for (var i = 0; i < entries.length; i++) map[entries[i].exported] = entries[i].local;
  }
  return map;
}

// `export default` has no name of its own to key a local binding by — an anonymous default
// (`export default 42;`, `export default {...};`) would need a synthesized local name this file
// has no principled way to pick, and a NAMED default (`export default function foo(){}`) would
// need `moduleMeta`'s "default" entry mapped to "foo", which `localExportMap` does not attempt
// (it only parses the bare `export { ... }` clause). Measured absent from all three real groups
// (7/95/5 members) on 2.1.250, so refusing rather than guessing costs nothing today and fails
// loudly, by name, if a future bundle ever uses it inside a cyclic group.
function hasExportDefault(src) {
  var mask = codeMask(src);
  var re = /export\s+default\b/g, m;
  while ((m = re.exec(src))) { if (mask[m.index]) return true; }
  return false;
}

// WHICH POSITIONS RUN AT MODULE-EVALUATION TIME. A cross-member reference only constrains the
// order of the merged bodies if it is READ while the module evaluates; a reference inside a
// function body is read whenever that function is later called, by which point every body has
// run. `mask` is codeMask(src), so strings, comments and regex literals are already out.
//
// The shapes that matter are the ones a bundler emits: `function f(){}`, `(a)=>{}`, a method
// `x(){}`, `class X{}`, and the eager blocks after if/for/while/switch/catch/with. A `{` that
// closes a `)` is a function body UNLESS one of those keywords opened the `(`.
var EAGER_BLOCK_KW = /(?:^|[^A-Za-z0-9_$])(?:if|for|while|switch|catch|with)$/;
function topLevelMask(src, mask) {
  var out = new Uint8Array(src.length);
  var depth = 0, deferred = 0, braces = [], arrows = [];
  var i, j, k, d, c, ch, isFn;
  // A concise arrow body (`x => expr`, no braces) is deferred code with no closing token of its
  // own: it ends at the first `,` or `;` at the depth it started, or when a bracket closes past
  // that depth. Without this the merger read `()=>import.meta.require("...").SendFileTool` as an
  // evaluation-time read and invented an unsatisfiable ordering cycle on the real 95-module group.
  function popPastDepth() {
    while (arrows.length && arrows[arrows.length - 1] > depth) { arrows.pop(); deferred--; }
  }
  function popAtDepth() {
    while (arrows.length && arrows[arrows.length - 1] >= depth) { arrows.pop(); deferred--; }
  }
  for (i = 0; i < src.length; i++) {
    c = src.charAt(i);
    if (!mask[i]) { out[i] = deferred === 0 ? 1 : 0; continue; }
    if (c === '=' && src.charAt(i + 1) === '>' && mask[i + 1]) {
      j = i + 2;
      while (j < src.length) {
        ch = src.charAt(j);
        if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') break;
        j++;
      }
      if (src.charAt(j) !== '{') { arrows.push(depth); deferred++; }
      out[i] = 0;
      continue;
    }
    if (c === '(' || c === '[') { depth++; out[i] = 0; continue; }
    if (c === '{') {
      j = i - 1;
      while (j >= 0) {
        ch = src.charAt(j);
        if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') break;
        j--;
      }
      isFn = false;
      if (j >= 0 && src.charAt(j) === ')') {
        d = 0;
        for (k = j; k >= 0; k--) {
          if (!mask[k]) continue;
          if (src.charAt(k) === ')') d++;
          else if (src.charAt(k) === '(') { d--; if (!d) break; }
        }
        isFn = !EAGER_BLOCK_KW.test(src.slice(k - 12 < 0 ? 0 : k - 12, k));
      } else if (j >= 1 && src.charAt(j) === '>' && src.charAt(j - 1) === '=') {
        isFn = true;
      }
      braces.push(isFn);
      if (isFn) deferred++;
      depth++;
      out[i] = 0;
      continue;
    }
    if (c === ')' || c === ']') { depth--; popPastDepth(); out[i] = 0; continue; }
    if (c === '}') { depth--; if (braces.pop()) deferred--; popPastDepth(); out[i] = 0; continue; }
    if (c === ',' || c === ';') { popAtDepth(); out[i] = 0; continue; }
    out[i] = deferred === 0 ? 1 : 0;
  }
  return out;
}

// Names listed in an `import { ... }` or `export { ... }` CLAUSE are not value reads — they name
// bindings, and the merger strips or rewrites every one of those statements anyway. Leaving them
// in makes a member look as though it reads its own re-exported imports at evaluation time, which
// invented a mutual-eager-read cycle out of an ordinary re-export barrel on the real 95-module
// group. Blank those spans out of the top-level mask once, for every pair.
function clearClauseSpans(src, mask, top) {
  var res = [/import\s*\{[^}]*\}/g, /export\s*\{[^}]*\}/g], r, m, i, k;
  for (r = 0; r < res.length; r++) {
    res[r].lastIndex = 0;
    while ((m = res[r].exec(src))) {
      if (!mask[m.index]) continue;
      for (k = m.index; k < m.index + m[0].length; k++) top[k] = 0;
    }
  }
  return top;
}

function eagerlyReads(src, top, other) {
  var i, m, re, locals = [], spans = [];
  var impRes = IMPORT_STMT_RES(other), expRes = EXPORT_FROM_RES(other);

  function collectNamed(regex) {
    var mm;
    regex.lastIndex = 0;
    while ((mm = regex.exec(src))) {
      spans.push([mm.index, mm.index + mm[0].length]);
      if (mm[1]) locals.push(mm[1]);
      if (mm[2]) {
        var cl = parseNamedClause(mm[2]);
        for (var c = 0; c < cl.length; c++) locals.push(cl[c].local);
      }
    }
  }
  function collectLocal(regex) {
    var mm;
    regex.lastIndex = 0;
    while ((mm = regex.exec(src))) {
      spans.push([mm.index, mm.index + mm[0].length]);
      if (mm[1]) locals.push(mm[1]);
    }
  }
  collectNamed(impRes[0]);
  collectLocal(impRes[1]);
  collectLocal(impRes[2]);
  collectLocal(expRes[2]);

  function inSpan(pos) {
    for (var q = 0; q < spans.length; q++) if (pos >= spans[q][0] && pos < spans[q][1]) return true;
    return false;
  }

  for (i = 0; i < locals.length; i++) {
    re = new RegExp('(?<!(?<!\\.\\.)\\.)(?<![' + IDENT_CHAR + '])' + escapeRe(locals[i])
      + '(?![' + IDENT_CHAR + '])', 'g');
    while ((m = re.exec(src))) {
      if (!top[m.index] || inSpan(m.index)) continue;
      return true;
    }
  }

  var reqRes = requireCallRegexes(other);
  for (i = 0; i < reqRes.length; i++) {
    reqRes[i].lastIndex = 0;
    while ((m = reqRes[i].exec(src))) {
      if (!top[m.index]) continue;
      if (src.charAt(m.index + m[0].length) === '.') return true;
    }
  }
  return false;
}

// THE ORDER THE MERGED BODIES ARE EMITTED IN, and it is not the graph's topological order.
//
// A residual cyclic require A -> B is cyclic precisely BECAUSE B statically imports its way back
// to A, so in any import-topological order A comes first — and if A reads B's exports while it
// evaluates, that read lands in B's dead zone (`ReferenceError: __m56_mgr is not initialized`,
// measured on the real 95-module group). Upstream does not have this problem because require()
// FORCES evaluation: Bun suspends A mid-body, runs B to completion, and resumes A. One merged
// module runs its bodies atomically and cannot do that, so the only lever left is which body
// goes first.
//
// The constraint is therefore NOT "imports first" and NOT "requires first" — it is that every
// EAGERLY read member must precede its reader, whichever kind of edge carried the reference.
// Lazy references — anything inside a function, which is the overwhelming majority — constrain
// nothing, and treating them as constraints is what makes the problem look unsolvable. Measured
// on 2.1.250's 95-module group: ordering imports-first left 10 eager forward reads, requires-first
// left 45, and ordering on eager reads alone leaves none.
//
// Every other cross-member reference is then honoured as a PREFERENCE, committed incrementally,
// so the result stays as close to the graph's own order as the real constraints allow. A cycle
// among the eager edges would mean the group genuinely cannot be merged by reordering, and says
// so by name rather than emitting an order that fails at runtime.
function mergeBodyOrder(group, sources) {
  var N = group.length, i, j;
  var srcs = [], tops = [];
  for (i = 0; i < N; i++) {
    var t = String(sources[group[i]]);
    var cm = codeMask(t);
    srcs.push(t);
    tops.push(clearClauseSpans(t, cm, topLevelMask(t, cm)));
  }
  var adj = [];
  for (i = 0; i < N; i++) adj.push([]);

  function reaches(from, to) {
    var seen = new Uint8Array(N), stack = [from], v, k;
    while (stack.length) {
      v = stack.pop();
      if (seen[v]) continue;
      seen[v] = 1;
      if (v === to) return true;
      for (k = 0; k < adj[v].length; k++) if (!seen[adj[v][k]]) stack.push(adj[v][k]);
    }
    return false;
  }

  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) {
      if (i === j || srcs[i].indexOf(group[j]) === -1) continue;
      if (!eagerlyReads(srcs[i], tops[i], group[j])) continue;
      if (reaches(i, j)) {
        throw new Error('scc-merge: ' + group[i] + ' needs ' + group[j] + " evaluated first, "
          + 'but ' + group[j] + ' already (transitively) needs ' + group[i] + '. No order of the '
          + 'merged bodies satisfies both, so this group cannot be merged by reordering alone.');
      }
      adj[j].push(i);
    }
  }

  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) {
      if (i === j || srcs[i].indexOf(group[j]) === -1) continue;
      if (reaches(i, j)) continue;
      adj[j].push(i);
    }
  }

  var indeg = new Int32Array(N), out = [], ready = [], v;
  for (i = 0; i < N; i++) for (j = 0; j < adj[i].length; j++) indeg[adj[i][j]]++;
  for (i = 0; i < N; i++) if (indeg[i] === 0) ready.push(i);
  while (ready.length) {
    ready.sort(function (a, b) { return a - b; });
    v = ready.shift();
    out.push(group[v]);
    for (j = 0; j < adj[v].length; j++) if (--indeg[adj[v][j]] === 0) ready.push(adj[v][j]);
  }
  if (out.length !== N) {
    throw new Error('scc-merge: mergeBodyOrder ordered only ' + out.length + ' of ' + N
      + ' members — the eager-read constraints contain a cycle.');
  }
  return out;
}

function mergeGroup(group, sources, moduleMeta, groupIndex) {
  var mergedName = '/$bunfs/root/__clode-scc-' + groupIndex + '.js';
  var i, name;

  var members = [];
  for (i = 0; i < group.length; i++) {
    name = group[i];
    var meta = moduleMeta(name);
    if (!meta) throw new Error('scc-merge: no metadata for ' + name);
    var src = sources[name];
    if (typeof src !== 'string') throw new Error('scc-merge: no source for ' + name);
    if (hasExportDefault(src)) {
      throw new Error('scc-merge: ' + name + ' uses `export default`, which this merger does not support');
    }
    members.push({
      name: name,
      k: i,
      meta: meta,
      src: src,
      declared: declaredNames(meta),
      exportNames: Array.isArray(meta.exports) ? meta.exports.slice() : [],
      exportMap: localExportMap(src),
    });
  }

  // Collision detection over moduleMeta's declared names — computed BEFORE any rewriting,
  // straight from what the engine's own parser reported, since `aliasCollidingNamedImports`
  // (right below) needs to know the full collision set before it can decide which imported
  // names need an explicit alias.
  var countOf = new Map();
  members.forEach(function (m) {
    m.declared.forEach(function (n) {
      countOf.set(n, (countOf.get(n) || 0) + 1);
    });
  });
  var colliding = new Set();
  countOf.forEach(function (c, n) { if (c > 1) colliding.add(n); });

  // Rewrite phase 1: replace cross-group `import ... from "<member>"` and
  // `export ... from "<member>"` statements with plain `const` bindings pulled off that
  // member's namespace object. This is done before collision-based RENAMING (phase 2, below)
  // because it can introduce new top-level names (the import's LOCAL names) that have to be
  // counted too — moduleMeta already counted them (imported bindings occupy the top-level
  // scope), so this rewrite must produce exactly the same set of local names moduleMeta
  // reported, or a collision moduleMeta already accounted for goes undetected.
  // CROSS-MEMBER NAMED IMPORTS BECOME LIVE BINDINGS, NOT EAGER COPIES, and this is the
  // difference between a merge that boots and one that does not. Rewriting
  // `import { Fg } from "<member j>"` to `const __mk_Fg = nsJ.Fg;` READS j's binding at the top
  // of k's body — so j's body must already have run. Every such rewrite is therefore an
  // evaluation-order constraint, and a cyclic group has no order that satisfies all of them
  // (measured on real 2.1.250: 566 forward reads remained no matter how the bodies were sorted).
  // An ES module import is a LIVE BINDING: it does not read anything at import time, only at
  // USE time. Inside one merged scope the faithful equivalent is for k to refer to j's binding
  // DIRECTLY, by name. Then a cross-member import imposes no order at all, exactly like upstream,
  // and a use-before-init fails the same way ESM itself would.
  //
  // `crossRaw[k]` collects, per member, the local token that must become such a reference and the
  // (member, export name) it points at. It is resolved AFTER phase 1, because a chain
  // (k imports from j, j re-exports from q) can only be followed once every member's entry exists.
  var crossRaw = members.map(function () { return {}; });

  var bodies = members.map(function (m) {
    // Any OTHER named import — this member's own external dependencies included, not just
    // cross-group ones — whose LOCAL name collides gets an explicit alias FIRST, so phase 2 has
    // a local-only token to rename without ever touching the fixed export-name half beside it.
    var src = aliasCollidingNamedImports(m.src, colliding, m.k);
    // `{ set }` -> `{ set: set }` before anything renames, so the fixed KEY and the binding
    // REFERENCE it packs together stop being the same token. Only for the names phase 2 will
    // actually rename in THIS member — exactly `m.declared` ∩ `colliding`, computed once here.
    var willRename = new Set();
    m.declared.forEach(function (nm) { if (colliding.has(nm)) willRename.add(nm); });
    src = expandCollidingShorthand(src, willRename);
    for (var j = 0; j < group.length; j++) {
      var other = group[j];
      if (other === m.name) continue;
      // Cheap fast-path: none of the regexes below can possibly match unless `other`'s exact
      // specifier text appears somewhere in `src` (they all require it verbatim). Skipping the
      // ~9 maskedReplace calls per candidate — each an O(size) codeMask scan — turns a group's
      // cost from O(members^2) full-body scans into one substring check per non-reference pair.
      // Measured necessary: the real 95-module group (8930 candidate pairs, most with no real
      // edge at all — the whole graph has only 33 residual cyclic edges in total) took over two
      // minutes without this and is fast with it.
      if (src.indexOf(other) === -1) continue;
      var ns = nsVar(j);

      var importRes = IMPORT_STMT_RES(other);
      // Named + optional default: import def, { a, b as c } from "other";
      src = maskedReplace(src, importRes[0], (function (jj) {
        return function (whole, defName, inner) {
          var clause = parseNamedClause(inner), ci, decls = [];
          for (ci = 0; ci < clause.length; ci++) {
            // The local token here is already the FINAL one: aliasCollidingNamedImports gave a
            // colliding import local its `__mK_` alias before this loop, and phase 2 renames the
            // body's uses to exactly that same token. So phase 3 can key on it directly.
            crossRaw[m.k][clause[ci].local] = { member: jj, imported: clause[ci].imported };
          }
          // A DEFAULT import stays a plain read: mergeGroup refuses a member that uses
          // `export default`, so no member of a group ever has one, and `nsJ.default` is a read of
          // a missing property — undefined, never a dead-zone throw.
          if (defName) decls.push(defName + ' = ' + ns + '.default');
          return decls.length ? ('const ' + decls.join(', ') + ';') : '';
        };
      })(j));
      // import * as ns from "other";
      src = maskedReplace(src, importRes[1], function (whole, local) {
        return 'const ' + local + ' = ' + ns + ';';
      });
      // import def from "other";  (default import — namespace object carries no "default" key
      // unless the member actually exports one; reference it the same way as any other name)
      src = maskedReplace(src, importRes[2], function (whole, local) {
        return 'const ' + local + ' = ' + ns + '.default;';
      });
      // import "other"; (side effect only — member is merged in, so nothing to do)
      src = maskedReplace(src, importRes[3], function () { return ''; });

      var exportRes = EXPORT_FROM_RES(other);
      // export { a, b as c } from "other";  — re-exported names are already covered by the
      // merged module's own `export { ... }` list built from every member's exports, so this
      // statement is simply dropped.
      src = maskedReplace(src, exportRes[0], function () { return ''; });
      // export * from "other";
      src = maskedReplace(src, exportRes[1], function () { return ''; });
      // export * as ns from "other";
      src = maskedReplace(src, exportRes[2], function (whole, local) {
        return 'const ' + local + ' = ' + ns + ';';
      });

      // import.meta.require("other") / require("other") used as an inline expression —
      // becomes a direct reference to that member's namespace object. PREFIXED form first.
      var reqRes = requireCallRegexes(other);
      src = maskedReplace(src, reqRes[0], function () { return ns; });
      src = maskedReplace(src, reqRes[1], function () { return ns; });
    }

    // Strip THIS member's own export syntax — every one of its exports is already re-exposed
    // by the merger's own consolidated `export { ... }` at the end of the merged module, under
    // a name mangled per member (`__m<k>_export_<name>`), so leaving the member's own export
    // survive verbatim is redundant at best. It is worse than redundant whenever two members of
    // the group export the SAME public name: their un-mangled exports collide in the merged
    // module's top-level scope, a SyntaxError. Measured live on the real bundle — 145 duplicate
    // export names in the 95-module group, 5 in the 5-module group — not a hypothetical the
    // 7-module group (Step 6's target) happened not to exercise.
    //
    // The bare grouped clause (`export { a as B, ... }`, never one with a trailing `from`,
    // which is a cross-member re-export already handled above) is dropped outright — nothing
    // else needs it; `exportMap` was built from `m.src` before any rewriting. A single-name
    // inline export (`export function foo(){}`, `export class Foo{}`, `export const/let/var
    // NAME = ...`) keeps its declaration — the local binding NAME is still needed — only the
    // `export` keyword itself goes, so it can't also compete with the merger's own list.
    src = maskedReplace(src, /export\s*\{([^}]*)\}(?!\s*from\b)/g, function () { return ''; });
    src = maskedReplace(src, /export\s+(?=(?:function|class|const|let|var)\b)/g, function () { return ''; });

    return src;
  });

  // Rewrite phase 2: rename every colliding top-level name, per member, to `__m<k>_<name>`.
  // One combined alternation per member (mask computed once, single pass) rather than one
  // maskedReplace per name — the real group has ~130 collisions, and re-masking an 800KB
  // member per name adds up for no benefit: `String.prototype.replace` with a global regex
  // already matches against the untouched original in one pass, so a single alternation is
  // both faster and no less correct than looping.
  //
  // THE `.` GUARD IS `(?<!(?<!\.\.)\.)`, NOT `(?<!\.)`, AND THE NESTING IS THE WHOLE POINT.
  // `.` is not an IDENT_CHAR, so the boundary lookarounds alone happily match a colliding name
  // used as a PROPERTY — `obj.shared`, or optional-chained `obj?.shared` — which is never a
  // lexical binding reference and must never be renamed. But a flat `(?<!\.)` ALSO refuses to
  // rename a SPREAD or REST reference — `{...shared}`, `[...shared]`, `f(...shared)` — where the
  // preceding `.` is the tail of `...` and the name IS a binding reference. That cost a whole
  // build: `var __m0_FO=Je(), N=new lp({testGlobalConfig:{...FO, autoUpdates:!1}})` — declaration
  // renamed, spread left behind — and the real 2.1.250 target died with `ReferenceError: FO is
  // not defined`. 5621 such references across the three groups, so this was never going to be a
  // rare corner. The inner lookbehind excludes exactly the `...` case: reject a `.` only when it
  // is NOT itself preceded by `..`. See the KNOWN LIMITATION note in the file header for the one
  // case this file does not and cannot reliably guard: object-literal shorthand.
  bodies = bodies.map(function (src, idx) {
    var m = members[idx];
    var names = [];
    m.declared.forEach(function (n) { if (colliding.has(n)) names.push(n); });
    if (!names.length) return src;
    names.sort(function (a, b) { return b.length - a.length; });
    var alt = names.map(escapeRe).join('|');
    var re = new RegExp('(?<!(?<!\\.\\.)\\.)(?<![' + IDENT_CHAR + '])(?:' + alt + ')(?![' + IDENT_CHAR + '])', 'g');
    return maskedReplace(src, re, function (whole) { return '__m' + m.k + '_' + whole; });
  });

  // Rewrite phase 3: every cross-member named import becomes a direct reference to the OTHER
  // member's binding. Runs after phase 2 so it sees the tokens phase 2 produced, and uses the
  // same masked, spread-aware, property-safe boundary as phase 2 — it is the same kind of edit.
  bodies = bodies.map(function (src, idx) {
    var cr = crossRaw[idx], toks = [], t;
    for (t in cr) {
      if (!Object.prototype.hasOwnProperty.call(cr, t)) continue;
      var target = resolveTok(cr[t].member, baseTok(members[cr[t].member], cr[t].imported));
      if (target !== t) toks.push([t, target]);
    }
    if (!toks.length) return src;
    toks.sort(function (a, b) { return b[0].length - a[0].length; });
    var map = {};
    toks.forEach(function (e) { map[e[0]] = e[1]; });
    var alt = toks.map(function (e) { return escapeRe(e[0]); }).join('|');
    var re = new RegExp('(?<!(?<!\\.\\.)\\.)(?<![' + IDENT_CHAR + '])(?:' + alt + ')(?![' + IDENT_CHAR + '])', 'g');
    return maskedReplace(src, re, function (whole) { return map[whole]; });
  });

  // The identifier that actually holds an export's value in the rewritten body: the member's
  // TRUE local binding for it (from its own `export { local as exported }` clause — NOT the
  // export name itself, which is very often a different, more readable string), renamed if
  // that local name collided.
  function baseTok(m, exportedName) {
    var trueLocal = Object.prototype.hasOwnProperty.call(m.exportMap, exportedName)
      ? m.exportMap[exportedName] : exportedName;
    return colliding.has(trueLocal) ? '__m' + m.k + '_' + trueLocal : trueLocal;
  }

  // Follow a cross-member import to the binding it actually names. A chain is possible — k
  // imports a name j itself imported from q — and a CYCLE is possible too (that is what a
  // strongly connected group is), so the walk stops rather than recursing forever and keeps the
  // token it has; that token is still a real binding, just one more hop away than ideal.
  var resolvingTok = {};
  function resolveTok(k, tok) {
    var cr = crossRaw[k];
    if (!cr || !Object.prototype.hasOwnProperty.call(cr, tok)) return tok;
    var key = k + '|' + tok;
    if (resolvingTok[key]) return tok;
    resolvingTok[key] = 1;
    var t = cr[tok];
    var r = resolveTok(t.member, baseTok(members[t.member], t.imported));
    delete resolvingTok[key];
    return r;
  }

  function localFor(m, exportedName) {
    return resolveTok(m.k, baseTok(m, exportedName));
  }

  // Namespace objects: one per member, mapping each export name to that member's (possibly
  // renamed) local identifier for it.
  //
  // GETTERS, NOT VALUES, AND DECLARED AHEAD OF EVERY BODY. Both halves of that are load-bearing,
  // and the first real build proved it: a residual cyclic require rewritten to a bare `nsJ`
  // reference (`var R9 = __clode_scc_ns5`) sat in member 0's body while the declarations sat at
  // the BOTTOM of the merged module, so the target booted and died on
  // `ReferenceError: __clode_scc_ns5 is not initialized` — the const's own temporal dead zone.
  // Moving the declarations to the front fixes that, but only if the property values are lazy:
  // a plain `{ name: __m5_pht }` object literal evaluated before the bodies would read every
  // member's locals while they are ALL still in their dead zone. A getter reads at USE time,
  // which is also what an ES module namespace object does — the merged form is more faithful
  // than the snapshot it replaces, not less.
  //
  // The eager cross-member reads phase 1 emits (`const __mK_x = nsJ.x;`, 1723 of them on 2.1.250)
  // stay correct because `group` is in the graph's own topological IMPORT order: a static import
  // always names an EARLIER member, so member J's body has already run. Measured on all three
  // real groups: 1723 such reads, 0 of them forward. A FORWARD one would fail loudly, naming the
  // uninitialized local, rather than silently reading undefined.
  var nsDecls = members.map(function (m) {
    var props = m.exportNames.map(function (en) {
      return 'get ' + JSON.stringify(en) + '() { return ' + localFor(m, en) + '; }';
    });
    return 'const ' + nsVar(m.k) + ' = { ' + props.join(', ') + ' };';
  });

  // A single `export { ... }` naming every member's exports under their (possibly renamed)
  // local names, aliased back to the ORIGINAL export name so each member's shim can still
  // `import { <exportName> } from mergedName`.
  var exportPairs = [];
  members.forEach(function (m) {
    m.exportNames.forEach(function (en) {
      exportPairs.push(localFor(m, en) + ' as __m' + m.k + '_export_' + en);
    });
  });

  var mergedSource = nsDecls.join('\n')
    + '\n' + bodies.join('\n')
    + (exportPairs.length ? ('\nexport { ' + exportPairs.join(', ') + ' };\n') : '\n');

  assertNoRenamedFixedNames(mergedSource, groupIndex);

  // Shims: each member keeps its own name and re-exports exactly what it used to, from the
  // merged module, under its own alias (`__m<k>_export_<name>` -> `<name>`).
  // WHY `import ... from` + a separate `export`, and not the one-line `export { ... } from`
  // that says exactly the same thing: bun-graph-plan.cjs's depsOf() — the ONLY thing that knows
  // what a module depends on, and therefore what order the fuse worker compiles in — matches
  // `import` forms only. A re-export-from shim reads as dependency-free, so planOrder is free to
  // put it BEFORE the merged module it re-exports, and compile() dies with
  // "could not load '/$bunfs/root/__clode-scc-0.js'" on a graph that is perfectly well-formed.
  // Measured, on the first real build. These shims are OUR generated code, so they stay inside
  // the vocabulary the planner already understands rather than widening it; test/scc-merge.test.cjs
  // asserts the coupling directly, against the real depsOf, so it can never drift silently again.
  //
  // A member with NO exports still `import`s the merged module rather than being an inert
  // `export {}`: the member's BODY now lives inside the merged module, so a module that imported
  // this one purely for its side effects must still force that evaluation.
  var shims = {};
  members.forEach(function (m) {
    if (!m.exportNames.length) {
      shims[m.name] = 'import "' + mergedName + '";\nexport {};\n';
      return;
    }
    var clause = m.exportNames.map(function (en) {
      return '__m' + m.k + '_export_' + en + ' as ' + en;
    });
    shims[m.name] = 'import { ' + clause.join(', ') + ' } from "' + mergedName + '";\n'
      + 'export { ' + m.exportNames.join(', ') + ' };\n';
  });

  return { mergedName: mergedName, mergedSource: mergedSource, shims: shims };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { declaredNames, mergeGroup, mergeBodyOrder, assertNoRenamedFixedNames, MERGER_VERSION };
}
