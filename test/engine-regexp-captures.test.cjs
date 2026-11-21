'use strict';
// REGEXP-CAPTURE-U16 (spike/quickjs/patches/quickjs-ng-regexp-capture-u16.patch): the engine
// accepts as many capture groups in one RegExp as native Claude Code does, 32,768, where
// QuickJS-ng refused anything past 254.
//
// WHY IT MATTERS. Claude Code builds patterns with one capture group per letter of a word list
// (an atomic separator: a lookahead captures a run, a backreference consumes exactly it). The
// artifact-lead scrub pattern had 559 groups at 2.1.283 and 588 at 2.1.327, a 980,559-character
// /giu pattern; under QuickJS `new RegExp` threw "too many captures" and no subagent could
// finish. JavaScriptCore (native) and V8 never refuse it, so upstream cannot see this.
//
// THE ENGINE IS THE SUBJECT. Every probe runs under tjs; the semantics probes run under node too
// and must answer identically (V8 and JavaScriptCore agree on these patterns; only the LIMIT
// differs, by one group, and that is pinned against native's own measured number below):
//   - the limit: 32,768 groups compile and match, 32,769 are refused (native's boundary);
//   - every opcode that carries a capture index, past index 255: save_start/save_end (a group's
//     text), save_reset (a quantified group cleared between iterations), back_reference and
//     backward_back_reference (\N and \k<name>, forwards and inside a lookbehind), and indices
//     (the d flag) for groups past 255;
//   - the lead scrub's own shape at 2.1.327's size: 588 atomic separators under giu;
//   - a regexp LITERAL with 300 groups through serialize/deserialize/evalBytecode, the path a
//     fused quaude's bytecode takes (OP_regexp carries libregexp's bytecode opaquely).
// Before the patch, every probe here past 254 groups throws under tjs (measured 2026-11-21 on
// the engine built without it: "too many captures").
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs } = require('./node-shim-helper.cjs');

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `${cmd} exited ${r.status}: ${r.stderr}`);
  const line = r.stdout.trim().split('\n').pop();
  return JSON.parse(line);
}
const underTjs = (fn) => run(...engineSpawn(['eval', `(${fn})()`]));
const underNode = (fn) => run(process.execPath, ['-e', `(${fn})()`]);

// NATIVE'S LIMIT, measured 2026-11-21 by bisection inside native Claude Code 2.1.330 (its own
// Bun/JavaScriptCore, a BUN_OPTIONS=--preload probe): `new RegExp` of N `(a)` groups compiles for
// N <= 32,768 and throws "Invalid regular expression: too many captures" for 32,769. node 24.21.0
// (V8) stops at 32,767, which is why this number is not read from node.
const NATIVE_MAX_GROUPS = 32768;

function limitProbe(max) {
  const pattern = (n) => Array.from({ length: n }, () => '(a)').join('');
  const at = (n) => {
    try {
      const m = new RegExp(pattern(n)).exec('a'.repeat(n));
      return { ok: true, length: m && m.length, last: m && m[n] };
    } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
  };
  console.log(JSON.stringify({ atMax: at(max), pastMax: at(max + 1), at255: at(255) }));
}

test('the engine accepts native\'s capture-group limit (32,768) and refuses one more', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = underTjs(`() => (${limitProbe})(${NATIVE_MAX_GROUPS})`);
  assert.deepStrictEqual(r.at255, { ok: true, length: 256, last: 'a' },
    `255 groups, the first count QuickJS-ng refused, must compile and match: ${JSON.stringify(r.at255)}`);
  assert.deepStrictEqual(r.atMax, { ok: true, length: NATIVE_MAX_GROUPS + 1, last: 'a' },
    `${NATIVE_MAX_GROUPS} groups compile and match natively: ${JSON.stringify(r.atMax)}`);
  assert.strictEqual(r.pastMax.ok, false, `${NATIVE_MAX_GROUPS + 1} groups are refused natively`);
  assert.match(r.pastMax.error, /^SyntaxError: .*too many captures/);
});

