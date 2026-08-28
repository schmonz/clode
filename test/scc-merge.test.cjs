'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeGroup, declaredNames } = require('../libexec/scc-merge.cjs');

const META = {
  '/g/a.js': { requires: ['/g/b.js'], exports: ['ay'], locals: ['shared', 'ay', '<class_fields_init>'] },
  '/g/b.js': { requires: ['/g/a.js'], exports: ['bx'], locals: ['shared', 'bx', 'shared'] },
};
const SRC = {
  '/g/a.js': 'const shared = 1;\nexport const ay = shared;\n',
  '/g/b.js': 'const shared = 2;\nexport const bx = shared + import.meta.require("/g/a.js").ay;\n',
};
const meta = (n) => META[n];

// moduleMeta returns names from two engine tables, so duplicates and compiler-internal names
// in angle brackets both occur. Neither is a user binding.
test('declaredNames dedupes and drops compiler-internal names', () => {
  assert.deepStrictEqual([...declaredNames(META['/g/a.js'])].sort(), ['ay', 'shared']);
  assert.deepStrictEqual([...declaredNames(META['/g/b.js'])].sort(), ['bx', 'shared']);
});

test('mergeGroup names the merged module deterministically', () => {
  assert.strictEqual(mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0).mergedName,
    '/$bunfs/root/__clode-scc-0.js');
});

// `shared` collides across both members. Each must get its own binding or one silently
// shadows the other — a merge that boots and computes the wrong answer.
test('mergeGroup renames only the names that actually collide', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  assert.match(r.mergedSource, /__m0_shared/);
  assert.match(r.mergedSource, /__m1_shared/);
  assert.doesNotMatch(r.mergedSource, /\bconst shared\b/);
  // `ay` and `bx` do not collide, so they must be left alone.
  assert.doesNotMatch(r.mergedSource, /__m0_ay|__m1_bx/);
});

// The intra-group require is now a same-scope reference: no require may survive inside a merge.
test('mergeGroup turns an intra-group require into a direct reference', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  assert.doesNotMatch(r.mergedSource, /import\.meta\.require\("\/g\/a\.js"\)/);
  assert.doesNotMatch(r.mergedSource, /require\("\/g\/a\.js"\)/);
});

test('mergeGroup emits one re-export shim per member, keyed by member name', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  assert.deepStrictEqual(Object.keys(r.shims).sort(), ['/g/a.js', '/g/b.js']);
  assert.match(r.shims['/g/a.js'], /\bay\b/);
  assert.match(r.shims['/g/a.js'], /from "\/\$bunfs\/root\/__clode-scc-0\.js"/);
});

test('mergeGroup REFUSES when a member has no metadata', () => {
  assert.throws(() => mergeGroup(['/g/a.js', '/g/zz.js'], SRC, meta, 0),
    /scc-merge: no metadata for \/g\/zz\.js/);
});

// Review fix round 1, finding 1 (Critical). A colliding name used as a PROPERTY — `obj.shared`
// — is never a lexical binding reference. The boundary lookarounds alone don't know that: `.`
// is not an identifier char, so `(?<![ident])shared(?![ident])` still matches the `shared` in
// `obj.shared`, and blindly renaming it changes the property being read/written — no compile
// error, a silently wrong build.
const META_PROP = {
  '/g/a.js': { requires: ['/g/b.js'], exports: ['ay'], locals: ['shared', 'ay'] },
  '/g/b.js': { requires: ['/g/a.js'], exports: ['bx'], locals: ['shared', 'bx', 'obj'] },
};
const SRC_PROP = {
  '/g/a.js': 'const shared = 1;\nexport const ay = shared;\n',
  '/g/b.js': 'const shared = 2;\nconst obj = {};\nobj.shared = shared;\nexport const bx = shared + import.meta.require("/g/a.js").ay;\n',
};
const metaProp = (n) => META_PROP[n];

test('mergeGroup does not rename a colliding name used as a property access', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_PROP, metaProp, 0);
  // The value being assigned (a real binding reference) must be renamed...
  assert.match(r.mergedSource, /obj\.shared\s*=\s*__m1_shared/,
    'the value reference must rename even though the property name beside it must not');
  // ...but the property NAME itself, immediately after `.`, must never be touched.
  assert.doesNotMatch(r.mergedSource, /obj\.__m1_shared/,
    'a name after `.` is a property access, never a lexical binding — it must survive untouched');
});

