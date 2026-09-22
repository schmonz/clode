'use strict';
// THE MASK MUST NOT CALL FIXED SYNTAX RENAMEABLE.
//
// `libexec/scc-merge.cjs` renames colliding top-level bindings by text substitution, and the
// ONLY thing standing between that substitution and a token it must not touch is `codeMask`:
// 1 means "ordinary code, safe to rewrite", 0 means "leave verbatim". FIVE positions in real
// upstream bundles hold a token that LOOKS like an identifier and is not one:
//
//   \u{b5}s:1000n            ->  \__m28_u{b5}s:1000n        a unicode escape inside an identifier
//   static get rules(){      ->  static __m28_get rules(){   a member's modifier chain
//   get[Symbol.toStringTag](){  ->  __m0_get[Symbol…](){     a modifier before a COMPUTED name
//   async*iterPages(){       ->  __m0_async*iterPages(){     a modifier before a GENERATOR star
//   static{Object.define…    ->  __m0_static{Object.define…  a class static-INITIALIZATION block
//
// The mask called all five 1. The first two merged to a file that is not valid JS in ANY engine
// (QuickJS: "invalid property name"; node --check: "Invalid or unexpected token"), and both were
// live in the wild — they are why UPSTREAM_PIN sat 27 versions behind on claude-code 2.1.251.
// The other three were found by review on 2026-09-22 and are worse than latent: the pinned
// carve's ALREADY-MERGED `__clode-scc-2.js` holds 16 `get[__m1_yt](){…}` getters, and
// `__clode-scc-1.js` holds 2 `async*` members AND declares top-level `var get` / `var set`.
// Only which module landed in which group was keeping the build alive.
//
// The defect was never about which version upstream shipped, so neither is this gate: it reads
// the pinned carve's module sources through the REAL mask and asks whether any of the five
// positions is renameable anywhere in them, merged or not.
//
// WHY A GATE AND NOT ONLY THE CARVE. Proving this end to end costs a 218MB provider download
// and an engine, which the normal suite has neither of. The mask does not: it is a pure
// function of text, the real corpus is already on disk from the pinned carve, and all five
// positions are decidable from the mask's own output.
//
// ONE `defineGuard` PER POSITION, and that is the correction of a real defect in this file's
// first cut (review FINDING 4). It registered ONE guard whose control returned two synthetic
// sources and whose `checkControl` asked only "did the scan produce ≥1 finding" — so
// short-circuiting EITHER detector left the whole file at `tests 5 / pass 5 / fail 0`, control
// included: the corpus is clean, and the surviving detector carried the control for both. An
// aggregate control lets a detector be deleted silently. Five registrations, five controls,
// five floors. "Found nothing" must differ from "examined nothing", and so must "half of me
// is dead".
//
// The literal relative require below is load-bearing for test/guards-population.cjs's control
// mapping, which derives "which guard controls this production gate" by reading that exact
// string out of this file's source — same trick as the sibling guard next door.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codeMask } = require('../../libexec/scc-merge.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { pinnedVersion } = require('../provider-resolve.cjs');

// ---- the repros, transcribed verbatim from the real carves ---------------------------------
//
// VERDICT (recorded 2026-09-22, BEFORE each fix): every one of these FAILED — `mask[idx]` was
// 1, not 0. These are regression tests now: each goes red again if the reading that protects
// it is removed or narrowed.

test('the `u` of a \\u{...} escape is not a renameable identifier', () => {
  // chunk-1kg58a1a.js of the 2.1.257 darwin-arm64 carve, which also declares a real top-level
  // `u` — so `u` was genuinely in that group's collision set and genuinely got rewritten.
  const src = 'Object.freeze({ns:1n,us:1000n,\\u{b5}s:1000n,ms:1000n*1000n})';
  const mask = codeMask(src);
  const esc = src.indexOf('\\u{b5}');
  assert.strictEqual(mask[esc + 1], 0,
    'the `u` of an escape is part of the identifier it spells, not the identifier `u` — '
    + 'renaming it emits `\\__m28_u{b5}s`, which no engine parses');
  assert.strictEqual(mask[esc + 6], 0,
    'and neither is the `s` after it: masking only the escape would still let a colliding '
    + '`s` move, producing a valid identifier that names the wrong thing');
  // The bytes around it stay renameable — this must not become "protect the neighbourhood".
  // (The `ns:`/`us:` keys beside it are masked 0 too, but for the older, unrelated reason that
  // they are property keys; `Object` is an ordinary reference and must stay visible.)
  assert.strictEqual(mask[src.indexOf('Object')], 1,
    'an ordinary reference in the same statement is still code the mask can see');
});

