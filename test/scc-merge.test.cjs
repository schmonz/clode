'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeGroup, declaredNames, assertNoRenamedFixedNames } = require('../libexec/scc-merge.cjs');

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
  // A cross-member NAMED import becomes a direct reference to the other member's binding — a
  // live binding, as ESM specifies — not `const FO = ns1.FO`. An eager copy would read ns1 at
  // the top of this member's body and so demand that member 1 run first, which in a CYCLE cannot
  // always be arranged: 566 such forward reads survived every possible body order on real
  // 2.1.250, and the target died with `__m42_yD is not initialized`.
  assert.match(r.mergedSource, /const ax = __m1_FO\(\) \+ __m1_oe;/,
    "member a's uses must point straight at member b's bindings");
  assert.doesNotMatch(r.mergedSource, /=\s*__clode_scc_ns1\.(FO|oe)/,
    'no eager cross-member read may remain');
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

// ---------------------------------------------------------------------------------------
// Review fix round 2. This merger is loaded BY node-shim under tjs, and node-shim rewrites
// its dynamic-import operator — the keyword immediately followed by an open paren — to
// `__tjsDynImport(` in every CJS file it evaluates, blind to string and regex literals
// (`DYN_IMPORT_RE` in libexec/node-shim/loader.cjs). Every pattern here that matches an
// import STATEMENT had exactly that shape, so under tjs three of them loaded mangled and
// silently never matched, while every test in this file kept passing under node.
//
// What that cost on the real 2.1.250 graph: the 95-module group failed to compile with
// `Unexpected identifier '__m7_as'` (an `as` KEYWORD renamed as if it were a binding,
// because the import-clause protection was one of the dead patterns), and the 5- and
// 7-module groups merged to different, WRONG bytes than node produced with NO error at all
// (`import{wt,ac}from"…"` became `import{__m0_wt,__m0_ac}` — export names that do not
// exist). Unit tests that only ever run under node cannot see any of this, so these tests
// load the merger through the loader's OWN transform, read out of loader.cjs so the two
// files cannot drift apart silently.
const fs = require('node:fs');
const path = require('node:path');
const LOADER_PATH = path.join(__dirname, '..', 'libexec', 'node-shim', 'loader.cjs');
const MERGER_PATH = path.join(__dirname, '..', 'libexec', 'scc-merge.cjs');

function shimDynImportTransform() {
  const loaderSrc = fs.readFileSync(LOADER_PATH, 'utf8');
  const reSrc = /^const DYN_IMPORT_RE = (\/.*\/[a-z]*);$/m.exec(loaderSrc);
  const replSrc = /\.replace\(DYN_IMPORT_RE, '([^']*)'\)/.exec(loaderSrc);
  assert.ok(reSrc, 'loader.cjs no longer declares DYN_IMPORT_RE where this test reads it');
  assert.ok(replSrc, 'loader.cjs no longer applies DYN_IMPORT_RE where this test reads it');
  const re = new Function('return ' + reSrc[1])();
  return (src) => src.replace(re, replSrc[1]);
}

// The cheap ratchet: the transform must be a NO-OP on this file. If anyone writes the
// import keyword next to an open paren again — in code, a string, a regex, or even a
// comment — this fails immediately and by name, instead of the merger going quietly wrong
// on one engine only.
test("node-shim's CJS text transforms are all no-ops on libexec/scc-merge.cjs", () => {
  const src = fs.readFileSync(MERGER_PATH, 'utf8');
  assert.strictEqual(shimDynImportTransform()(src), src,
    'scc-merge.cjs must never contain the import keyword adjacent to `(` — node-shim rewrites '
    + 'that text everywhere, including inside this file\'s own import-matching regexes');

  // The loader's other two transforms would be just as destructive to a file whose whole job
  // is carrying import/export syntax as data, so pin them here too rather than waiting for a
  // second engine-only failure. `esmToCjs` fires on `esmDetect` — a line that STARTS with
  // `import`/`export` — which a future pattern written across lines could trip.
  const loaderSrc = fs.readFileSync(LOADER_PATH, 'utf8');
  const detectSrc = /function esmDetect\(src\) \{[\s\S]*?\n\}/.exec(loaderSrc);
  assert.ok(detectSrc, 'loader.cjs no longer declares esmDetect where this test reads it');
  const esmDetect = new Function('return (' + detectSrc[0] + ')')();
  assert.strictEqual(esmDetect(src), false,
    'scc-merge.cjs must not look like an ES module to node-shim, or the loader rewrites it '
    + 'through esmToCjs before evaluating it');

  // `fixVFlagPropertyEscapes` rewrites regex literals, and gates entirely on the source
  // containing a Unicode property escape. Keeping this file free of them keeps that
  // transform from ever looking at its patterns at all.
  assert.ok(src.indexOf('\\p{') === -1 && src.indexOf('\\P{') === -1,
    'a Unicode property escape here would expose this file\'s regex literals to the loader\'s '
    + 'v-flag rewrite');
});