// Every capture-index opcode, past 255. Each case is [source, flags, inputs]; the probe records
// exec's whole answer (groups, index, indices) for every input. PAD is a run of groups that
// match the empty string, so the groups under test sit past index 255.
function semanticsProbe() {
  const PAD = '()'.repeat(260);
  const cases = [
    // save_start/save_end: the text of group 261 and 262
    [PAD + '(a+)(b)', '', ['xaab', 'b', 'aaab aab']],
    // back_reference past 255, numbered and named
    [PAD + '(\\w)\\261', '', ['abccd', 'xyz', 'aa']],
    [PAD + '(?<twin>\\w)\\k<twin>', 'g', ['aabbc dd']],
    // save_reset: an optional group past 255 is cleared when it does not take part. (Not
    // `(?:(a)|(b))+`: QuickJS-ng keeps a capture from an earlier iteration of an alternation
    // under + or *, where V8 clears it, at every index and with or without this patch; that
    // is BACKLOG.md's "QuickJS keeps captures across quantifier iterations", not this file's.)
    [PAD + '(?:(a)?b)+', '', ['abb', 'ab', 'bab']],
    [PAD + '(?:(a)?b)*c', '', ['abbc', 'c', 'babc']],
    [PAD + '(?:(x)?y)*', '', ['xyy', 'yxy']],
    // backward_back_reference: a backreference inside a lookbehind, past 255
    [PAD + '(a)(?<=\\261)b', '', ['ab', 'b', 'xab']],
    [PAD + '(?<=(\\w)\\261)z', '', ['aaz', 'abz']],
    // indices (the d flag) for groups past 255
    [PAD + '(c)(?<n>d)', 'd', ['abcd']],
    // case-insensitive backreference past 255
    [PAD + '(q)\\261', 'iu', ['qQ', 'qq', 'qx']],
  ];
  // the lead scrub's shape: 588 letters, each followed by an atomic separator
  const letters = 'leadscrubpattern';
  let lead = '';
  for (let i = 1; i <= 588; i++) lead += '[' + letters[i % letters.length] + ']' + '(?=([\\s\\u200b]*))\\' + i;
  const leadInput = (sep) => Array.from({ length: 588 }, (_, i) => letters[(i + 1) % letters.length]).join(sep);
  cases.push(['\\[(?=' + lead + ')', 'giu', ['[' + leadInput(''), '[' + leadInput(' '), '[' + leadInput(String.fromCharCode(0x200b) + ' '),
    '[' + leadInput('').slice(0, -1), 'x[' + leadInput(' ').toUpperCase()]]);
  const out = [];
  for (const [src, flags, inputs] of cases) {
    let re;
    try { re = new RegExp(src, flags); } catch (e) { out.push({ src: src.slice(-60), error: `${e.name}: ${e.message}` }); continue; }
    for (const s of inputs) {
      re.lastIndex = 0;
      const m = re.exec(s);
      out.push({
        src: src.slice(-60), flags, s: s.slice(0, 40),
        m: m && Array.from(m).slice(255), index: m && m.index, count: m && m.length,
        groups: m && m.groups ? { ...m.groups } : null,
        indices: m && m.indices ? Array.from(m.indices).slice(255) : null,
      });
    }
  }
  console.log(JSON.stringify(out));
}

test('capture indexes past 255 match as node matches them, in every opcode that carries one', (t) => {
  if (skipUnlessTjs(t)) return;
  const got = underTjs(semanticsProbe);
  const want = underNode(semanticsProbe);
  assert.ok(want.length >= 25, `the corpus ran (${want.length} answers)`);
  assert.ok(want.some((a) => a.count > 255 && a.m), 'some answer matched past group 255 (the corpus can see a match)');
  for (let i = 0; i < want.length; i++) {
    assert.deepStrictEqual(got[i], want[i], `answer ${i} differs from node`);
  }
  assert.strictEqual(got.length, want.length);
});

// A regexp literal is compiled when its module is, and its libregexp bytecode rides inside the
// serialized function (OP_regexp): the path every fused quaude takes.
function bytecodeProbe() {
  const src = 'const re = /' + '()'.repeat(299) + '(\\w)\\300/u;'
    + 'const m = re.exec("xyzz!"); globalThis.__answer = m && [m.index, m.length, m[300]];';
  const enc = new TextEncoder();
  const bytes = tjs.engine.serialize(tjs.engine.compile(enc.encode(src), 'captures-literal.js'));
  const mod = tjs.engine.deserialize(bytes);
  Promise.resolve(tjs.engine.evalBytecode(mod)).then(() => {
    console.log(JSON.stringify({ bytes: bytes.length, answer: globalThis.__answer }));
  }, (e) => console.log(JSON.stringify({ error: String(e) })));
}

test('a 300-group regexp literal survives serialize/deserialize/evalBytecode', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = underTjs(bytecodeProbe);
  assert.deepStrictEqual(r.answer, [2, 301, 'z'], JSON.stringify(r));
});