test('the `get` of `static get rules()` is not a renameable identifier', () => {
  // The same chunk, which also declares a real top-level `function get(e="api"){…}`.
  const src = 'class T{constructor(n){this.tokenizer.rules=n}static get rules(){return{block:uhe,inline:aee}}}';
  const mask = codeMask(src);
  assert.strictEqual(mask[src.indexOf('static get')], 0, '`static` is a member modifier here');
  assert.strictEqual(mask[src.indexOf('get rules')], 0,
    '`get` is a member modifier here — `static __m28_get rules(){` puts two identifiers side '
    + 'by side, which no JS grammar allows');
  assert.strictEqual(mask[src.indexOf('rules(){')], 0, 'and `rules` is the member NAME');
});

test('a modifier before a COMPUTED member name is not a renameable identifier', () => {
  // chunk-5qexfphn.js (class) and chunk-8n46n48n.js (object literal) of the pinned 2.1.251
  // carve. 42 such sites; 16 of them are inside the already-merged `__clode-scc-2.js`.
  const cls = 'class T{toString(){return this.s}static[Symbol.hasInstance](e){return!0}}';
  assert.strictEqual(codeMask(cls)[cls.indexOf('static[')], 0,
    '`__m0_static[Symbol.hasInstance](e){` — node --check: Unexpected token \'[\'');
  const obj = 'var o={get["async"](){return this[ot]},set["async"](t){this[ot]=!!t}};';
  assert.strictEqual(codeMask(obj)[obj.indexOf('get[')], 0, 'the same in an object literal');
  assert.strictEqual(codeMask(obj)[obj.indexOf('set[')], 0, 'and for `set`');
  // A computed class FIELD, which has no parameter list to confirm: chunk-n8jhg568.js.
  const fld = 'class E extends Array{static[Symbol.species]=Array;overflow=0}';
  assert.strictEqual(codeMask(fld)[fld.indexOf('static[')], 0, 'a computed static field too');
});

test('a modifier before a GENERATOR star is not a renameable identifier', () => {
  // chunk-92vbp1ze.js of the pinned carve; 28 such sites, all `async*`, none multiplication.
  const m = 'class P{constructor(e){this.e=e}async*iterPages(){let e=this;yield e}}';
  assert.strictEqual(codeMask(m)[m.indexOf('async*')], 0,
    '`__m0_async*iterPages(){` — node --check: Unexpected token \'*\'');
  // The computed-name form, with a sequence expression inside the brackets — also real.
  const c = 'class P{stop(){}async*[(xr=new WeakMap,Symbol.asyncIterator)](){yield 1}}';
  assert.strictEqual(codeMask(c)[c.indexOf('async*')], 0, 'a computed generator name too');
  assert.strictEqual(codeMask('class C{static*m(){}}')['class C{'.length], 0,
    '`static*` is the other modifier a generator may carry');
});

test('`static{…}`, a class static-initialization block, is not a renameable identifier', () => {
  // chunk-25pekgrs.js of the pinned carve; 17 such sites, all in class bodies.
  const src = 'var Tx=class e extends Error{static{Object.defineProperty(this,"mcpBrand",{value:1})}};';
  assert.strictEqual(codeMask(src)[src.indexOf('static{')], 0,
    '`__m0_static{Object.define…` — node --check: Unexpected token \'{\'');
});