// Load the merger the way tjs actually loads it, and re-run the two cases whose guards live
// inside the affected patterns.
function loadMergerAsShimDoes() {
  const src = shimDynImportTransform()(fs.readFileSync(MERGER_PATH, 'utf8'));
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require);
  assert.strictEqual(typeof mod.exports.mergeGroup, 'function',
    'the shim-transformed merger must still export mergeGroup');
  return mod.exports;
}

test('the "as" KEYWORD survives when the merger is loaded through the shim transform', () => {
  const shimMerge = loadMergerAsShimDoes().mergeGroup;
  const r = shimMerge(['/g/a.js', '/g/b.js'], SRC_AS_COLLISION, metaAsCollision, 0);
  assert.match(r.mergedSource, /import\{types as UIe\}from"util"/,
    'the `as` keyword of an unrelated aliased import must survive the shim transform — '
    + 'this is the exact `Unexpected identifier \'__m7_as\'` the 95-module group hit');
  assert.doesNotMatch(r.mergedSource, /types\s+__m\d+_as\s/,
    'the `as` keyword must never be renamed as if it were a binding');
  // The genuine bindings must still rename, or the two members redeclare `as` in one scope.
  assert.match(r.mergedSource, /function __m0_as\(e\)/);
  assert.match(r.mergedSource, /const __m1_as = 2/);
});

test('a property access is still not renamed when the merger is loaded through the shim transform', () => {
  const shimMerge = loadMergerAsShimDoes().mergeGroup;
  const r = shimMerge(['/g/a.js', '/g/b.js'], SRC_PROP, metaProp, 0);
  assert.match(r.mergedSource, /obj\.shared\s*=\s*__m1_shared/);
  assert.doesNotMatch(r.mergedSource, /obj\.__m1_shared/,
    'a name after `.` is a property access, never a lexical binding');
});

// The other half of what the mangled patterns broke, and the half that produced NO error at
// all: a colliding named import must be split into an explicit `imported as __mK_local`
// alias. Un-aliased, the rename pass rewrites the whole token — turning the fixed EXPORT
// name into one the exporting module does not have. Measured verbatim on the real 5-module
// group under tjs: `import{wt,ac}from"…"` -> `import{__m0_wt,__m0_ac}from"…"`.
const META_ALIAS_SHIM = {
  '/g/a.js': { requires: [], exports: ['ax'], locals: ['wt', 'ax'] },
  '/g/b.js': { requires: [], exports: ['bx'], locals: ['wt', 'bx'] },
};
const SRC_ALIAS_SHIM = {
  '/g/a.js': 'import{wt}from"/outside/dep.js";\nexport const ax = wt;\n',
  '/g/b.js': 'const wt = 2;\nexport const bx = wt;\n',
};
const metaAliasShim = (n) => META_ALIAS_SHIM[n];

test('a colliding named import keeps its real export name when loaded through the shim transform', () => {
  const shimMerge = loadMergerAsShimDoes().mergeGroup;
  const r = shimMerge(['/g/a.js', '/g/b.js'], SRC_ALIAS_SHIM, metaAliasShim, 0);
  assert.match(r.mergedSource, /import\{wt as __m0_wt\}from"\/outside\/dep\.js"/,
    'the imported half must stay `wt` — renaming it requests an export that does not exist');
  assert.doesNotMatch(r.mergedSource, /import\{__m0_wt\}/,
    'this is the silent, error-free corruption the shim transform caused on the real group');
});

