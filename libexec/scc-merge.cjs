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

// `meta.locals` is the union of two engine tables (vardefs + closure_var) and can repeat a name
// across them, and it reports compiler-internal synthetic names in angle brackets (e.g.
// `<class_fields_init>`) that are not real user bindings and can never collide with one.
function declaredNames(meta) {
  var out = new Set();
  if (!meta || !Array.isArray(meta.locals)) return out;
  for (var i = 0; i < meta.locals.length; i++) {
    var n = meta.locals[i];
    if (typeof n !== 'string' || n.indexOf('<') !== -1) continue;
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

function codeMask(src) {
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
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'interp', depth: 0 }); i += 2; continue; }
      i++; continue;
    }
    // Code state: top-level, or inside a `${ ... }` interpolation.
    var ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      prevTok = ')';
      continue;
    }
    if (ch === '"' || ch === "'") {
      var q = ch; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      prevTok = ')';
      continue;
    }
    if (ch === '`') { stack.push({ kind: 'template' }); i++; prevTok = ')'; continue; }
    if (top && top.kind === 'interp' && ch === '{') { top.depth++; mask[i] = 1; i++; prevTok = '{'; continue; }
    if (top && top.kind === 'interp' && ch === '}') {
      if (top.depth === 0) { stack.pop(); i++; prevTok = ')'; continue; }
      top.depth--; mask[i] = 1; i++; prevTok = '}'; continue;
    }
    if (ch === '/' && regexAllowed(prevTok)) {
      var j = i + 1, inClass = false, malformed = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') { malformed = true; break; }
        if (src[j] === '[') { inClass = true; j++; continue; }
        if (src[j] === ']') { inClass = false; j++; continue; }
        if (src[j] === '/' && !inClass) { j++; break; }
        j++;
      }
      if (!malformed) {
        while (j < n && /[A-Za-z]/.test(src[j])) j++;
        i = j; prevTok = ')'; continue;
      }
      // Fell through: not a well-formed regex literal on this line. Treat `/` as division
      // (the safe default — worst case a byte that could have been masked stays protected).
    }
    if (/[A-Za-z_$]/.test(ch)) {
      var start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) { mask[i] = 1; i++; }
      prevTok = src.slice(start, i);
      continue;
    }
    mask[i] = 1;
    if (!/\s/.test(ch)) prevTok = ch;
    i++;
  }
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

var IMPORT_STMT_RES = function (spec) {
  var s = specRegex(spec);
  return [
    // import { a, b as c } from "spec";  /  import def, { a } from "spec";
    new RegExp('import\\s+(?:[A-Za-z0-9_$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*"' + s + '";?', 'g'),
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

  // Rewrite phase 1: replace cross-group `import ... from "<member>"` and
  // `export ... from "<member>"` statements with plain `const` bindings pulled off that
  // member's namespace object. This is done BEFORE collision detection because it can
  // introduce new top-level names (the import's LOCAL names) that have to be counted too —
  // moduleMeta already counted them (imported bindings occupy the top-level scope), so this
  // rewrite must produce exactly the same set of local names moduleMeta reported, or a
  // collision moduleMeta already accounted for goes undetected.
  var bodies = members.map(function (m) {
    var src = m.src;
    for (var j = 0; j < group.length; j++) {
      var other = group[j];
      if (other === m.name) continue;
      var ns = nsVar(j);

      var importRes = IMPORT_STMT_RES(other);
      // Named + optional default: import def, { a, b as c } from "other";
      src = maskedReplace(src, importRes[0], function (whole, inner) {
        var clause = parseNamedClause(inner);
        var decls = clause.map(function (c) { return c.local + ' = ' + ns + '.' + c.imported; });
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
    return src;
  });

  // Collision detection over moduleMeta's declared names — unaffected by the rewrite above,
  // because the rewrite preserves exactly the local names moduleMeta already reported.
  var countOf = new Map();
  members.forEach(function (m) {
    m.declared.forEach(function (n) {
      countOf.set(n, (countOf.get(n) || 0) + 1);
    });
  });
  var colliding = new Set();
  countOf.forEach(function (c, n) { if (c > 1) colliding.add(n); });

  // Rewrite phase 2: rename every colliding top-level name, per member, to `__m<k>_<name>`.
  // One combined alternation per member (mask computed once, single pass) rather than one
  // maskedReplace per name — the real group has ~130 collisions, and re-masking an 800KB
  // member per name adds up for no benefit: `String.prototype.replace` with a global regex
  // already matches against the untouched original in one pass, so a single alternation is
  // both faster and no less correct than looping.
  bodies = bodies.map(function (src, idx) {
    var m = members[idx];
    var names = [];
    m.declared.forEach(function (n) { if (colliding.has(n)) names.push(n); });
    if (!names.length) return src;
    names.sort(function (a, b) { return b.length - a.length; });
    var alt = names.map(escapeRe).join('|');
    var re = new RegExp('(?<![' + IDENT_CHAR + '])(?:' + alt + ')(?![' + IDENT_CHAR + '])', 'g');
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