test('two brace-opening contexts `braceKind` could not read', () => {
  // Review FINDING 6. Both UNDER-protect, which is the safe direction — but for a plain object
  // METHOD NAME (not a modifier) neither this gate nor `assertNoRenamedFixedNames` can see the
  // consequence: the merged module parses and reads the wrong property, the 2.1.250 class.
  const spread = 'var o={...{m(){return 1}},b:2};';           // 40 sites in the pinned carve
  assert.strictEqual(codeMask(spread)[spread.indexOf('m(')], 0,
    '`...{` spreads an OBJECT literal — `...` is only ever followed by an expression');
  const interp = 'var s=`${{m(){return 1}}}`;';               // 0 sites today
  assert.strictEqual(codeMask(interp)[interp.indexOf('m(')], 0,
    'a `${` interpolation holds an Expression, so a `{` starting one is an object');
});

// ---- the converse: what must STILL rename --------------------------------------------------

test('a real binding spelled like a modifier is still renameable', () => {
  // The reason no fix here may be a blanket word exclusion: a member can declare a genuine
  // top-level `get`/`set`/`async`/`static`, two members' copies collide, and leaving both alone
  // re-declares the name in the merged scope. Same argument the file's `as`/`of` comments make.
  const src = 'var get=1,set=2;export const x=get+set;';
  const mask = codeMask(src);
  assert.strictEqual(mask[src.indexOf('get=1')], 1);
  assert.strictEqual(mask[src.indexOf('get+set')], 1);
  assert.strictEqual(mask[src.indexOf('set=2')], 1);
});

test('the converse that can actually fail: inside an object or class, and narrowly declined', () => {
  // REVIEW FINDING 3. The test above is entirely top-level (`block` enclosure), where the
  // member-modifier rule never runs at all — so it cannot fail for any change to what landed.
  // These can. Every one sits where the new rules DO run, and asserts the narrowing that keeps
  // them from refusing a real rename. Widen any of them and a row here goes red.
  const ref = 'var o={a:get,b:set*2,c:async[0],d:static};';
  const m1 = codeMask(ref);
  for (const tok of ['get,', 'set*2', 'async[0', 'static}']) {
    assert.strictEqual(m1[ref.indexOf(tok)], 1,
      `a modifier WORD used as a value inside an object literal must still rename (${tok})`);
  }
  // A labelled block as the first statement of a block is left reading as an OBJECT — the gap
  // `propertyNames`' own comment names. Inside it, every member-start position is a genuine
  // expression, and the tail confirmations are what decline them.
  const lbl = 'function f(){lbl:{get[0](x)}}';
  assert.strictEqual(codeMask(lbl)[lbl.indexOf('get[')], 1,
    '`get[0](x)` has no `(…){` tail, so it is indexing-then-calling, not a computed member');
  const mul = 'function f(){lbl:{async*2}}';
  assert.strictEqual(codeMask(mul)[mul.indexOf('async*')], 1,
    'nothing that can be a member name follows the star, so this is multiplication');
  const gen = 'function f(){lbl:{get*2}}';
  assert.strictEqual(codeMask(gen)[gen.indexOf('get*')], 1,
    'a getter can never BE a generator, so `get*` is multiplication wherever it appears — '
    + 'this is the one the previous pass was right to decline');
  const blk = 'function f(){lbl:{static{}}}';
  assert.strictEqual(codeMask(blk)[blk.indexOf('static{')], 1,
    'a static-init block exists only in a CLASS body, so this reading is declined outside one');
  const fn = 'async function*n(){yield 1}';
  assert.strictEqual(codeMask(fn)[fn.indexOf('n(')], 1,
    'the NAME of a generator function declaration is a real binding and must rename');
  //
  // WHAT REMAINS UNCOVERED, in this direction, and it is the only false protection the whole
  // change can produce. In that same mis-classified labelled block, the ORIGINAL modifier rule
  // (modifier + whitespace + identifier) has no tail to confirm, so `function f(){lbl:{get in x}}`
  // now masks `get` 0 where 6032f77 masked it 1: the declaration would rename and this
  // reference would not, and the merged module would parse and read the wrong binding.
  // `assertNoRenamedFixedNames` cannot see this direction at all — it only catches names the
  // merger DID rename. Zero occurrences in the pinned corpus (measured); filed in BACKLOG.md.
  // The same is true of an escaped BINDING (`var u=1;…`), which now never renames while
  // plain references to it still do.
});