// THE ORDERING COUPLING, and it is load-bearing. bun-graph-plan.cjs's depsOf() is the only
// thing that knows what a module depends on, so it is what planOrder — and therefore the fuse
// worker's compile order — is computed from. It matches `import` forms ONLY: a shim written as
// `export { ... } from "<merged>"` reads as dependency-free, planOrder is free to place it
// BEFORE the merged module, and the build dies with
// `could not load '/$bunfs/root/__clode-scc-0.js'`. Measured on the first real 2.1.248 build.
// Asserted here against the REAL depsOf so the two files cannot drift apart silently.
const { depsOf } = require('../libexec/bun-graph-plan.cjs');

test("depsOf sees each shim's dependency on the merged module", () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  const inGraph = (s) => s === r.mergedName;
  for (const name of Object.keys(r.shims)) {
    assert.deepStrictEqual(depsOf(r.shims[name], inGraph), [r.mergedName],
      `the shim for ${name} must read as depending on ${r.mergedName}`);
  }
});

// A member with no exports of its own still has to force the merged module's evaluation: its
// BODY moved in there, and whoever imported this module for its side effects alone would
// otherwise get an inert shim and none of the effects.
test('a shim for an export-less member still imports the merged module', () => {
  const SRC2 = { '/g/a.js': 'globalThis.hit = 1;\n' };
  const META2 = { '/g/a.js': { requires: [], exports: [], locals: [] } };
  const r = mergeGroup(['/g/a.js'], SRC2, (n) => META2[n], 3);
  assert.match(r.shims['/g/a.js'], /import "\/\$bunfs\/root\/__clode-scc-3\.js"/);
  assert.deepStrictEqual(depsOf(r.shims['/g/a.js'], (s) => s === r.mergedName), [r.mergedName]);
});

// The namespace objects must be declared BEFORE any member body and read their values LAZILY.
// A residual cyclic require becomes a bare `nsJ` reference inside a body, and J can be any
// member — including one whose body has not run yet. Declaring the objects at the bottom made
// the real 2.1.250 target die on `ReferenceError: __clode_scc_ns5 is not initialized`; declaring
// them at the top with plain values would instead read every member's locals inside their own
// dead zone. Only hoisted + lazy is correct.
test('namespace objects are declared before every body, with getters', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  const firstNs = r.mergedSource.indexOf('const __clode_scc_ns0 = {');
  const lastNs = r.mergedSource.indexOf('const __clode_scc_ns1 = {');
  assert.ok(firstNs >= 0 && lastNs >= 0, 'both namespace objects are declared');
  // Every member body comes after the last namespace declaration.
  assert.ok(r.mergedSource.indexOf('const __m0_shared') > lastNs,
    'member bodies must follow the namespace declarations');
  assert.match(r.mergedSource, /const __clode_scc_ns0 = \{ get "ay"\(\) \{ return ay; \} \};/,
    'namespace properties must be getters, so they read the local at USE time');
});

// A SPREAD/REST reference is a binding reference whose preceding character happens to be `.`.
// The flat `(?<!\.)` property guard silently refused to rename it, so the declaration became
// `__m0_shared` while `{...shared}` kept pointing at a name that no longer existed — the real
// 2.1.250 target died with `ReferenceError: FO is not defined`, 5621 such references across the
// three groups. Property access and optional chaining must STILL be excluded.
test('mergeGroup renames a colliding name used in a spread, but not as a property', () => {
  const SRC3 = {
    '/g/a.js': 'const shared = { x: 1 };\nexport const ay = { ...shared, y: obj.shared, z: obj?.shared };\n',
    '/g/b.js': 'const shared = 2;\nexport const bx = shared;\n',
  };
  const META3 = {
    '/g/a.js': { requires: [], exports: ['ay'], locals: ['shared', 'ay'] },
    '/g/b.js': { requires: [], exports: ['bx'], locals: ['shared', 'bx'] },
  };
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC3, (n) => META3[n], 0);
  assert.match(r.mergedSource, /\.\.\.__m0_shared/, 'a spread reference must be renamed');
  assert.doesNotMatch(r.mergedSource, /\.\.\.shared\b/, 'no un-renamed spread may survive');
  assert.match(r.mergedSource, /obj\.shared/, 'a property access must NOT be renamed');
  assert.match(r.mergedSource, /obj\?\.shared/, 'optional chaining must NOT be renamed');
});

