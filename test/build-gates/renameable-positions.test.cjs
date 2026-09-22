'use strict';
// THE MASK MUST NOT CALL FIXED SYNTAX RENAMEABLE.
//
// `libexec/scc-merge.cjs` renames colliding top-level bindings by text substitution, and the
// ONLY thing standing between that substitution and a token it must not touch is `codeMask`:
// 1 means "ordinary code, safe to rewrite", 0 means "leave verbatim". Two positions in real
// upstream bundles hold a token that LOOKS like an identifier and is not one, and the mask
// called both of them 1:
//
//   \u{b5}s:1000n        ->  \__m28_u{b5}s:1000n        a unicode escape inside an identifier
//   static get rules(){  ->  static __m28_get rules(){   a class member's modifier chain
//
// Both merged to a file that is not valid JS in ANY engine (QuickJS: "invalid property name";
// node --check: "Invalid or unexpected token"), and both were live in the wild — they are why
// UPSTREAM_PIN sat 27 versions behind on claude-code 2.1.251. On .251 and .278 the two sites
// happen to sit in modules outside every merged group, so nothing renamed them; on .257
// upstream's re-chunk pulled both into SCC group 1 and the build died. The defect was never
// about which version upstream shipped, so neither is this gate: it reads the pinned carve's
// module sources through the REAL mask and asks whether either position is renameable
// anywhere in them, merged or not.
//
// WHY A GATE AND NOT ONLY THE CARVE. Proving this end to end costs a 218MB provider download
// and an engine, which the normal suite has neither of. The mask does not: it is a pure
// function of text, the real corpus is already on disk from the pinned carve, and the two
// positions are decidable from the mask's own output.
//
// The literal relative require below is load-bearing for test/guards-population.cjs's
// control mapping, which derives "which guard controls this production gate" by reading that
// exact string out of this file's source — same trick as the sibling guard next door.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codeMask } = require('../../libexec/scc-merge.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { pinnedVersion } = require('../provider-resolve.cjs');

// ---- the two repros, transcribed verbatim from the 2.1.257 carve --------------------------
//
// VERDICT (recorded 2026-09-22, `/opt/pkg/bin/node --test test/build-gates/`, BEFORE the fix):
// both FAILED — `mask[idx]` was 1, not 0. These are regression tests now: each goes red again
// if `unicodeEscapeEnd` or the member-modifier reading is removed or narrowed.

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

test('a real binding spelled like a modifier is still renameable', () => {
  // The other half, and the reason neither fix may be a blanket word exclusion: a member can
  // declare a genuine top-level `get`/`set`/`async`/`static`, two members' copies collide, and
  // leaving both alone re-declares the name in the merged scope. Same argument the file's
  // `as`/`of` comments make at length.
  const src = 'var get=1,set=2;export const x=get+set;';
  const mask = codeMask(src);
  assert.strictEqual(mask[src.indexOf('get=1')], 1);
  assert.strictEqual(mask[src.indexOf('get+set')], 1);
  assert.strictEqual(mask[src.indexOf('set=2')], 1);
});

// ---- the guard ----------------------------------------------------------------------------

// The four words that can stand in front of a class or object member's name. Read out of the
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
const MODIFIER_RE = new RegExp(`(?<![A-Za-z0-9_$.])(${MODIFIERS.join('|')})(?:[ \\t]+(?=[A-Za-z_$])|(?=#))`, 'g');

// PURE. Both positions, one reading: an identifier-looking token the mask says the rename pass
// may rewrite, sitting where the JS grammar does not allow an identifier.
//
//  (a) THE ESCAPE. A backslash in code — outside every string, template, regex and comment —
//      can only be a `\uXXXX`/`\u{H+}` UnicodeEscapeSequence inside an IdentifierName. So a `u`
//      after a backslash that the mask calls renameable means the masker did not recognise the
//      escape, and the rename pass is loose INSIDE an identifier: `\u{b5}s` is not `\`, `u`,
//      `{b5}` and `s`. Post-fix every escape the masker CAN read is masked whole, so a finding
//      here means a form it cannot read (a narrowed `unicodeEscapeEnd`, or a spelling upstream
//      has not emitted before) — which is exactly the regression worth a red.
//
//  (b) THE MODIFIER. No JS grammar puts two identifier tokens side by side, and `#` can only
//      begin a private member name. So a member-modifier word that the mask calls renameable
//      and that is immediately followed by an identifier or a `#` is fixed syntax: renaming it
//      emits `static __m0_get rules(){`, which does not parse. This needs no bracket
//      classification of its own — it is a DIFFERENT reading of the text from the one
//      `propertyNames` used to decide it, which is the property that makes it a check rather
//      than a restatement.
function findRenameablePositions(src, mask) {
  const findings = [];
  for (let i = 0; i + 1 < src.length; i++) {
    if (src.charCodeAt(i) !== 92 || src.charCodeAt(i + 1) !== 117) continue; // \u
    if (mask[i + 1] !== 1) continue;
    findings.push({ kind: 'escape', offset: i, snippet: src.slice(Math.max(0, i - 20), i + 24) });
  }
  MODIFIER_RE.lastIndex = 0;
  let m;
  while ((m = MODIFIER_RE.exec(src))) {
    if (mask[m.index] !== 1) continue;
    findings.push({ kind: 'modifier', offset: m.index,
      snippet: src.slice(Math.max(0, m.index - 30), m.index + 40) });
  }
  return findings;
}