// ---- the detectors -------------------------------------------------------------------------

// The words that can stand in front of a class or object member's name. Read out of the
// production module's own text rather than restated here: a fifth one added there and not here
// would leave this guard quietly blind to it, which is the one failure mode a hand-copied list
// always eventually has. (Reading the SET rather than importing it keeps the production
// module's export surface unchanged — `MEMBER_MODIFIER` is an internal, and making it one more
// export to serve a test is the seam this repo has already paid for twice.)
function memberModifiers() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'libexec', 'scc-merge.cjs'), 'utf8');
  const m = /var MEMBER_MODIFIER = new Set\(\[([^\]]*)\]\)/.exec(src);
  if (!m) {
    throw new Error('renameable-positions: libexec/scc-merge.cjs no longer declares '
      + '`var MEMBER_MODIFIER = new Set([...])`, so this guard cannot derive which words it '
      + 'must check. Re-point the derivation at wherever the set moved — do NOT paste a copy '
      + 'of the list here, which is how this guard would go silently blind to a fifth word.');
  }
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const MODIFIERS = memberModifiers();
const MOD_ALT = MODIFIERS.join('|');
const NOT_AFTER = '(?<![A-Za-z0-9_$.])';

// Each detector is a DIFFERENT reading of the text from the one `propertyNames` used to decide
// the mask — that is the property that makes this a check rather than a restatement. None of
// them consults a brace kind or an enclosure stack.
//
//  (a) THE ESCAPE. A backslash in code — outside every string, template, regex and comment —
//      can only be a `\uXXXX`/`\u{H+}` UnicodeEscapeSequence inside an IdentifierName. So a `u`
//      after a backslash that the mask calls renameable means the masker did not recognise the
//      escape, and the rename pass is loose INSIDE an identifier: `\u{b5}s` is not `\`, `u`,
//      `{b5}` and `s`. A finding means a spelling `unicodeEscapeEnd` cannot read.
//
//  (b) THE MODIFIER, PLAIN NAME. No JS grammar puts two identifier tokens side by side, and `#`
//      can only begin a private member name. So a member-modifier word that the mask calls
//      renameable and that is immediately followed by an identifier or a `#` is fixed syntax:
//      renaming it emits `static __m0_get rules(){`, which does not parse.
//
//  (c) THE MODIFIER, COMPUTED NAME. `get[…](…){` is not parseable as an expression — `get[k]`
//      is indexing, `get[k](a)` is a call, and no call expression is followed by a `{` that is
//      a function body. The tail is what separates it from real indexing, so the detector
//      confirms it rather than flagging every `get[`.
//
//  (d) THE MODIFIER, GENERATOR STAR. Same reading one token over: `async*name(…){` and
//      `async*[…](…){`. Only `async` and `static` are asked about — a getter or setter can
//      never be a generator, so `get*` is multiplication and flagging it would be a false red.
//
//  (e) THE CLASS STATIC BLOCK. `static{` has no expression reading at all: a reference to a
//      binding named `static` followed by a block statement needs ASI between them, which no
//      minifier emits. 17 sites in the pinned carve, all of them the block form.
function findEscapes(src, mask) {
  const out = [];
  for (let i = 0; i + 1 < src.length; i++) {
    if (src.charCodeAt(i) !== 92 || src.charCodeAt(i + 1) !== 117) continue; // \u
    if (mask[i + 1] !== 1) continue;
    out.push(i);
  }
  return out;
}