// PROPERTY KEYS ARE NOT BINDING REFERENCES, and the real 2.1.250 linux-x64 graph proved it the
// expensive way. `set` is a top-level binding in one member of the 95-module group and a
// property KEY in another — `function i6t(){let e;return{set:(t)=>{e=t},get:()=>e}}` — so the
// collision rename rewrote the KEY: `{__m29_set:(t)=>{e=t},get:()=>e}`. It compiles, it boots,
// and then the first caller of that slot dies with `TypeError: not a function` at
// `t.installed.set(r)`, five frames from anything that names the merger. 367 property keys were
// renamed in that one group (336 in the darwin-arm64 graph, which happened not to call any of
// them during the build's own smoke — a passing build is not evidence here).
//
// The `.` guard only ever covered `obj.shared`. Every OTHER position where an identifier is a
// fixed NAME rather than a value read was unguarded: object-literal keys and methods, accessor
// names, class member names, and object-literal SHORTHAND (which is both at once).
const KEY_SRC = {
  '/g/a.js': [
    'const set = 1;',
    'const inner = 2;',
    'function slot(){ let v; return { set: (x) => { v = x; }, get: () => v }; }',
    'class Bag { m(){} set(k, x){ return k; } inner = 3; }',
    'const lit = { set(k, x){ return k; }, get inner(){ return 1; }, plain: set };',
    'const short = { set, inner };',
    'const tern = cond ? set : inner;',
    'export const ay = [slot, Bag, lit, short, tern];',
  ].join('\n'),
  '/g/b.js': 'const set = 3;\nconst inner = 4;\nexport const bx = set + inner;\n',
};
const KEY_META = {
  '/g/a.js': { requires: [], exports: ['ay'], locals: ['set', 'inner', 'slot', 'Bag', 'lit', 'short', 'tern', 'ay'] },
  '/g/b.js': { requires: [], exports: ['bx'], locals: ['set', 'inner', 'bx'] },
};
const keyMerge = () => mergeGroup(['/g/a.js', '/g/b.js'], KEY_SRC, (n) => KEY_META[n], 0).mergedSource;