// PURE. The shape defineGuard's `scan` requires: {findings, examined}.
function scanSources({ sources }) {
  const findings = [];
  let examined = 0;
  for (const { rel, src } of sources) {
    if (typeof src !== 'string' || src.length === 0) continue;
    examined++;
    const mask = codeMask(src);
    for (const site of findRenameablePositions(src, mask)) {
      findings.push(site.kind === 'escape'
        ? `${rel}: offset ${site.offset}: a "\\u" the merger's mask calls ORDINARY, RENAMEABLE `
          + `code — ${JSON.stringify(site.snippet)}. In code position a backslash is only ever a `
          + `unicode escape inside an identifier, so the rename pass can reach the fragments `
          + `between the escapes and rewrite one (\\u{b5}s -> \\__m0_u{b5}s), which no engine parses.`
        : `${rel}: offset ${site.offset}: a member modifier the merger's mask calls ORDINARY, `
          + `RENAMEABLE code, immediately followed by an identifier or a private name — `
          + `${JSON.stringify(site.snippet)}. Renaming it puts two identifier tokens side by `
          + `side (static __m0_get rules(){), which no JS grammar allows.`);
    }
  }
  return { findings, examined };
}

// read() — the only I/O in this guard: the real pinned carve's graph.json, read-only. Copied
// rather than imported from the sibling guard for the reason that file already records about
// its own copies: requiring a sibling *.test.cjs re-runs its entire test file as a side effect
// of the require.
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

// MEASURED 2026-09-22 against the pinned claude-code 2.1.251 carve, with the SAME scan:
//   before the fix   55 escape findings in 4 modules, 69 modifier findings in 14 modules
//   after            0 and 0, over all 1,839 module sources
// So this guard was RED on the real corpus the day it was written, which is what makes its
// green mean something. The floor is that exact module count, as next door: a drop means the
// carve regenerated with fewer modules (the pin moved — move the floor with it) or something
// upstream of read() broke.
const guard = defineGuard({
  name: 'merger-renameable-positions',
  floor: 1839,
  read: readGraphSources,
  scan: scanSources,
  // THE CONTROL, and why neither half of it is the verbatim repro above. Both repros are now
  // masked 0 BY CONSTRUCTION — that is the fix — so feeding them here would produce no
  // findings and register a guard that cannot fail. A control must be a violation the scan
  // MUST report, so each half is a shape the fix deliberately does not cover:
  //
  //   * `\u{}` — an escape `unicodeEscapeEnd` cannot read (no codepoint). It models the
  //     regression the escape half exists for: an escape SPELLING the masker does not
  //     recognise leaves the renamer loose inside the identifier, exactly as before the fix.
  //   * `async x=>y` — a real, KNOWN-UNCOVERED contextual-keyword position (scc-merge.cjs's
  //     own comment names it: the arrow-function `async` is not in a member position, so
  //     `propertyNames` leaves it alone). It is caught later, at merge time, by
  //     `assertNoRenamedFixedNames` — this guard names it earlier. Cover that position in the
  //     mask one day and this control must be re-cut to another uncovered one, NOT deleted.
  control: () => ({
    sources: [
      { rel: 'synthetic/unreadable-escape.cjs', src: 'var o={n\\u{}s:1};\n' },
      { rel: 'synthetic/arrow-async.cjs', src: 'var f = async x=>x+1;\n' },
    ],
  }),
});
guardTests(guard);

module.exports = { memberModifiers, findRenameablePositions, scanSources, readGraphSources, guard };