// Shared shape reader for (c) and (d): the byte just past a balanced bracket run starting at p.
function balancedEnd(src, mask, p) {
  let d = 0;
  for (let q = p; q < src.length; q++) {
    if (!mask[q]) continue;
    const ch = src[q];
    if (ch === '[' || ch === '(' || ch === '{') d++;
    else if (ch === ']' || ch === ')' || ch === '}') { d--; if (!d) return q + 1; }
  }
  return -1;
}
function skipWs(src, mask, p) {
  while (p < src.length && mask[p] && /[ \t\r\n]/.test(src[p])) p++;
  return (p < src.length && mask[p]) ? p : -1;
}
// `( … ) {` — a parameter list followed by a body. Nothing that parses as an expression has it.
function paramsThenBody(src, mask, p) {
  if (p < 0 || src[p] !== '(') return false;
  const after = balancedEnd(src, mask, p);
  if (after < 0) return false;
  const r = skipWs(src, mask, after);
  return r >= 0 && src[r] === '{';
}

const COMPUTED_RE = new RegExp(`${NOT_AFTER}(${MOD_ALT})[ \\t]*\\[`, 'g');
function findComputed(src, mask) {
  const out = [];
  COMPUTED_RE.lastIndex = 0;
  let m;
  while ((m = COMPUTED_RE.exec(src))) {
    if (mask[m.index] !== 1) continue;
    const open = m.index + m[0].length - 1;
    const after = balancedEnd(src, mask, open);
    if (after < 0) continue;
    if (!paramsThenBody(src, mask, skipWs(src, mask, after))) continue;
    out.push(m.index);
  }
  return out;
}

const STAR_RE = new RegExp(`${NOT_AFTER}(async|static)[ \\t]*\\*`, 'g');
function findStars(src, mask) {
  const out = [];
  STAR_RE.lastIndex = 0;
  let m;
  while ((m = STAR_RE.exec(src))) {
    if (mask[m.index] !== 1) continue;
    let r = skipWs(src, mask, m.index + m[0].length);
    if (r < 0) continue;
    if (src[r] === '[') {
      const after = balancedEnd(src, mask, r);
      if (after < 0) continue;
      r = skipWs(src, mask, after);
    } else {
      if (src[r] === '#') r++;
      if (!/[A-Za-z_$]/.test(src[r] || '')) continue;
      while (r < src.length && mask[r] && /[A-Za-z0-9_$]/.test(src[r])) r++;
      r = skipWs(src, mask, r);
    }
    if (!paramsThenBody(src, mask, r)) continue;
    out.push(m.index);
  }
  return out;
}

const STATIC_BLOCK_RE = new RegExp(`${NOT_AFTER}static[ \\t]*\\{`, 'g');
function findStaticBlocks(src, mask) {
  const out = [];
  STATIC_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = STATIC_BLOCK_RE.exec(src))) {
    if (mask[m.index] === 1) out.push(m.index);
  }
  return out;
}

const MODIFIER_RE = new RegExp(`${NOT_AFTER}(${MOD_ALT})(?:[ \\t]+(?=[A-Za-z_$])|(?=#))`, 'g');
function findModifiers(src, mask) {
  const out = [];
  MODIFIER_RE.lastIndex = 0;
  let m;
  while ((m = MODIFIER_RE.exec(src))) {
    if (mask[m.index] === 1) out.push(m.index);
  }
  return out;
}

// KEPT for the merger-fix report's own re-measurement and for anything that wants the two
// original readings together. The guards below do NOT use it — each one takes exactly one
// detector, which is the whole point of splitting them.
function findRenameablePositions(src, mask) {
  return [].concat(
    findEscapes(src, mask).map((offset) => ({ kind: 'escape', offset })),
    findModifiers(src, mask).map((offset) => ({ kind: 'modifier', offset })),
  );
}

