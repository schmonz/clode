'use strict';
// REGEXP-REUSE-SAME-FLAGS (spike/quickjs/patches/quickjs-ng-regexp-reuse-same-flags.patch):
// `new RegExp(re, flags)` reuses re's compiled bytecode when `flags` names exactly the flags
// that bytecode was compiled with, instead of compiling the pattern again.
//
// WHY IT MATTERS. RegExp.prototype[@@matchAll] always constructs its species copy WITH the
// flags, and QuickJS-ng reused bytecode only when the flags argument was undefined. Claude
// Code's harness-content scan runs text.matchAll(re) once per text block of every assistant
// message, against a 1,557,878-character pattern (the LEAD-SCRUB-POSSESSIVE rewrite): 131 ms
// a compile on darwin-arm64 and 3.9 s on an emulated G4, about 7.8 s per reply there.
//
// THE ENGINE IS THE SUBJECT, so both halves run under tjs:
//   - timing: a clone with the same flags, and a matchAll, cost next to nothing against a
//     compile of the same pattern; a clone with DIFFERENT flags still costs a compile (the
//     control that proves this measurement can see a compile at all);
//   - semantics: every observable property of the clone equals the uncloned RegExp's over a
//     corpus, and the edge cases (flags whose toString recompiles the source RegExp, an
//     overridden flags getter, species, invalid flags) answer exactly as node (V8) does.
// The semantics half passes on an engine WITHOUT the patch too: the patch must not change
// anything JS can see. Its power to fail was proven by building the engine with two wrong
// versions of the patch (reuse regardless of flags; take the bytecode after ToString(flags)),
// each of which this file rejects (recorded in BACKLOG.md with the patch's before/after).
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs } = require('./node-shim-helper.cjs');

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, `${cmd} exited ${r.status}: ${r.stderr}`);
  const line = r.stdout.trim().split('\n').pop();
  return JSON.parse(line);
}
const underTjs = (fn) => run(...engineSpawn(['eval', `(${fn})()`]));
const underNode = (fn) => run(process.execPath, ['-e', `(${fn})()`]);

// A pattern in the lead scrub's shape, big enough that one compile is measurable: per-letter
// classes (Latin, Cyrillic and Latin-1, under i and u) joined by possessive separators. The
// non-ASCII ranges are built from code points so this file stays ASCII.
function timingProbe() {
  const range = (a, b) => String.fromCharCode(a) + '-' + String.fromCharCode(b);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const cls = (c) => '[' + c + c.toUpperCase() + range(0x400, 0x4ff) + range(0xc0, 0xff) + ']';
  const ws = '[\\s' + range(0x200b, 0x200f) + ']';
  const sep = ws + '*(?!' + ws + ')';
  const words = [];
  for (let i = 0; i < 400; i++) {
    let w = '';
    for (let j = 0; j < 8; j++) w += cls(letters[(i * 7 + j * 3) % 26]) + sep;
    words.push(w);
  }
  const source = '(?:' + words.join('|') + ')';
  const time = (f) => { const t = performance.now(); f(); return performance.now() - t; };
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const text = 'Step 1 of 4: reading a file, as a [plain] note.';
  let re;
  const compile = [], same = [], matchAll = [], other = [];
  for (let i = 0; i < 5; i++) compile.push(time(() => { re = new RegExp(source, 'giu'); }));
  for (let i = 0; i < 5; i++) {
    same.push(time(() => new RegExp(re, re.flags)));
    matchAll.push(time(() => { for (const m of text.matchAll(re)) void m; }));
    other.push(time(() => new RegExp(re, 'gimu')));
  }
  console.log(JSON.stringify({
    chars: source.length, compile: median(compile), same: median(same),
    matchAll: median(matchAll), other: median(other),
  }));
}