// Review fix round 1, finding 2 (Important). codeMask must recognise a regex literal that is
// the FIRST token inside a `${ ... }` template interpolation. Entering the interpolation left
// `prevTok` at the stale `)` set when the backtick opened, so `regexAllowed(')')` was false and
// the leading `/` of `/(shared)/` was read as division — meaning the regex body was scanned as
// ordinary code and a colliding name inside it got renamed, with no compile error at all. (The
// pattern is deliberately `/(shared)/`, not `/^shared$/`: `$` is itself one of our IDENT_CHARs,
// so an anchor-bounded name would fail the boundary check regardless of masking and prove
// nothing — parens give real, unshielded boundaries on both sides.)
const META_INTERP = {
  '/g/a.js': { requires: ['/g/b.js'], exports: ['ay'], locals: ['shared', 'ay'] },
  '/g/b.js': { requires: ['/g/a.js'], exports: ['bx'], locals: ['shared', 'bx', 'tag'] },
};
const SRC_INTERP = {
  '/g/a.js': 'const shared = 1;\nexport const ay = shared;\n',
  '/g/b.js': 'const shared = 2;\nconst tag = `${/(shared)/.test("x")}`;\nexport const bx = shared + import.meta.require("/g/a.js").ay;\n',
};
const metaInterp = (n) => META_INTERP[n];

test('mergeGroup does not rename a colliding name inside a regex literal leading a template interpolation', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_INTERP, metaInterp, 0);
  assert.match(r.mergedSource, /\/\(shared\)\//,
    'the regex literal body must survive untouched, byte for byte');
  // Legitimate renames of `shared` elsewhere in this member DO produce `__m1_shared` (the
  // assignment and the export value), so the precise thing to rule out is the renamed form
  // showing up INSIDE the regex specifically.
  assert.doesNotMatch(r.mergedSource, /\(__m1_shared\)/,
    'a name inside the regex must never be renamed just because it collides elsewhere');
});

// Review fix round 1, finding 3 (Important). Checked all three real groups (7/95/5 members) for
// `export default` and for duplicate PUBLIC export names within a group. Zero `export default`
// occurrences anywhere, but real duplicate export names DO occur — 145 in the 95-module group,
// 5 in the 5-module group (e.g. `renderToolResultMessage` exported by three different members).
// Each member's own inline `export { ... }` clause previously survived verbatim in the merged
// body; two members exporting the same public name produced two competing top-level exports of
// that name — a SyntaxError the 7-module group (Step 6's target) never happened to exercise.
const META_DUPEXPORT = {
  '/g/a.js': { requires: [], exports: ['dup'], locals: ['x'] },
  '/g/b.js': { requires: [], exports: ['dup'], locals: ['y'] },
};
const SRC_DUPEXPORT = {
  '/g/a.js': 'const x = 1;\nexport{x as dup};\n',
  '/g/b.js': 'const y = 2;\nexport{y as dup};\n',
};
const metaDup = (n) => META_DUPEXPORT[n];

test("mergeGroup strips each member's own inline export clause so two members exporting the same public name do not collide", () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_DUPEXPORT, metaDup, 0);
  // Neither member's own bare export clause may survive verbatim — left in place, the merged
  // module would export "dup" twice from its top level: a SyntaxError.
  assert.doesNotMatch(r.mergedSource, /export\s*\{\s*x\s+as\s+dup\s*\}/,
    "member a's own export clause must not survive — it would duplicate the export merger emits");
  assert.doesNotMatch(r.mergedSource, /export\s*\{\s*y\s+as\s+dup\s*\}/,
    "member b's own export clause must not survive — it would duplicate the export merger emits");
  // The merger's OWN consolidated list still exposes both, under distinct mangled names — no
  // collision, because each is namespaced by member index.
  assert.match(r.mergedSource, /x as __m0_export_dup/);
  assert.match(r.mergedSource, /y as __m1_export_dup/);
});