// ---- read(): the only I/O, shared by all five guards ---------------------------------------
//
// Copied rather than imported from the sibling guard for the reason that file already records
// about its own copies: requiring a sibling *.test.cjs re-runs its entire test file as a side
// effect of the require.
//
// KNOWN, AND NOT NEW: this resolves `~/.cache/clode/<pin>/graph.json`, which is absent on a
// fresh CI runner, so all five guards SKIP in CI and are effectively dev-box gates. That is the
// established pattern (`test/build-gates/dep-closure-gates.test.cjs` does the same), but the
// release gate IS CI, and in CI these guards measure nothing. Written down here rather than
// discovered again; filed in BACKLOG.md.
function readGraphSources() {
  const pin = pinnedVersion();
  if (!pin) {
    return { skip: 'UPSTREAM_PIN has no `claude-code <version>` line — cannot locate the '
      + 'pinned carve to scan' };
  }
  const graphPath = path.join(os.homedir(), '.cache', 'clode', pin, 'graph.json');
  if (!fs.existsSync(graphPath)) {
    return { skip: `pinned carve not found at ${graphPath} — the local ~/.cache/clode store `
      + 'has not been populated on this box (build once, or run the extractor)' };
  }
  const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const sources = Object.entries(g.sources || {}).map(([rel, src]) => ({ rel, src }));
  if (sources.length === 0) return { skip: `graph.json at ${graphPath} has no module sources` };
  return { sources };
}

// PURE. The shape defineGuard's `scan` requires: {findings, examined}.
function scanWith(find, say) {
  return function scanSources({ sources }) {
    const findings = [];
    let examined = 0;
    for (const { rel, src } of sources) {
      if (typeof src !== 'string' || src.length === 0) continue;
      examined++;
      const mask = codeMask(src);
      for (const offset of find(src, mask)) {
        findings.push(`${rel}: offset ${offset}: ${say} — `
          + JSON.stringify(src.slice(Math.max(0, offset - 30), offset + 40)));
      }
    }
    return { findings, examined };
  };
}

// MEASURED 2026-09-22 against the pinned claude-code 2.1.251 carve, with these same scans:
//
//   position            pre-fix findings                    post-fix
//   escape              55 in 4 modules  (at 6032f77)       0
//   modifier + name    238 in 31 modules (at 6032f77)       0
//   modifier + [        41 in 12 modules (at a41df80)       0
//   modifier + *        28 in 12 modules (at a41df80)       0
//   static { }          17 in 1 module   (at a41df80)       0
//
// ONE BLIND SPOT, stated rather than rounded away: the mask protects 42 `modifier [` sites and
// this detector sees 41. The missing one is `static[Symbol.species]=Array` — a computed class
// FIELD, which has no `(…){` tail to confirm. Flagging a bare `static[k]=1` would be a false
// red, because that is also an ordinary assignment through an index; deciding between them
// needs the enclosure knowledge this detector deliberately does not have. So a regression that
// loses the field half of the computed-name rule is invisible here, and is covered only by the
// repro test above.
//
// So every one of these guards was RED on the real corpus the day it was written, which is what
// makes its green mean something. The floor is the module count, as next door: a drop means the
// carve regenerated with fewer modules (the pin moved — move the floor with it) or something
// upstream of read() broke.
const FLOOR = 1839;

// THE CONTROLS, and why none of them is the verbatim repro above. Every repro is masked 0 BY
// CONSTRUCTION — that is the fix — so feeding one here would produce no findings and register a
// guard that cannot fail. A control must be a violation the scan MUST report, so each is a REAL
// shape, valid JS, that the fix deliberately does not reach. Cover one of these positions in
// the mask one day and that control must be re-cut to another uncovered one, NOT deleted.// THE CONTROLS, and why none of them is the verbatim repro above. Every repro is masked 0 BY
// CONSTRUCTION — that is the fix — so feeding one here would produce no findings and register a
// guard that cannot fail. A control must be a violation the scan MUST report, so each is a REAL
// shape, valid JS, that the fix deliberately does not reach. Cover one of these positions in
// the mask one day and that control must be re-cut to another uncovered one, NOT deleted.
//
// FIVE SEPARATE `defineGuard` CALL SITES, written out rather than looped: one registration per
// position is the fix for review FINDING 4, and test/guards-population.cjs derives the expected
// registry size by counting bare `defineGuard` call sites in this file's TEXT — a loop would
// register five guards from one site and break that derivation, which is itself the kind of
// "the static reading and runtime reality disagree" defect this repo gates for.

