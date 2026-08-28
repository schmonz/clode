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
function protectImportedExportNames(src, mask) {
  var m;

  // import { a, b as c } from "spec";  /  import def, { a } from "spec";  — the "imported"
  // half of every entry (before `as`, or the bare name) plus "as"/"from" are protected; the
  // LOCAL half (after `as`) is left alone, still renameable if it collides.
  var namedRe = new RegExp('import(?:\\s+[A-Za-z0-9_$]+\\s*,)?\\s*\\{([^}]*)\\}\\s*from\\s*' + ANY_SPEC, 'g');
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

function codeMask(src) {
  var mask = lexicalCodeMask(src);
  protectImportedExportNames(src, mask);
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
    new RegExp('import(?:\\s+([A-Za-z0-9_$]+)\\s*,)?\\s*\\{([^}]*)\\}\\s*from\\s*"' + s + '";?', 'g'),
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
  var re = /import(?:\s+[A-Za-z0-9_$]+\s*,)?\s*\{([^}]*)\}\s*from\s*"(?:[^"\\]|\\.)*"/g;
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
  var bodies = members.map(function (m) {
    // Any OTHER named import — this member's own external dependencies included, not just
    // cross-group ones — whose LOCAL name collides gets an explicit alias FIRST, so phase 2 has
    // a local-only token to rename without ever touching the fixed export-name half beside it.
    var src = aliasCollidingNamedImports(m.src, colliding, m.k);
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
      src = maskedReplace(src, importRes[0], function (whole, defName, inner) {
        var clause = parseNamedClause(inner);
        var decls = clause.map(function (c) { return c.local + ' = ' + ns + '.' + c.imported; });
        if (defName) decls.unshift(defName + ' = ' + ns + '.default');
        return decls.length ? ('const ' + decls.join(', ') + ';') : '';
      });
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
  // `(?<!\.)` is load-bearing, not decoration: `.` is not an IDENT_CHAR, so the boundary
  // lookarounds alone happily match a colliding name used as a PROPERTY — `obj.shared` — which
  // is never a lexical binding reference. A name immediately after `.` (plain member access OR
  // optional chaining, `?.foo` — both end in the same `.` right before the name) must never be
  // touched; this excludes it categorically. See the KNOWN LIMITATION note in the file header
  // for the one case this file does not and cannot reliably guard: object-literal shorthand.
  bodies = bodies.map(function (src, idx) {
    var m = members[idx];
    var names = [];
    m.declared.forEach(function (n) { if (colliding.has(n)) names.push(n); });
    if (!names.length) return src;
    names.sort(function (a, b) { return b.length - a.length; });
    var alt = names.map(escapeRe).join('|');
    var re = new RegExp('(?<!\\.)(?<![' + IDENT_CHAR + '])(?:' + alt + ')(?![' + IDENT_CHAR + '])', 'g');
    return maskedReplace(src, re, function (whole) { return '__m' + m.k + '_' + whole; });
  });

  // The identifier that actually holds an export's value in the rewritten body: the member's
  // TRUE local binding for it (from its own `export { local as exported }` clause — NOT the
  // export name itself, which is very often a different, more readable string), renamed if
  // that local name collided.
  function localFor(m, exportedName) {
    var trueLocal = Object.prototype.hasOwnProperty.call(m.exportMap, exportedName)
      ? m.exportMap[exportedName] : exportedName;
    return colliding.has(trueLocal) ? '__m' + m.k + '_' + trueLocal : trueLocal;
  }

  // Namespace objects: one per member, mapping each export name to that member's (possibly
  // renamed) local identifier for it.
  var nsDecls = members.map(function (m) {
    var props = m.exportNames.map(function (en) {
      return JSON.stringify(en) + ': ' + localFor(m, en);
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

  var mergedSource = bodies.join('\n')
    + '\n' + nsDecls.join('\n')
    + (exportPairs.length ? ('\nexport { ' + exportPairs.join(', ') + ' };\n') : '\n');

  // Shims: each member keeps its own name and re-exports exactly what it used to, from the
  // merged module, under its own alias (`__m<k>_export_<name>` -> `<name>`).
  var shims = {};
  members.forEach(function (m) {
    if (!m.exportNames.length) {
      shims[m.name] = 'export {};\n';
      return;
    }
    var clause = m.exportNames.map(function (en) {
      return '__m' + m.k + '_export_' + en + ' as ' + en;
    });
    shims[m.name] = 'export { ' + clause.join(', ') + ' } from "' + mergedName + '";\n';
  });

  return { mergedName: mergedName, mergedSource: mergedSource, shims: shims };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { declaredNames, mergeGroup };
}