// THE THRESHOLDS, from measurement (darwin-arm64, 2026-09-28, this probe's 93,203-character
// pattern, medians of 5, three runs each):
//   before the patch  compile 96.0-96.2 ms; same-flags clone 95.5-96.0 ms; matchAll
//                     96.0-96.3 ms; other flags 95.7-95.9 ms (each about 1.00 of a compile)
//   after the patch   compile 96.0-96.6 ms; same-flags clone 0.003-0.005 ms; matchAll
//                     0.28-0.30 ms (the exec itself); other flags 95.8-96.5 ms
// A reuse costs at most 0.3% of a compile and a recompile about 100%, so the cut sits at 5%
// for the reuse and 50% for the control: more than an order of magnitude of slack on the
// reuse side, and both sides are timed in one process, back to back, so a loaded box slows
// them together.
const REUSE_MAX = 0.05;
const RECOMPILE_MIN = 0.5;
// Below this a compile is too fast to tell apart from timer noise; grow the pattern.
const COMPILE_FLOOR_MS = 20;

test('a RegExp rebuilt with its own flags reuses its bytecode; other flags still compile', (t) => {
  if (skipUnlessTjs(t)) return;
  const m = underTjs(timingProbe);
  const said = JSON.stringify(m);
  assert.ok(m.compile >= COMPILE_FLOOR_MS,
    `one compile took ${m.compile.toFixed(2)} ms, under the ${COMPILE_FLOOR_MS} ms floor this `
    + `measurement needs: grow the pattern (${said})`);
  assert.ok(m.other >= RECOMPILE_MIN * m.compile,
    `CONTROL: a clone with DIFFERENT flags must compile, and cost about one compile; it cost `
    + `${m.other.toFixed(2)} ms against ${m.compile.toFixed(2)} ms (${said})`);
  assert.ok(m.same <= REUSE_MAX * m.compile,
    `new RegExp(re, re.flags) compiled again: ${m.same.toFixed(2)} ms against one compile's `
    + `${m.compile.toFixed(2)} ms (${said})`);
  assert.ok(m.matchAll <= REUSE_MAX * m.compile,
    `text.matchAll(re) compiled its species copy again: ${m.matchAll.toFixed(2)} ms against `
    + `one compile's ${m.compile.toFixed(2)} ms (${said})`);
});