guardTests(defineGuard({
  name: 'merger-renameable-escape',
  floor: FLOOR,
  read: readGraphSources,
  scan: scanWith(findEscapes,
    'a "\\u" the merger\'s mask calls ORDINARY, RENAMEABLE code. In code position a backslash '
    + 'is only ever a unicode escape inside an identifier, so the rename pass can reach the '
    + 'fragments between the escapes and rewrite one (\\u{b5}s -> \\__m0_u{b5}s), which no '
    + 'engine parses'),
  // `\u{}` — an escape `unicodeEscapeEnd` cannot read (no codepoint). It models the regression
  // the escape detector exists for: a SPELLING the masker does not recognise leaves the
  // renamer loose inside the identifier, exactly as before the fix.
  control: () => ({ sources: [{ rel: 'synthetic/unreadable-escape.cjs', src: 'var o={n\\u{}s:1};\n' }] }),
}));

guardTests(defineGuard({
  name: 'merger-renameable-modifier',
  floor: FLOOR,
  read: readGraphSources,
  scan: scanWith(findModifiers,
    'a member modifier the mask calls ORDINARY, RENAMEABLE code, immediately followed by an '
    + 'identifier or a private name. Renaming it puts two identifier tokens side by side '
    + '(static __m0_get rules(){), which no JS grammar allows'),
  // `async x=>y` — a real, KNOWN-UNCOVERED contextual-keyword position (scc-merge.cjs's own
  // comment names it: the arrow-function `async` is not in a member position, so
  // `propertyNames` leaves it alone). It is caught later, at merge time, by
  // `assertNoRenamedFixedNames`; this guard names it earlier.
  control: () => ({ sources: [{ rel: 'synthetic/arrow-async.cjs', src: 'var f = async x=>x+1;\n' }] }),
}));

guardTests(defineGuard({
  name: 'merger-renameable-computed-member',
  floor: FLOOR,
  read: readGraphSources,
  scan: scanWith(findComputed,
    'a member modifier the mask calls ORDINARY, RENAMEABLE code, in front of a COMPUTED member '
    + 'name whose tail is a method body. Renaming it emits `__m0_get[Symbol.toStringTag](){`, '
    + 'which node --check rejects with "Unexpected token \'[\'"'),
  // An object literal preceded by a COMMENT. `prevIdx` stops at the first masked byte, so the
  // `*/` reads as "no token we can name" and `braceKind` returns block — the documented safe
  // direction, and a real under-protection this fix does not reach.
  control: () => ({ sources: [{ rel: 'synthetic/commented-object.cjs',
    src: 'var o = /*c*/{get[k](){return 1}};\n' }] }),
}));

guardTests(defineGuard({
  name: 'merger-renameable-generator-star',
  floor: FLOOR,
  read: readGraphSources,
  scan: scanWith(findStars,
    'a member modifier the mask calls ORDINARY, RENAMEABLE code, in front of a GENERATOR star '
    + 'and a method. Renaming it emits `__m0_async*iterPages(){`, which node --check rejects '
    + 'with "Unexpected token \'*\'"'),
  // The same real gap, one position over.
  control: () => ({ sources: [{ rel: 'synthetic/commented-object-generator.cjs',
    src: 'var o = /*c*/{async*g(){yield 1}};\n' }] }),
}));

guardTests(defineGuard({
  name: 'merger-renameable-static-block',
  floor: FLOOR,
  read: readGraphSources,
  scan: scanWith(findStaticBlocks,
    'a `static` the mask calls ORDINARY, RENAMEABLE code, immediately in front of a class '
    + 'static-initialization block. Renaming it emits `__m0_static{Object.define…`, which node '
    + '--check rejects with "Unexpected token \'{\'"'),
  // `classPending` is a ONE-SHOT flag cleared by the next `{`, so a brace in the heritage
  // clause consumes it and the real class body is then classified from its `)` — a block.
  // `class X extends mixin({…}){…}` is an ordinary shape, so this is a real gap and not a
  // violation that never happens.
  control: () => ({ sources: [{ rel: 'synthetic/heritage-brace-class.cjs',
    src: 'class X extends f({}){static{y=1}}\n' }] }),
}));


module.exports = { memberModifiers, findRenameablePositions, findEscapes, findModifiers,
  findComputed, findStars, findStaticBlocks, scanWith, readGraphSources };