test('mergeGroup does not rename a colliding name used as an object-literal property key', () => {
  const s = keyMerge();
  assert.match(s, /return \{ set: \(x\) => \{ v = x; \}, get: \(\) => v \};/,
    'the KEY `set:` names a property, not the binding — renaming it silently moves the property');
  assert.doesNotMatch(s, /\{ __m0_set:/);
});

test('mergeGroup does not rename a colliding name used as an object-literal method name', () => {
  const s = keyMerge();
  assert.match(s, /\{ set\(k, x\)\{ return k; \}/, 'a method name is a property key too');
  assert.doesNotMatch(s, /__m0_set\(k, x\)/);
});

test('mergeGroup does not rename a colliding name used as an accessor name', () => {
  const s = keyMerge();
  assert.match(s, /get inner\(\)\{ return 1; \}/, '`get inner(){}` names the property `inner`');
  assert.doesNotMatch(s, /get __m0_inner\(\)/);
});

test('mergeGroup does not rename a colliding name used as a class member name', () => {
  const s = keyMerge();
  assert.match(s, /class Bag \{ m\(\)\{\} set\(k, x\)\{ return k; \} inner = 3; \}/,
    'class methods and fields are property names, not module bindings');
});

// Both at once: `{ set }` means `{ set: set }`. The KEY must not move and the VALUE must follow
// its renamed binding, so the only correct rewrite is to make the pair explicit.
test('mergeGroup expands a colliding object-literal shorthand rather than renaming the key', () => {
  const s = keyMerge();
  assert.match(s, /const short = \{ set: __m0_set, inner: __m0_inner \};/);
  assert.doesNotMatch(s, /\{ __m0_set, __m0_inner \}/);
});

// The guard must not overreach: a `:` also ends a ternary's consequent and a `case` clause, and
// those ARE value reads.
test('mergeGroup still renames a colliding name read as a ternary consequent', () => {
  const s = keyMerge();
  assert.match(s, /const tern = cond \? __m0_set : __m0_inner;/);
});

test('mergeGroup renames the VALUE half of an explicit property, only the key is fixed', () => {
  const s = keyMerge();
  assert.match(s, /plain: __m0_set \}/, 'the value half of `plain: set` is a real binding read');
});

// A statement LABEL lives in its own namespace — it is never a binding, so renaming one is never
// needed, and renaming only HALF of one (the definition but not `break`/`continue`, or the
// reverse) is a syntax error. Protecting both halves is also what lets the property-key rule be
// stated without any bracket classification at all: `{ e: for(;;){} }` in a BLOCK is otherwise
// indistinguishable from a mis-classified object literal.
test('mergeGroup renames neither a statement label nor its break/continue references', () => {
  const SRCL = {
    '/g/a.js': 'const set = 1;\nfunction f(){ set: for (const x of [set]) { if (x) break set; else continue set; } }\nexport const ay = f;\n',
    '/g/b.js': 'const set = 2;\nexport const bx = set;\n',
  };
  const METAL = {
    '/g/a.js': { requires: [], exports: ['ay'], locals: ['set', 'f', 'ay'] },
    '/g/b.js': { requires: [], exports: ['bx'], locals: ['set', 'bx'] },
  };
  const s = mergeGroup(['/g/a.js', '/g/b.js'], SRCL, (n) => METAL[n], 0).mergedSource;
  assert.match(s, /set: for \(const x of \[__m0_set\]\)/, 'the label stays, the array element is a read');
  assert.match(s, /break set;/);
  assert.match(s, /continue set;/);
  assert.doesNotMatch(s, /break __m0_set|continue __m0_set|__m0_set: for/);
});

// THE RATCHET. `--help` passed, and so did the build's own PONG smoke on the darwin-arm64 graph,
// while 336 property keys sat renamed in the merged module. Nothing looked at the output.
test('the merge is re-checked for renamed fixed names, and says so by name', () => {
  assert.throws(
    () => assertNoRenamedFixedNames('const o = { __m3_set: 1 };\n', 7),
    /scc-merge: group 7 renamed __m3_set into a property-key\/label position/);
  // Not a property key: a ternary and a `case` clause both put a real reference before a `:`.
  assert.doesNotThrow(() => assertNoRenamedFixedNames('const v = c ? __m0_set : __m1_set;\n', 0));
  assert.doesNotThrow(() => assertNoRenamedFixedNames('switch (x) { case __m0_set: break; }\n', 0));
  // Nor is text inside a string literal.
  assert.doesNotThrow(() => assertNoRenamedFixedNames('const s = "{ __m0_set: 1 }";\n', 0));
});

// A `{` right after a `:` is normally a nested object literal — but it is a BLOCK when the `:`
// ends a `case`/`default` clause or a label. Reading `case "u": { let t = s, l = ... }` as an
// object makes `l =` look like a shorthand entry with a default, and expanding that emits
// `let t = s, l: l = ...` — a SyntaxError. The real linux-x64 95-module group has this exact
// shape (`case"uds":{let t=s.session,l=n&&...}`).
test('mergeGroup reads a case-clause body as a block, not an object literal', () => {
  const SRCC = {
    '/g/a.js': [
      'const l = 1;',
      'function f(s){ switch (s) { case "u": { let t = s, l = t && 2; return [t, l]; } } }',
      'export const ay = [l, f];',
    ].join('\n'),
    '/g/b.js': 'const l = 2;\nexport const bx = l;\n',
  };
  const METAC = {
    '/g/a.js': { requires: [], exports: ['ay'], locals: ['l', 'f', 'ay'] },
    '/g/b.js': { requires: [], exports: ['bx'], locals: ['l', 'bx'] },
  };
  const s = mergeGroup(['/g/a.js', '/g/b.js'], SRCC, (n) => METAC[n], 0).mergedSource;
  assert.match(s, /let t = s, __m0_l = t && 2; return \[t, __m0_l\];/);
  assert.doesNotMatch(s, /l: /, 'a declaration list is not an object literal');
});