// `export default` was measured absent from all three real groups, but nothing in this file's
// design rules it out for a future bundle. Rather than guess at how to name an anonymous
// default's local binding, refuse by name — an explicit, loud failure beats silently emitting a
// module that will not parse (or one that parses but exports the wrong thing).
const META_DEFAULT = {
  '/g/a.js': { requires: [], exports: ['default'], locals: [] },
  '/g/b.js': { requires: [], exports: ['bx'], locals: ['bx'] },
};
const SRC_DEFAULT = {
  '/g/a.js': 'export default 42;\n',
  '/g/b.js': 'export const bx = 1;\n',
};
const metaDefault = (n) => META_DEFAULT[n];

test('mergeGroup REFUSES a member that uses export default', () => {
  assert.throws(() => mergeGroup(['/g/a.js', '/g/b.js'], SRC_DEFAULT, metaDefault, 0),
    /scc-merge: \/g\/a\.js uses `export default`/);
});

// Discovered while checking finding 3 against the real 95-module group (not one of the review's
// three numbered findings, but the same class of bug: a name that LOOKS like an ordinary local
// reference but is actually a FIXED export-name reference, corrupted by the blind rename pass).
// `import { Yo } from "external"` (unaliased) uses the SAME token as both the fixed export name
// requested from "external" and the local binding introduced here. If "Yo" collides with some
// OTHER member's own declared name, the local half must rename — but the export-name half must
// not, or the import silently starts requesting an export that does not exist. No compile
// error either way: `import{__m1_Yo}from"external"` is syntactically valid, just wrong.
const META_EXTIMPORT = {
  '/g/a.js': { requires: [], exports: ['ax'], locals: ['Yo'] },
  '/g/b.js': { requires: [], exports: ['bx'], locals: ['Yo', 'bx'] },
};
const SRC_EXTIMPORT = {
  '/g/a.js': 'import{Yo}from"/g/external.js";\nexport const ax = Yo;\n',
  '/g/b.js': 'const Yo = 2;\nexport const bx = Yo;\n',
};
const metaExtImport = (n) => META_EXTIMPORT[n];

test('mergeGroup aliases a colliding imported name instead of renaming the fixed export-name half', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_EXTIMPORT, metaExtImport, 0);
  // The import must still request the real export "Yo" from the external, non-group module...
  assert.match(r.mergedSource, /import\s*\{\s*Yo\s+as\s+__m0_Yo\s*\}\s*from\s*"\/g\/external\.js"/,
    'the fixed export-name half ("Yo") must survive untouched; only the local half may rename');
  // ...and every reference to the (renamed) local binding must use the renamed form.
  assert.match(r.mergedSource, /const ax = __m0_Yo/);
  assert.doesNotMatch(r.mergedSource, /\{\s*__m0_Yo\s+as\s+__m0_Yo\s*\}/,
    'the export-name half must never itself be renamed — that would request a nonexistent export');
});

// Discovered on the real 95-module group, and independently on the coordinator's own group-95
// compile attempt ("expecting ';'"). `IMPORT_STMT_RES[0]`'s ORIGINAL regex required `import\s+`
// before the `{` — real minified code overwhelmingly writes `import{a,b}from"spec"` with ZERO
// whitespace there, so that regex never matched real cross-group imports at all: they survived
// untouched, still pointing at the member's ORIGINALLY-COMPILED (pre-merge) module rather than
// the merged scope. No compile error from this alone — it is a silently wrong build — but it is
// also the class of bug that, combined with other survivors, produced literal parse failures on
// the 95-module group.
const META_NOSPACE = {
  '/g/a.js': { requires: ['/g/b.js'], exports: ['ax'], locals: ['FO', 'oe', 'ax'] },
  '/g/b.js': { requires: [], exports: ['FO', 'oe'], locals: ['FO', 'oe'] },
};
const SRC_NOSPACE = {
  '/g/a.js': 'import{FO,oe}from"/g/b.js";\nexport const ax = FO() + oe;\n',
  '/g/b.js': 'function FO(){return 1}\nconst oe = 2;\nexport{FO,oe};\n',
};
const metaNoSpace = (n) => META_NOSPACE[n];