function semanticsProbe() {
  const out = { examined: 0, withMatches: 0, mismatches: [], obs: {} };
  const J = (v) => JSON.stringify(v);
  const errOf = (f) => {
    try { f(); return 'no error'; } catch (e) { return e.constructor.name + ': ' + e.message; }
  };
  const summary = (m) => (m === null ? null : {
    m: Array.from(m), index: m.index, groups: m.groups === undefined ? 'none' : m.groups,
    indices: m.indices === undefined ? 'none' : { all: Array.from(m.indices), groups: m.indices.groups },
  });
  // Every match, found by exec on the RegExp itself: nothing constructs a copy. After an
  // empty match it advances as the spec's AdvanceStringIndex does: a whole code point
  // under u or v.
  const advance = (s, i, full) => {
    const hi = s.charCodeAt(i), lo = s.charCodeAt(i + 1);
    return full && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? i + 2 : i + 1;
  };
  const execAll = (re, s) => {
    re.lastIndex = 0;
    if (!re.global && !re.sticky) return [summary(re.exec(s))];
    const found = [];
    for (let m; (m = re.exec(s)) !== null && found.length < 100;) {
      found.push(summary(m));
      if (m[0] === '') re.lastIndex = advance(s, re.lastIndex, re.unicode || re.unicodeSets);
    }
    return found;
  };
  const cp = String.fromCodePoint;
  const REGEXES = [
    ['a', ''], ['a', 'g'], ['A', 'gi'], ['^b', 'gm'], ['a.c', 'gs'], ['a', 'y'], ['a', 'gy'],
    ['(?<x>a)(b)?', 'dg'], ['(?<x>a)|(?<y>b)', 'g'], ['(\\d+)-(\\d+)', 'g'], ['\\b\\w+\\b', 'gi'],
    ['x*', 'g'], ['', 'g'], ['/', 'g'], ['\\n|\\r', 'g'], ['[/]', ''], ['(?:)', 'dgimsuy'],
    // v-flag set operations both engines parse. (QuickJS-ng honors \p/\P only under the u
    // flag, so under v alone \p{...} is literal characters, not a property escape, while V8
    // treats it as one: a divergence of its own, in BACKLOG.md, not this patch's.)
    ['\\p{Lu}+', 'gu'], ['.', 'gu'], ['.', 'g'], ['[[a-z]--b]', 'gv'], ['[\\p{L}&&[A-Z]]', 'gv'], ['\\p{L}', 'giv'],
    [cp(0x430) + '+', 'giu'], ['(a)\\1', 'gi'], ['(?<=a)b', 'g'], ['(?=(a+))a*b\\1', 'g'],
  ];
  const TEXTS = [
    '', 'a', 'b', 'abcABC', 'aaa', 'b\nb\nb', 'a\nc', 'abc', 'ab ab', 'Ab AB aB', '12-34 5-6',
    'x/y', 'the quick brown fox', 'aAb baab', 'xyz',
    cp(0x410) + cp(0x430) + 'a' + cp(0x391), cp(0x1f600) + 'a' + cp(0xd800) + 'b',
  ];
  for (const [src, flags] of REGEXES) {
    const r = new RegExp(src, flags);   // the uncloned RegExp: compiled from a string
    r.lastIndex = 3;
    const c = new RegExp(r, r.flags);   // the clone this patch serves
    const where = `/${src}/${flags}`;
    const same = (what, a, b) => { out.examined++; if (J(a) !== J(b)) out.mismatches.push(`${where} ${what}: ${J(a)} vs ${J(b)}`); };
    same('is a new object', c !== r, true);
    same('lastIndex', [r.lastIndex, c.lastIndex], [3, 0]);
    same('source', c.source, r.source);
    same('flags', c.flags, r.flags);
    same('toString', String(c), String(r));
    same('prototype', Object.getPrototypeOf(c) === RegExp.prototype, true);
    same('own keys', Object.getOwnPropertyNames(c), Object.getOwnPropertyNames(r));
    for (const s of TEXTS) {
      const ref = execAll(r, s);
      if (ref.some((m) => m !== null)) out.withMatches++;
      same(`exec ${J(s)}`, execAll(c, s), ref);
      r.lastIndex = 0; c.lastIndex = 0;
      same(`test ${J(s)}`, c.test(s), r.test(s));
      r.lastIndex = 0; c.lastIndex = 0;
      same(`match ${J(s)}`, J(s.match(c)), J(s.match(r)));
      r.lastIndex = 0; c.lastIndex = 0;
      same(`replace ${J(s)}`, s.replace(c, '<$&>'), s.replace(r, '<$&>'));
      same(`split ${J(s)}`, s.split(c), s.split(r));
      same(`search ${J(s)}`, s.search(c), s.search(r));
      if (r.global) {
        same(`matchAll ${J(s)}`, Array.from(s.matchAll(c), summary), ref.filter((m) => m !== null));
      } else {
        same(`matchAll ${J(s)}`, errOf(() => s.matchAll(c)), errOf(() => s.matchAll(r)));
      }
    }
  }

  // ToString(flags) runs JS that recompiles the source RegExp in place. The clone keeps
  // the ORIGINAL source and matcher (the spec takes [[OriginalSource]] before ToString).
  {
    const r = /a/g;
    let calls = 0;
    const flags = { toString() { calls++; r.compile('b', 'g'); return 'g'; } };
    const c = new RegExp(r, flags);
    const a = c.test('a');
    c.lastIndex = 0;
    out.obs.reentrantCompile = { calls, source: c.source, flags: c.flags, a, b: c.test('b'), r: r.source };
  }
  // A flags object whose toString throws: the error must propagate, and the source RegExp's
  // lastIndex (set before the throwing ToString(flags) runs) must be untouched.
  {
    const r = /a/g;
    r.lastIndex = 2;
    const flags = { toString() { throw new RangeError('nope'); } };
    const error = errOf(() => new RegExp(r, flags));
    out.obs.throwingFlags = { error, lastIndex: r.lastIndex };
  }
  // An overridden flags getter: @@matchAll clones with what the getter says, not the bytecode.
  {
    const r = /a/gi;
    Object.defineProperty(r, 'flags', { value: 'g' });
    out.obs.flagsGetter = Array.from('A a'.matchAll(r), (m) => `${m[0]}@${m.index}`);
  }
  {
    const r = /a/g;
    const c = new RegExp(r, 'i');
    out.obs.otherFlags = { flags: c.flags, global: c.global, ignoreCase: c.ignoreCase, A: c.test('A') };
    out.obs.flagOrder = [new RegExp(/a/gi, 'ig').flags, new RegExp(/a/dgimsy, 'ysmigd').flags];
    out.obs.stringObjectFlags = [new RegExp(r, new String('g')).flags, new RegExp(r, new String('m')).flags];
  }
  {
    const r = /a/g;
    out.obs.calledAsFunction = { noFlags: RegExp(r) === r, withFlags: RegExp(r, r.flags) === r, flags: RegExp(r, 'g').flags };
  }
  {
    const r = /a/g;
    r.lastIndex = 2;
    const c = new RegExp(r, r.flags);
    const before = [r.lastIndex, c.lastIndex];
    c.exec('aaa');
    out.obs.lastIndex = { before, after: [r.lastIndex, c.lastIndex] };
  }
  {
    const c = new RegExp(/(a)(?<n>b)/d, 'd');
    const m = c.exec('xab');
    out.obs.indices = { all: Array.from(m.indices), n: m.indices.groups.n };
    const y = new RegExp(/a/y, 'y');
    y.lastIndex = 1;
    out.obs.sticky = [y.test('ba'), y.lastIndex, y.test('ba'), y.lastIndex];
  }
  {
    const log = [];
    let s;
    class Sub extends RegExp {
      static get [Symbol.species]() {
        return function Species(p, f) { log.push([p === s, String(f)]); return new RegExp(p, f); };
      }
    }
    s = new Sub('a', 'g');
    const res = Array.from('aa'.matchAll(s), (m) => m.index);
    const s2 = new Sub(s, s.flags);
    out.obs.species = { log, res, isSub: s2 instanceof Sub, own: Object.getOwnPropertyNames(s2), lastIndex: s2.lastIndex, source: s2.source };
  }
  // Invalid flags throw exactly what the string-pattern path (which this patch does not
  // touch) throws.
  out.obs.invalidFlags = ['gg', 'x', 'uv', 'G', ' g', 'g ', 'gig', 'dd', cp(0x131), 'g' + cp(0)].map((f) => {
    const viaRegExp = errOf(() => new RegExp(/a/g, f));
    return [viaRegExp === errOf(() => new RegExp('a', f)), viaRegExp.split(':')[0]];
  });
  // The clone and the source share the compiled bytecode: recompiling the source must not
  // disturb the clone, and dropping the source must not free what the clone still uses.
  {
    const r = /q+/g;
    const c = new RegExp(r, r.flags);
    r.compile('z', 'g');
    out.obs.afterSourceCompile = { c: c.source, qq: c.test('qq'), r: r.source };
    let last;
    for (let i = 0; i < 20000; i++) { const x = new RegExp('x(y)' + (i % 7), 'g'); last = new RegExp(x, x.flags); }
    out.obs.churn = Array.from(last.exec('xy0'));
    const lit = /h(e)llo/gi;
    const cl = new RegExp(lit, lit.flags);
    out.obs.literal = [Array.from(cl.exec('HeLLo')), String(cl)];
  }
  console.log(JSON.stringify(out));
}

test('a RegExp rebuilt with its own flags is indistinguishable from the original (tjs vs node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const q = underTjs(semanticsProbe);
  const n = underNode(semanticsProbe);
  assert.deepStrictEqual(q.mismatches, [], 'under tjs the clone differs from the uncloned RegExp');
  assert.deepStrictEqual(n.mismatches, [], 'under node the clone differs from the uncloned RegExp');
  assert.strictEqual(q.examined, n.examined, 'both engines examined the same corpus');
  assert.ok(q.withMatches > 100, `the corpus must exercise matches, not only misses: ${q.withMatches}`);
  assert.deepStrictEqual(q.obs, n.obs, 'the edge cases answer as node (V8) does');
});