test('mergeGroup converts a zero-whitespace cross-group `import{...}from"spec"` statement', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_NOSPACE, metaNoSpace, 0);
  assert.doesNotMatch(r.mergedSource, /import\s*\{[^}]*\}\s*from\s*"\/g\/b\.js"/,
    'the cross-group import statement must not survive — it would resolve to the wrong module');
  assert.match(r.mergedSource, /FO\s*=\s*__clode_scc_ns1\.FO/);
  assert.match(r.mergedSource, /oe\s*=\s*__clode_scc_ns1\.oe/);
});

// Discovered on the real 95-module group: `class C { #e = 1 }` reports its private field as
// `#e` (hash included) in `meta.locals`. Private fields are scoped PER CLASS — two unrelated
// classes' `#e` cannot collide by JS semantics even with the identical name — and `#` is not an
// identifier character, so renaming it the ordinary way produces `__mK_#e`, a SyntaxError
// (`Unexpected identifier '#e'`).
const META_PRIVATE = {
  '/g/a.js': { requires: [], exports: ['ax'], locals: ['#e', 'ax'] },
  '/g/b.js': { requires: [], exports: ['bx'], locals: ['#e', 'bx'] },
};
const SRC_PRIVATE = {
  '/g/a.js': 'class A { #e = 1; get() { return this.#e; } }\nexport const ax = new A().get();\n',
  '/g/b.js': 'class B { #e = 2; get() { return this.#e; } }\nexport const bx = new B().get();\n',
};
const metaPrivate = (n) => META_PRIVATE[n];

test('declaredNames drops private class field/method names', () => {
  assert.deepStrictEqual([...declaredNames(META_PRIVATE['/g/a.js'])].sort(), ['ax']);
});

test('mergeGroup never renames a private class field even when the SAME private name appears in two members', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_PRIVATE, metaPrivate, 0);
  assert.doesNotMatch(r.mergedSource, /__m\d+_#/,
    'a private name must never be prefixed — that is not valid JS syntax');
  assert.match(r.mergedSource, /class A \{ #e = 1;/);
  assert.match(r.mergedSource, /class B \{ #e = 2;/);
});

// Discovered on the real 95-module group, in two stages. First: a colliding LOCAL name ("as")
// is ALSO literally the "as" KEYWORD inside a completely unrelated aliased import elsewhere in
// the SAME member (`import{types as UIe}from"util"`) — blindly renaming every "as" token broke
// that import's syntax (`Unexpected identifier '__m7_as'`). The over-correction — excluding
// "as"/"from" from rename ENTIRELY — broke the other way just as fast: the real bundle has a
// genuine top-level `function as(e){...}` in one member that collides for real with another
// member's own top-level `as`, and leaving BOTH un-renamed re-declares "as" twice in the merged
// scope (`Identifier 'as' has already been declared`). Only per-position protection — rename
// "as" the identifier, never "as" the keyword — satisfies both real cases at once, which is
// what `protectImportedExportNames` now does.
const META_AS_COLLISION = {
  '/g/a.js': { requires: [], exports: ['ax'], locals: ['as', 'UIe'] },
  '/g/b.js': { requires: [], exports: ['bx'], locals: ['as', 'bx'] },
};
const SRC_AS_COLLISION = {
  '/g/a.js': 'function as(e){return e+1}\nimport{types as UIe}from"util";\nexport const ax = as(1) + UIe;\n',
  '/g/b.js': 'const as = 2;\nexport const bx = as;\n',
};
const metaAsCollision = (n) => META_AS_COLLISION[n];

test('mergeGroup renames a genuinely colliding "as" declaration while leaving the "as" keyword untouched', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC_AS_COLLISION, metaAsCollision, 0);
  // The unrelated aliased import must survive completely untouched — "as" here is pure syntax.
  assert.match(r.mergedSource, /import\{types as UIe\}from"util"/,
    'an unrelated aliased import must never have its `as` keyword touched');
  // Both members' OWN top-level "as" bindings must rename independently, or they collide once
  // merged into the same scope.
  assert.match(r.mergedSource, /function __m0_as\(e\)/);
  assert.match(r.mergedSource, /const __m1_as = 2/);
  assert.doesNotMatch(r.mergedSource, /\bfunction as\(|(?<![A-Za-z0-9_$])const as = /,
    'the genuinely colliding declarations must not survive under the un-renamed name');
});
