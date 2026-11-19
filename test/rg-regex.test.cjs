'use strict';
// rg's regex dialect, decided in JS (libexec/rg-regex.cjs), rule by rule. Native is the truth:
// every expected literal is what 2.1.283's EMBEDDED rg (ripgrep 14.1.1 rev 7c1d0ed28a,
// darwin-arm64) answered, `rg --json -e PATTERN -- FILE`, read as absolute_offset +
// submatch start/end per matched line (measured 2026-10-03, grep-native Task 5b). Each test names
// the rule it pins (RG-RE-*, stated in rg-regex.cjs). Non-ASCII is built from code points (the
// Write/Edit tool hazard): no literal non-ASCII character appears in this file.
//
// THE PROPERTY TEST (test/fixtures/rg-regex-oracle.json, scripts/gen-rg-regex-oracle.cjs): 500
// patterns, 300 drawn from the grammar quaude's rg answers and 200 from the lift family (shared
// branch prefixes, repetitions at branch ends: RG-RE-ALT-LIFT), over a corpus of ASCII, Latin-1,
// marks, CJK, emoji, case-folding specials, invalid UTF-8 and words; ours must equal native's
// matches on every one it answers, and the prefilter must propose every line native selects.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const R = require('../libexec/rg-regex.cjs');
const { tjsPath, runLoader } = require('./node-shim-helper.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const { census, rngBias, assertCensus } = require('./shape-census.cjs');
const { bundleLine, NATIVE_BUNDLE_LINE, bundleCensus } = require('./rg-bundle-line.cjs');

const cp = (...c) => String.fromCodePoint(...c);
const B = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));

// The rule fixtures (bytes). Every line is terminated, so every match the matcher finds is one
// rg's --json prints (RG-RE-MATCH-AT-UNTERMINATED-END below is the one place they part).
const FIX = {
  'alt.txt': B('ab foobar samwise\nab ab\n'),
  'uni.txt': B(`caf${cp(0xe9)} needle ${cp(0x4e2d, 0x6587)} needle\n${cp(0x1f600)} NEEDLE wide\nplain\n`),
  'latin1.txt': B('caf', [0xe9], ' needle\n'),
  'cjk.txt': B(`${cp(0x4e2d, 0x6587)}abc ${cp(0x4e2d)}x\n`),
  // e + combining acute (a mark); Arabic-Indic digits (Nd); undertie (Pc); ZWJ (Join_Control);
  // NBSP and ideographic space (White_Space, not word)
  'classes.txt': B(`e${cp(0x301)}t ${cp(0x661, 0x662)}7 a${cp(0x203f)}b x${cp(0x200d)}y${cp(0xa0)}z${cp(0x3000)}w _\n`),
  'posix.txt': B(`abc ${cp(0xc0, 0xc9)} ${cp(0xe9)} 123 ${cp(0x661, 0x662, 0x663)} Q_q\n`),
  // K k KELVIN S s LONG-S sharp-s CAPITAL-SHARP-S Sigma sigma final-sigma micro mu MU DZ Dz dz
  // dotted-I dotless-i i I
  'fold.txt': B(`K k ${cp(0x212a)} S s ${cp(0x17f)} ${cp(0xdf)} ${cp(0x1e9e)} ${cp(0x3a3, 0x3c3, 0x3c2)} ${cp(0xb5, 0x3bc, 0x39c)} `
    + `${cp(0x1c4, 0x1c5, 0x1c6)} ${cp(0x130)} ${cp(0x131)} i I\n`),
  // invalid UTF-8: a lone 0xFF, a truncated 3-byte sequence, a lone continuation byte, a valid
  // CJK character followed by a stray continuation byte
  'inv.txt': B('a', [0xff], 'b ', [0xe4, 0xb8], ' c', [0x80], 'd ', [0xe4, 0xb8, 0xad], [0x80], 'e\n', 'q', [0x80], 'a x\n'),
  'anchors.txt': B('abc\nabc\r\n\nxyz\n'),
  'empty.txt': B('\n\nab\n'),
  'rep.txt': B('aaa aaaa baab ab abb\n'),
};

// Ours over every line of a buffer, as native's --json reports it: [[lineNumber, [[start, end]...]]...].
function allLines(buf, pattern, flags = []) {
  const t = R.translateRgRegex(pattern, { ignoreCase: flags.includes('-i') });
  if (t.refuse) return { refused: t.rule };
  const lines = [];
  for (let ls = 0, n = 1; ls < buf.length; n++) {
    let le = buf.indexOf(0x0a, ls);
    if (le === -1) le = buf.length;
    const m = R.verifyLine(buf, ls, le, t);
    if (m.length) lines.push([n, m.map((x) => [x.start, x.end])]);
    ls = le + 1;
  }
  return lines;
}

// ---- native's literals, one row per (rule, fixture, pattern) -----------------------------------
// [rule, fixture, pattern, rg flags, native's matches per matched line]
const NATIVE = [
  ['RG-RE-LEFTMOST-FIRST', 'alt.txt', 'a|ab', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-LEFTMOST-FIRST', 'alt.txt', 'ab|a', [], [[1,[[0,2],[7,8],[11,12]]],[2,[[18,20],[21,23]]]]],
  ['RG-RE-LEFTMOST-FIRST', 'alt.txt', 'foo|foobar', [], [[1,[[3,6]]]]],
  ['RG-RE-LEFTMOST-FIRST', 'alt.txt', 'sam|samwise', [], [[1,[[10,13]]]]],
  ['RG-RE-LEFTMOST-FIRST', 'alt.txt', 'samwise|sam', [], [[1,[[10,17]]]]],
  ['RG-RE-LEFTMOST-FIRST', 'alt.txt', '(a|ab)(c|bcd)?', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-PERL-UNICODE', 'uni.txt', '\\w+', [], [[1,[[0,5],[6,12],[13,19],[20,26]]],[2,[[32,38],[39,43]]],[3,[[44,49]]]]],
  ['RG-RE-PERL-UNICODE', 'classes.txt', '\\w+', [], [[1,[[0,4],[5,10],[11,16],[17,22],[24,25],[28,29],[30,31]]]]],
  ['RG-RE-PERL-UNICODE', 'classes.txt', '\\d+', [], [[1,[[5,10]]]]],
  ['RG-RE-PERL-UNICODE', 'classes.txt', '\\s+', [], [[1,[[4,5],[10,11],[16,17],[22,24],[25,28],[29,30]]]]],
  ['RG-RE-PERL-UNICODE', 'classes.txt', '\\W+', [], [[1,[[4,5],[10,11],[16,17],[22,24],[25,28],[29,30]]]]],
  ['RG-RE-PERL-UNICODE', 'classes.txt', '\\S+', [], [[1,[[0,4],[5,10],[11,16],[17,22],[24,25],[28,29],[30,31]]]]],
  ['RG-RE-PERL-UNICODE', 'cjk.txt', '\\w', [], [[1,[[0,3],[3,6],[6,7],[7,8],[8,9],[10,13],[13,14]]]]],
  ['RG-RE-PERL-UNICODE', 'latin1.txt', '\\w+', [], [[1,[[0,3],[5,11]]]]],
  ['RG-RE-PERL-UNICODE', 'inv.txt', '\\W', [], [[1,[[3,4],[6,7],[10,11]]],[2,[[20,21]]]]],
  ['RG-RE-PERL-UNICODE', 'classes.txt', '[\\d\\s]+', [], [[1,[[4,11],[16,17],[22,24],[25,28],[29,30]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', '\\b', [], [[1,[[0,0],[5,5],[6,6],[12,12],[13,13],[19,19],[20,20],[26,26]]],[2,[[32,32],[38,38],[39,39],[43,43]]],[3,[[44,44],[49,49]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', 'f\\b', [], []],
  ['RG-RE-WORD-BOUNDARY', 'latin1.txt', 'f\\b', [], [[1,[[2,3]]]]],
  ['RG-RE-WORD-BOUNDARY', 'latin1.txt', '\\b', [], [[1,[[0,0],[3,3],[5,5],[11,11]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', '\\B', [], [[1,[[1,1],[2,2],[3,3],[7,7],[8,8],[9,9],[10,10],[11,11],[16,16],[21,21],[22,22],[23,23],[24,24],[25,25]]],[2,[[27,27],[31,31],[33,33],[34,34],[35,35],[36,36],[37,37],[40,40],[41,41],[42,42]]],[3,[[45,45],[46,46],[47,47],[48,48]]]]],
  ['RG-RE-WORD-BOUNDARY', 'cjk.txt', '\\B', [], [[1,[[3,3],[6,6],[7,7],[8,8],[13,13]]]]],
  ['RG-RE-WORD-BOUNDARY', 'inv.txt', '\\b', [], [[1,[[0,0],[1,1],[2,2],[3,3],[7,7],[8,8],[10,10],[11,11],[14,14],[16,16]]],[2,[[17,17],[18,18],[20,20],[21,21],[22,22]]]]],
  ['RG-RE-WORD-BOUNDARY', 'inv.txt', '\\B', [], [[1,[[9,9],[15,15]]],[2,[[19,19]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', '\\bneedle\\b', [], [[1,[[6,12],[20,26]]]]],
  ['RG-RE-WORD-BOUNDARY', 'classes.txt', '\\b\\w+\\b', [], [[1,[[0,4],[5,10],[11,16],[17,22],[24,25],[28,29],[30,31]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', '\\b{start}\\w', [], [[1,[[0,1],[6,7],[13,16],[20,21]]],[2,[[32,33],[39,40]]],[3,[[44,45]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', '\\w\\b{end}', [], [[1,[[3,5],[11,12],[16,19],[25,26]]],[2,[[37,38],[42,43]]],[3,[[48,49]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', '\\<n', [], [[1,[[6,7],[20,21]]]]],
  ['RG-RE-WORD-BOUNDARY', 'uni.txt', 'e\\>', [], [[1,[[11,12],[25,26]]],[2,[[42,43]]]]],
  ['RG-RE-WORD-BOUNDARY', 'inv.txt', '\\b{start-half}', [], [[1,[[0,0],[4,4],[7,7],[11,11]]],[2,[[17,17],[21,21]]]]],
  ['RG-RE-WORD-BOUNDARY', 'inv.txt', '\\b{end-half}', [], [[1,[[3,3],[6,6],[10,10],[16,16]]],[2,[[20,20],[22,22]]]]],
  ['RG-RE-WORD-BOUNDARY', 'cjk.txt', '\\b{start-half}', [], [[1,[[0,0],[10,10]]]]],
  ['RG-RE-POSIX-ASCII', 'posix.txt', '[[:alpha:]]+', [], [[1,[[0,3],[23,24],[25,26]]]]],
  ['RG-RE-POSIX-ASCII', 'posix.txt', '[[:^alpha:]]+', [], [[1,[[3,23],[24,25]]]]],
  ['RG-RE-POSIX-ASCII', 'posix.txt', '[^[:alpha:]]+', [], [[1,[[3,23],[24,25]]]]],
  ['RG-RE-POSIX-ASCII', 'posix.txt', '[[:digit:]]+', [], [[1,[[12,15]]]]],
  ['RG-RE-POSIX-ASCII', 'posix.txt', '[[:word:]]+', [], [[1,[[0,3],[12,15],[23,26]]]]],
  ['RG-RE-POSIX-ASCII', 'uni.txt', '[[:alpha:]]+', [], [[1,[[0,3],[6,12],[20,26]]],[2,[[32,38],[39,43]]],[3,[[44,49]]]]],
  ['RG-RE-POSIX-ASCII', 'fold.txt', '(?i)[[:upper:]]', [], [[1,[[0,1],[2,3],[4,7],[8,9],[10,11],[12,14],[49,50],[51,52]]]]],
  ['RG-RE-POSIX-ASCII', 'fold.txt', '(?i)[[:^lower:]]', [], [[1,[[1,2],[3,4],[7,8],[9,10],[11,12],[14,15],[15,17],[17,18],[18,21],[21,22],[22,24],[24,26],[26,28],[28,29],[29,31],[31,33],[33,35],[35,36],[36,38],[38,40],[40,42],[42,43],[43,45],[45,46],[46,48],[48,49],[50,51]]]]],
  ['RG-RE-POSIX-ASCII', 'posix.txt', '[[:punct:][:space:]]+', [], [[1,[[3,4],[8,9],[11,12],[15,16],[22,23],[24,25]]]]],
  ['RG-RE-DOT', 'latin1.txt', 'caf.', [], []],
  ['RG-RE-DOT', 'latin1.txt', '.', [], [[1,[[0,1],[1,2],[2,3],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11]]]]],
  ['RG-RE-DOT', 'inv.txt', '.', [], [[1,[[0,1],[2,3],[3,4],[6,7],[7,8],[9,10],[10,11],[11,14],[15,16]]],[2,[[17,18],[19,20],[20,21],[21,22]]]]],
  ['RG-RE-DOT', 'inv.txt', '[^a]', [], [[1,[[2,3],[3,4],[6,7],[7,8],[9,10],[10,11],[11,14],[15,16]]],[2,[[17,18],[20,21],[21,22]]]]],
  ['RG-RE-DOT', 'inv.txt', 'a.b', [], []],
  ['RG-RE-DOT', 'uni.txt', '.', [], [[1,[[0,1],[1,2],[2,3],[3,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,16],[16,19],[19,20],[20,21],[21,22],[22,23],[23,24],[24,25],[25,26]]],[2,[[27,31],[31,32],[32,33],[33,34],[34,35],[35,36],[36,37],[37,38],[38,39],[39,40],[40,41],[41,42],[42,43]]],[3,[[44,45],[45,46],[46,47],[47,48],[48,49]]]]],
  ['RG-RE-DOT', 'inv.txt', '[^x]+', [], [[1,[[0,1],[2,4],[6,8],[9,14],[15,16]]],[2,[[17,18],[19,21]]]]],
  ['RG-RE-DOT', 'anchors.txt', 'c.', [], [[2,[[6,8]]]]],
  ['RG-RE-CASE', 'fold.txt', 'k', ["-i"], [[1,[[0,1],[2,3],[4,7]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)s', [], [[1,[[8,9],[10,11],[12,14]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)' + cp(0xdf), [], [[1,[[15,17],[18,21]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)' + cp(0x3c3), [], [[1,[[22,24],[24,26],[26,28]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)' + cp(0xb5), [], [[1,[[29,31],[31,33],[33,35]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)' + cp(0x1c5), [], [[1,[[36,38],[38,40],[40,42]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)i', [], [[1,[[49,50],[51,52]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)[a-z]+', [], [[1,[[0,1],[2,3],[4,7],[8,9],[10,11],[12,14],[49,50],[51,52]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)[^a-z ]', [], [[1,[[15,17],[18,21],[22,24],[24,26],[26,28],[29,31],[31,33],[33,35],[36,38],[38,40],[40,42],[43,45],[46,48]]]]],
  ['RG-RE-CASE', 'fold.txt', 'K(?i)k', [], []],
  ['RG-RE-CASE', 'fold.txt', '(?i:k) k', [], [[1,[[0,3]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)k(?-i)k', [], []],
  ['RG-RE-CASE', 'fold.txt', 's|(?i)S', [], [[1,[[8,9],[10,11],[12,14]]]]],
  ['RG-RE-CASE', 'fold.txt', 'k (?-i:k)', ["-i"], [[1,[[0,3]]]]],
  ['RG-RE-CASE', 'uni.txt', 'NEEDLE', ["-i"], [[1,[[6,12],[20,26]]],[2,[[32,38]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)\\w+', [], [[1,[[0,1],[2,3],[4,7],[8,9],[10,11],[12,14],[15,17],[18,21],[22,28],[29,35],[36,42],[43,45],[46,48],[49,50],[51,52]]]]],
  ['RG-RE-CASE', 'fold.txt', '(?i)[k]', [], [[1,[[0,1],[2,3],[4,7]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', '^', [], [[1,[[0,0]]],[2,[[4,4]]],[3,[[9,9]]],[4,[[10,10]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', '$', [], [[1,[[3,3]]],[2,[[8,8]]],[3,[[9,9]]],[4,[[13,13]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', '^$', [], [[3,[[9,9]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', '^abc$', [], [[1,[[0,3]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', 'c$', [], [[1,[[2,3]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', 'z$', [], [[4,[[12,13]]]]],
  ['RG-RE-ANCHORS', 'anchors.txt', '^x|c\\r$', [], [[2,[[6,8]]],[4,[[10,11]]]]],
  ['RG-RE-ANCHORS', 'uni.txt', 'e$|^p', [], [[1,[[25,26]]],[2,[[42,43]]],[3,[[44,45]]]]],
  ['RG-RE-EMPTY', 'anchors.txt', 'e*', [], [[1,[[0,0],[1,1],[2,2],[3,3]]],[2,[[4,4],[5,5],[6,6],[7,7],[8,8]]],[3,[[9,9]]],[4,[[10,10],[11,11],[12,12],[13,13]]]]],
  ['RG-RE-EMPTY', 'empty.txt', 'x*', [], [[1,[[0,0]]],[2,[[1,1]]],[3,[[2,2],[3,3],[4,4]]]]],
  ['RG-RE-EMPTY', 'alt.txt', 'b|', [], [[1,[[0,0],[1,2],[3,3],[4,4],[5,5],[6,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,20],[21,21],[22,23]]]]],
  ['RG-RE-EMPTY', 'alt.txt', '|b', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-EMPTY', 'alt.txt', '(?:)', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-EMPTY', 'alt.txt', 'a*?', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-EMPTY', 'uni.txt', 'x*', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],[21,21],[22,22],[23,23],[24,24],[25,25],[26,26]]],[2,[[27,27],[28,28],[29,29],[30,30],[31,31],[32,32],[33,33],[34,34],[35,35],[36,36],[37,37],[38,38],[39,39],[40,40],[41,41],[42,42],[43,43]]],[3,[[44,44],[45,45],[46,46],[47,47],[48,48],[49,49]]]]],
  ['RG-RE-EMPTY', 'cjk.txt', 'x*', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,14]]]]],
  ['RG-RE-EMPTY', 'inv.txt', 'q*', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16]]],[2,[[17,18],[19,19],[20,20],[21,21],[22,22]]]]],
  ['RG-RE-EMPTY', 'cjk.txt', '\\b*', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14]]]]],
  ['RG-RE-EMPTY', 'rep.txt', '(a*)*', [], [[1,[[0,3],[4,8],[9,9],[10,12],[13,13],[14,15],[16,16],[17,18],[19,19],[20,20]]]]],
  ['RG-RE-EMPTY', 'rep.txt', '(a|)+b', [], [[1,[[9,10],[10,13],[14,16],[17,19],[19,20]]]]],
  ['RG-RE-EMPTY', 'rep.txt', '(|a)+', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20]]]]],
  ['RG-RE-EMPTY', 'rep.txt', '(a*?)+?b', [], [[1,[[9,10],[10,13],[14,16],[17,19],[19,20]]]]],
  ['RG-RE-GREED', 'rep.txt', 'a+?', [], [[1,[[0,1],[1,2],[2,3],[4,5],[5,6],[6,7],[7,8],[10,11],[11,12],[14,15],[17,18]]]]],
  ['RG-RE-GREED', 'rep.txt', '(?U)a+', [], [[1,[[0,1],[1,2],[2,3],[4,5],[5,6],[6,7],[7,8],[10,11],[11,12],[14,15],[17,18]]]]],
  ['RG-RE-GREED', 'rep.txt', 'a{2,3}', [], [[1,[[0,3],[4,7],[10,12]]]]],
  ['RG-RE-GREED', 'rep.txt', 'a{2,3}?', [], [[1,[[0,2],[4,6],[6,8],[10,12]]]]],
  ['RG-RE-GREED', 'rep.txt', 'a{2}', [], [[1,[[0,2],[4,6],[6,8],[10,12]]]]],
  ['RG-RE-GREED', 'rep.txt', 'a{2,}b', [], [[1,[[10,13]]]]],
  ['RG-RE-GREED', 'rep.txt', '(?U)a+?', [], [[1,[[0,3],[4,8],[10,12],[14,15],[17,18]]]]],
  ['RG-RE-GREED', 'rep.txt', 'b.*?b', [], [[1,[[9,13],[15,19]]]]],
  ['RG-RE-GREED', 'rep.txt', 'a**', [], [[1,[[0,3],[4,8],[9,9],[10,12],[13,13],[14,15],[16,16],[17,18],[19,19],[20,20]]]]],
  ['RG-RE-GREED', 'rep.txt', '(a|aa)*b', [], [[1,[[9,10],[10,13],[14,16],[17,19],[19,20]]]]],
  ['RG-RE-GREED', 'rep.txt', '(a+)+$', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', 'a)(b', [], [[1,[[0,2]]],[2,[[18,20],[21,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[]a]', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[^]a]+', [], [[1,[[1,7],[8,11],[12,17]]],[2,[[19,21],[22,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[a-]+', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[-o]+', [], [[1,[[4,6]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\x61\\u0062', [], [[1,[[0,2]]],[2,[[18,20],[21,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\x{61}b', [], [[1,[[0,2]]],[2,[[18,20],[21,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', 'a}', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', 'a]', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '(?P<x>a)(?<y>b)', [], [[1,[[0,2]]],[2,[[18,20],[21,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\%\\~\\@', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '(?s)o.b', [], [[1,[[4,7]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?m)^ab', [], [[1,[[0,2]]],[2,[[18,20]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?u)\\w+', [], [[1,[[0,2],[3,9],[10,17]]],[2,[[18,20],[21,23]]]]],
];

for (const [rule, file, pattern, flags, want] of NATIVE) {
  test(`${rule}: ${JSON.stringify(pattern)}${flags.length ? ' ' + flags.join(' ') : ''} on ${file} (native)`, () => {
    assert.deepStrictEqual(allLines(FIX[file], pattern, flags), want);
  });
}

// RG-RE-LITERAL: a plain literal is found by its bytes, leftmost and WITHOUT overlap (native).
test('RG-RE-LITERAL: a literal that overlaps itself matches without overlap, as native (native)', () => {
  // native: `aa` on `aaa aaaa baab ab abb` -> [[0,2],[4,6],[6,8],[10,12]]
  assert.deepStrictEqual(allLines(FIX['rep.txt'], 'aa'), [[1, [[0, 2], [4, 6], [6, 8], [10, 12]]]]);
  // native: `aba` on `ababab abab` -> [[0,3],[7,10]]
  assert.deepStrictEqual(allLines(B('ababab abab\n'), 'aba'), [[1, [[0, 3], [7, 10]]]]);
  // native: e-acute twice, on `caf<e-acute> <e-acute>x3` -> [[6,10]] (bytes, two at a time)
  const e = cp(0xe9);
  assert.deepStrictEqual(allLines(B(`caf${e} ${e}${e}${e}\n`), e + e), [[1, [[6, 10]]]]);
});

// RG-RE-SYNTAX: what rg's parser accepts, as it reads it (regex-syntax 0.8.4: a pattern is wrapped
// as `(?:PATTERN)`, `{ 2 }` takes spaces, `a**` repeats a repetition, `\b{2}` is a counted \b,
// `[:alpha:]` outside a bracket is a plain class, `[\na]` drops the \n).
const SYNTAX = [
  ['RG-RE-SYNTAX', 'alt.txt', ']', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', 'a{ 2 }', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', 'a{2 , 3}', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', 'a**', [], [[1,[[0,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,8],[9,9],[10,10],[11,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,19],[20,20],[21,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', 'a*?*', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', 'a+?+', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', 'x{3}{2}', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '\\U00000062', [], [[1,[[1,2],[6,7]]],[2,[[19,20],[22,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\u{62}', [], [[1,[[1,2],[6,7]]],[2,[[19,20],[22,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?P<a.b[c]>x)', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '^*', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '$+', [], [[1,[[17,17]]],[2,[[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\b+', [], [[1,[[0,0],[2,2],[3,3],[9,9],[10,10],[17,17]]],[2,[[18,18],[20,20],[21,21],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\b{2}', [], [[1,[[0,0],[2,2],[3,3],[9,9],[10,10],[17,17]]],[2,[[18,18],[20,20],[21,21],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[a-a]', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[--]', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '[---]', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '[:alpha:]', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[[:alpha:]-z]', [], [[1,[[0,1],[1,2],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[10,11],[11,12],[12,13],[13,14],[14,15],[15,16],[16,17]]],[2,[[18,19],[19,20],[21,22],[22,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[\\na]', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '[\\x00a]', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\ ', [], [[1,[[2,3],[9,10]]],[2,[[20,21]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\#', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '\\<', [], [[1,[[0,0],[3,3],[10,10]]],[2,[[18,18],[21,21]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\>', [], [[1,[[2,2],[9,9],[17,17]]],[2,[[20,20],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '\\%', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '\\_', [], []],
  ['RG-RE-SYNTAX', 'alt.txt', '(?u)a', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?s).', [], [[1,[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,14],[14,15],[15,16],[16,17]]],[2,[[18,19],[19,20],[20,21],[21,22],[22,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?U)a+', [], [[1,[[0,1],[7,8],[11,12]]],[2,[[18,19],[21,22]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', 'a)(b', [], [[1,[[0,2]]],[2,[[18,20],[21,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?i)', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(?:)', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '()', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(|)', [], [[1,[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,18],[19,19],[20,20],[21,21],[22,22],[23,23]]]]],
  ['RG-RE-SYNTAX', 'alt.txt', '(a|)|b', [], [[1,[[0,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,8],[9,9],[10,10],[11,12],[13,13],[14,14],[15,15],[16,16],[17,17]]],[2,[[18,19],[20,20],[21,22],[23,23]]]]],
];
for (const [rule, file, pattern, flags, want] of SYNTAX) {
  test(`${rule}: ${JSON.stringify(pattern)} on ${file} is read as rg reads it (native)`, () => {
    assert.deepStrictEqual(allLines(FIX[file], pattern, flags), want);
  });
}

// RG-RE-ALT-MERGE (review M1): regex-syntax's Hir::alternation merges branches that are all
// single characters, or all multi-character classes, into ONE class, and rg strips \n and bans
// NUL only afterwards. So `\n|a` is the class [\na], stripped to [a]: native ANSWERS it. A capture
// group, or a mix of a class and a character, is not merged, and rg rejects it (literals below).
test('RG-RE-ALT-MERGE: single-character branches merge before rg strips \\n and bans NUL (native)', () => {
  const alt = FIX['alt.txt'];
  const A = [[1, [[0, 1], [7, 8], [11, 12]]], [2, [[18, 19], [21, 22]]]];
  for (const p of ['\\n|a', 'a|\\n', '\\x00|a', 'a|\\x00', '(?:\\n)|a', 'a|(?i)\\n', '[^\\x00-\\x{10FFFF}]|a']) {
    assert.deepStrictEqual(allLines(alt, p), A, p);        // native: rc 0, a's matches
  }
  assert.deepStrictEqual(allLines(alt, '[\\n]|b'), [[1, [[1, 2], [6, 7]]], [2, [[19, 20], [22, 23]]]]);
  assert.deepStrictEqual(allLines(alt, '\\n|\\x00'), []);        // native: rc 1 (merged [\0\n] is two characters, so not banned; stripped to [\0])
  assert.deepStrictEqual(allLines(alt, '[^\\x00-\\x{10FFFF}]'), []); // native: rc 1, a class that matches nothing
  // native: rc 2, `the literal "\n" is not allowed in a regex`
  for (const p of ['(\\n)|a', '[ab]|\\n', '[ab]|[\\n]', '(?:[ab]|[cd])|\\n']) {
    assert.deepStrictEqual(allLines(alt, p), { refused: 'RG-RE-REFUSE-NEWLINE' }, p);
  }
});

// RG-RE-ALT-LIFT (review round 4): regex-syntax's Hir::alternation lifts a prefix shared by
// EVERY branch (all of them concatenations whose leading elements are HIR-equal: adjacent literal
// characters are ONE literal, classes compare by set, repetitions by min/max/greedy/sub, captures
// never) out of the alternation, `X..|X..` -> `X(?:..|..)`, and that changes leftmost-first
// priority when X repeats greedily. grep-regex then strips \n from every class and REBUILDS the
// HIR through the same constructors, so a prefix equal only after the strip is lifted too
// (`[\na]\w+x|a\w+y`). Native's literals, on `FooErrorException\nfoo bar\nab\nxaxb\naqqxqqy\n`:
const NATIVE_LIFT = [
  ['\\w+Error|\\w+Exception', [[1,[[0,17]]]]],
  ['(?:\\w+)Error|(?:\\w+)Exception', [[1,[[0,17]]]]],
  ['.*foo|.*bar', [[2,[[18,25]]]]],
  ['.{0,15}a|.{0,15}b', [[2,[[18,24]]],[3,[[26,28]]],[4,[[29,33]]],[5,[[34,35]]]]],
  ['x.*a|x.*b', [[4,[[29,33]]]]],
  ['[a-z]+o|[a-z]+r', [[1,[[1,3],[4,8],[9,16]]],[2,[[18,21],[22,25]]]]],
  ['(\\w+)Error|(\\w+)Exception', [[1,[[0,8]]]]],
  ['Foo\\w+?|Foo\\w+', [[1,[[0,4]]]]],
  ['[\\na]\\w+x|a\\w+y', [[5,[[34,41]]]]],
  ['a\\w+x|a\\w+y', [[5,[[34,41]]]]],
  ['[\\na]\\w+x|[a\\n]\\w+y', [[5,[[34,41]]]]],
  ['(?s).\\w*x|.\\w*y', [[1,[[0,10]]],[4,[[29,32]]],[5,[[34,41]]]]],
  ['\\w+x|\\w+y|z', [[1,[[0,10]]],[4,[[29,32]]],[5,[[34,38],[38,41]]]]],
  ['\\w+(?:Error|Exc)|\\w+Exception', [[1,[[0,11]]]]],
  ['q|\\w+Error|\\w+Exception', [[1,[[0,8]]],[5,[[35,36],[36,37],[38,39],[39,40]]]]],
];
test('RG-RE-ALT-LIFT: a prefix every branch shares is lifted, as rg lifts it, before and after the \\n strip (native)', () => {
  const buf = B('FooErrorException\nfoo bar\nab\nxaxb\naqqxqqy\n');
  for (const [pattern, want] of NATIVE_LIFT) assert.deepStrictEqual(allLines(buf, pattern), want, pattern);
});

// RG-RE-CLASS-SCALARS (Task 5b review minor, ruling G11): a Rust class is a set of `char`s, which
// never holds a surrogate (D800-DFFF), so `[\x{0}-\x{10FFFF}]`, `[\x00-\x09\x0b-\x{10FFFF}]` and `.`
// (after rg's \n strip) are the SAME class: HIR-equal, so RG-RE-ALT-LIFT lifts them, and one count.
// Native's literals, on the review's corpus: ONE match per line, the lifted `.+(?:x|y)`.
test('RG-RE-CLASS-SCALARS: an explicit full-range class equals `.` once rg strips \\n, so a shared prefix lifts (native)', () => {
  const buf = B('FooErrorException\nfoo bar\nab\nxaxb\naqqxqqy\nfooBarbaz FOObarBAZ\nxyzzyxyzzy\n');
  const want = [[1, [[0, 10]]], [4, [[29, 32]]], [5, [[34, 41]]], [7, [[62, 72]]]];
  for (const p of ['[\\x{0}-\\x{10FFFF}]+x|.+y', '[\\x00-\\x09\\x0b-\\x{10FFFF}]+x|.+y']) assert.deepStrictEqual(allLines(buf, p), want, p);
});

// RG-RE-MATCH-AT-UNTERMINATED-END. The MATCHER finds a match at the end of a last line that has
// no terminator; rg's PRINTERS do not print it (grep-printer's find_iter_at_in_context stops at a
// match starting at the line's end, and --json drops an empty match there). Native shows both
// halves: `$` on `abc\nxyz` SELECTS line 2 (rc 0, a match message) with submatches []; `q*` lists
// 4-4 5-5 6-6 and not 7-7. verifyLine is the matcher, so it reports 7-7 (the match that selects the
// line); dropping it is a printer rule (plan Tasks 6 and 7).
test('RG-RE-MATCH-AT-UNTERMINATED-END: the matcher reports the match that selects an unterminated last line (native)', () => {
  const buf = B('abc\nxyz');
  // native --json: [[1,[[3,3]]],[2,[]]]  (line 2 selected, its match not printed)
  assert.deepStrictEqual(allLines(buf, '$'), [[1, [[3, 3]]], [2, [[7, 7]]]]);
  // native --json: [[1,[[0,0],[1,1],[2,2],[3,3]]],[2,[[4,4],[5,5],[6,6]]]]
  assert.deepStrictEqual(allLines(buf, 'q*'), [[1, [[0, 0], [1, 1], [2, 2], [3, 3]]], [2, [[4, 4], [5, 5], [6, 6], [7, 7]]]]);
});

// ---- refusals ------------------------------------------------------------------------------------
// RG-RE-REFUSE-*: what quaude's rg cannot answer exactly refuses by name, and so does every pattern
// rg itself rejects (native's message in the comment). Never an answer where rg errors.
const REFUSE = [
  // rg rejects these (rc 2), and so do we
  ['(', 'RG-RE-REFUSE-SYNTAX'],                  // error: unclosed group
  ['a)', 'RG-RE-REFUSE-SYNTAX'],                 // error: unopened group
  ['[]', 'RG-RE-REFUSE-SYNTAX'],                 // error: unclosed character class
  ['a{,2}', 'RG-RE-REFUSE-SYNTAX'],              // error: repetition quantifier expects a valid decimal
  ['a{2,1}', 'RG-RE-REFUSE-SYNTAX'],             // error: invalid repetition count range
  ['*', 'RG-RE-REFUSE-SYNTAX'],                  // error: repetition operator missing expression
  ['(?i)*', 'RG-RE-REFUSE-SYNTAX'],              // error: repetition operator missing expression
  ['\\1', 'RG-RE-REFUSE-SYNTAX'],                // backreferences are not supported
  ['(?=a)', 'RG-RE-REFUSE-SYNTAX'],              // look-around is not supported
  ['\\q', 'RG-RE-REFUSE-SYNTAX'],                // error: unrecognized escape sequence
  ['\\x{d800}', 'RG-RE-REFUSE-SYNTAX'],          // error: hexadecimal literal is not a Unicode scalar value
  ['(?i-i)', 'RG-RE-REFUSE-SYNTAX'],             // error: duplicate flag
  ['(?i-)', 'RG-RE-REFUSE-SYNTAX'],              // error: dangling flag negation operator
  ['(?<n>a)(?<n>b)', 'RG-RE-REFUSE-SYNTAX'],     // error: duplicate capture group name
  ['\\b{foo}', 'RG-RE-REFUSE-SYNTAX'],           // error: unrecognized special word boundary assertion
  ['[\\b]', 'RG-RE-REFUSE-SYNTAX'],              // error: invalid escape sequence found in character class
  ['[a-\\d]', 'RG-RE-REFUSE-SYNTAX'],            // error: invalid range boundary, must be a literal
  ['[z-a]', 'RG-RE-REFUSE-SYNTAX'],              // error: invalid character class range
  ['a\\n', 'RG-RE-REFUSE-NEWLINE'],              // the literal '\n' is not allowed (without -U)
  ['[\\n]', 'RG-RE-REFUSE-NEWLINE'],
  ['(?i)\\x0a', 'RG-RE-REFUSE-NEWLINE'],
  ['\\x00', 'RG-RE-REFUSE-NUL'],                 // binary detection is enabled and matching a NUL byte is impossible
  ['[\\x00]', 'RG-RE-REFUSE-NUL'],
  // rg answers these, and quaude's rg cannot answer them exactly
  ['\\pL', 'RG-RE-REFUSE-UNICODE-CLASS'],
  ['[\\p{Greek}a]', 'RG-RE-REFUSE-UNICODE-CLASS'],
  ['\\A', 'RG-RE-REFUSE-TEXT-ANCHOR'],           // native: `\A` on `ab\nab\nxab` selects line 3 with submatches []
  ['b\\z', 'RG-RE-REFUSE-TEXT-ANCHOR'],
  ['(?-m)^a', 'RG-RE-REFUSE-TEXT-ANCHOR'],
  ['(?-u)a', 'RG-RE-REFUSE-BYTES'],
  ['(?x)a b', 'RG-RE-REFUSE-VERBOSE'],
  ['(?R)a$', 'RG-RE-REFUSE-CRLF'],
  ['[a[bc]]', 'RG-RE-REFUSE-CLASS-SET'],
  ['[a--b]', 'RG-RE-REFUSE-CLASS-SET'],
  ['[a&&b]', 'RG-RE-REFUSE-CLASS-SET'],
  ['[a~~b]', 'RG-RE-REFUSE-CLASS-SET'],
  ['[[:foo:]]', 'RG-RE-REFUSE-CLASS-SET'],       // rg: a nested class of the characters : f o
  ['(\\n)|a', 'RG-RE-REFUSE-NEWLINE'],
  ['(?P<' + cp(0xe9) + '>a)', 'RG-RE-REFUSE-CAPTURE-NAME'],
  ['a{60000}', 'RG-RE-REFUSE-SIZE'],
  ['('.repeat(120) + 'a' + ')'.repeat(120), 'RG-RE-REFUSE-SIZE'],
];
for (const [pattern, rule] of REFUSE) {
  test(`${rule}: ${JSON.stringify(pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern)} refuses by name`, () => {
    const t = R.translateRgRegex(pattern, {});
    assert.strictEqual(t.rule, rule, JSON.stringify(t.refuse || t.prefilter));
    assert.ok(R.REFUSALS[rule], `${rule} is a stated refusal`);
    assert.match(t.refuse, /quaude answers rg/);
    assert.ok(t.refuse.includes(rule), 'the reason names the rule');
    assert.strictEqual(/rg itself rejects/.test(t.refuse), !!R.REFUSALS[rule].rgRejects);
  });
}

// RG-RE-REFUSE-LOOKBEHIND: \B and \b{start-half} one byte into a line that starts with a UTF-8
// continuation byte. Native answers by where the line sits: `\b{start-half}` on the line
// `\x80 x` reports offset 1 into it when the line starts at byte 4, not when it starts at byte 2,
// and `\B` there selects the line when it starts at 4 and not at 2. So verifyLine refuses that
// line; on every other line (all of inv.txt above) the look-behind stays inside the line.
test('RG-RE-REFUSE-LOOKBEHIND: \\B and \\b{start-half} refuse a line that starts with a continuation byte (native)', () => {
  // native, `\b{start-half}`: y\n\x80 x\n -> [[1,[[0,0]]],[2,[[2,2],[4,4]]]];
  //                          yyy\n\x80 x\n -> [[1,[[0,0]]],[2,[[4,4],[5,5],[6,6]]]] (5: one byte in)
  // native, `\B`:            y\n\x80 x\n -> rc 1;  yyy\n\x80 x\n -> [[1,[[1,1],[2,2]]]]
  for (const pattern of ['\\b{start-half}', '\\B', 'x|\\B']) {
    for (const pre of ['y\n', 'yyy\n']) {
      const buf = B(pre, [0x80], ' x\n');
      const t = R.translateRgRegex(pattern, {});
      assert.throws(() => R.verifyLine(buf, pre.length, buf.length - 1, t),
        (e) => e.name === 'RgRegexRefusal' && e.rule === 'RG-RE-REFUSE-LOOKBEHIND');
      assert.match(R.refusalReason(e0(() => R.verifyLine(buf, pre.length, buf.length - 1, t))), /RG-RE-REFUSE-LOOKBEHIND/);
    }
  }
  // the other look-arounds do not refuse there: Err and a non-word character read alike for them
  const buf = B('y\n', [0x80], ' x\n');
  for (const pattern of ['\\b', '\\b{start}', '\\b{end}', '\\b{end-half}', '^', '$', '\\<']) {
    assert.doesNotThrow(() => R.verifyLine(buf, 2, buf.length - 1, R.translateRgRegex(pattern, {})), pattern);
  }
});
function e0(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); }

// ---- RG-RE-LINEAR-TIME ---------------------------------------------------------------------------
// The Pike VM enters each NFA state at most once per position and steps each thread once, so one
// search costs at most 2 x states x (positions + 1), whatever the pattern: the backtracking-
// catastrophic patterns cost what a literal costs per state. Native's answers are the literals.
test('RG-RE-LINEAR-TIME: catastrophic patterns are linear, and answer as native (native)', () => {
  const rows = [
    ['(a+)+$', 'a'.repeat(20000) + 'b', []],           // native: rc 1
    ['(a|aa)*b', 'a'.repeat(20000), []],               // native: rc 1
    ['(a|a)*c', 'a'.repeat(20000), []],                // native: rc 1
    ['(\\w+\\s?)+$', 'ab '.repeat(6000) + '!', []],     // native: rc 1
    ['(.*a){12}', 'a'.repeat(3000) + 'b', [[0, 3000]]], // native: [[0,3000]]
  ];
  for (const [pattern, line, want] of rows) {
    const buf = Buffer.from(line);
    const t = R.translateRgRegex(pattern, {});
    t.prog.steps = 0;
    const got = R.verifyLine(buf, 0, buf.length, t).map((m) => [m.start, m.end]);
    assert.deepStrictEqual(got, want, pattern);
    const searches = want.length + 1;
    assert.ok(t.prog.steps <= 2 * t.prog.n * (buf.length + 1) * searches,
      `${pattern}: ${t.prog.steps} steps for ${t.prog.n} states x ${buf.length + 1} positions x ${searches} searches`);
  }
});

// RG-RE-REFUSE-SIZE-LIMIT (review I3): rg refuses a regex whose compiled NFA passes 100 MiB
// (`compiled regex exceeds size limit of 104857600`, rc 2). Native's first refusing count for each
// family below was measured by bisection (2026-10-03); at that count ours must refuse too, never
// answer. Ours is an UPPER BOUND of regex-automata 0.4.7's NFA memory (rg-regex.cjs sizeBound), so it
// refuses earlier than native for some families: conservative, by name.
const NATIVE_SIZE_LIMIT = [
  // [family, pattern at native's first refusing count]  (the count below it native answers)
  ['\\w{n}', '\\w{2099}'], ['(\\w){n}', '(\\w){2099}'], ['\\w{1,n}', '\\w{1,2097}'], ['\\W{n}', '\\W{2251}'],
  ['\\d{n}', '\\d{20465}'], ['.{n}', '.{104858}'], ['(?i)k{n}', '(?i)k{444312}'], ['(?:ab|cd){n}', '(?:ab|cd){416101}'],
  ['[a-z]{n}', '[a-z]{1456353}'], ['a{n}', 'a{3276794}'],
  ['reviewer', '\\w{2500}'], ['reviewer', '\\w{20000}'], ['reviewer', '\\w{100}{100}'],
];
test('RG-RE-REFUSE-SIZE-LIMIT: where rg refuses a regex as too large, ours refuses too (native)', () => {
  for (const [family, pattern] of NATIVE_SIZE_LIMIT) {
    const t = R.translateRgRegex(pattern, {});
    assert.ok(t.refuse, `${family}: ${pattern} is answered, but native refuses it (compiled regex exceeds size limit)`);
    assert.ok(t.rule === 'RG-RE-REFUSE-SIZE-LIMIT' || t.rule === 'RG-RE-REFUSE-SIZE', `${pattern}: ${t.rule}`);
  }
  assert.strictEqual(R.translateRgRegex('\\w{2500}', {}).rule, 'RG-RE-REFUSE-SIZE-LIMIT');
  assert.match(R.translateRgRegex('\\w{2500}', {}).refuse, /104857600/);
  // and well under the limit, the same families are answered
  for (const p of ['\\w{50}', '.{1000}', '(?:ab|cd){1000}', '\\d{100}']) assert.ok(!R.translateRgRegex(p, {}).refuse, p);
});

// ---- the property test: native's oracle --------------------------------------------------------
const ORACLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rg-regex-oracle.json'), 'utf8'));
const CORPUS = Buffer.from(ORACLE.corpus, 'base64');
const digest = (lines) => crypto.createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 20);
// Ours over the corpus as the generator digests native: [[lineStart, [[start, end]...]]...].
function corpusLines(pattern, ignoreCase) {
  const t = R.translateRgRegex(pattern, { ignoreCase });
  if (t.refuse) return { refused: t.rule };
  const lines = [];
  try {
    for (let ls = 0; ls < CORPUS.length;) {
      const le = CORPUS.indexOf(0x0a, ls);
      const m = R.verifyLine(CORPUS, ls, le, t);
      if (m.length) lines.push([ls, m.map((x) => [x.start, x.end])]);
      ls = le + 1;
    }
  } catch (e) { if (e.name === 'RgRegexRefusal') return { refused: e.rule }; throw e; }
  return { lines, t };
}
const ANSWERED_FLOOR = 450;
// rg-regex-oracle-property: ours equals native's digest on every oracle pattern it answers. Only
// rg's own rejections, and the look-behind lines the corpus holds on purpose
// (RG-RE-REFUSE-LOOKBEHIND), may refuse. Control: a case whose native digest was tampered with.
function scanProperty({ cases }) {
  const findings = [];
  let answered = 0;
  for (const [pattern, ic, want] of cases) {
    const o = corpusLines(pattern, !!ic);
    if (o.refused) {
      if (want !== 'rejected' && o.refused !== 'RG-RE-REFUSE-LOOKBEHIND') findings.push(`${JSON.stringify(pattern)}: refused ${o.refused}, native answered`);
      continue;
    }
    if (want === 'rejected') { findings.push(`${JSON.stringify(pattern)}: rg rejects it, ours answered`); continue; }
    answered++;
    if (digest(o.lines) !== want) findings.push(`${JSON.stringify(pattern)}${ic ? ' -i' : ''}: ours ${JSON.stringify(o.lines).slice(0, 300)}`);
  }
  return { findings, examined: answered, note: 'oracle patterns answered' };
}
guardTests(defineGuard({
  name: 'rg-regex-oracle-property',
  floor: ANSWERED_FLOOR,
  read: () => ({ cases: ORACLE.cases }),
  scan: scanProperty,
  control: () => ({ cases: ORACLE.cases.map((c, i) => (i === 0 ? [c[0], c[1], 'planted-digest'] : c)) }),
}));

// THE GENERATOR'S SHAPE CENSUS (observability Task 4; test/shape-census.cjs, test/rg-regex-census.cjs). The property
// test above is only as wide as the patterns it is handed: the generator that drew them without a shared branch prefix
// over ~8,000 patterns kept RG-RE-ALT-LIFT unemulated and this test green. So: the fixture is exactly the generator's
// draw() (no stale or hand-edited cases), every shape the generator claims was drawn at least its floor, and the RNG
// is unbiased in the bits draw() uses (the moduli are recorded from a real draw, not declared). Red first: the pre-fix
// generator of 4ce7800^ has 0 shared prefixes, 0 nested counted repetitions, 3 captures and 12 lazy repetitions in its
// 300 patterns, and a biased rnd(4), rnd(10), rnd(39); the round-4 generator (float-rounded LCG) passes the shapes and
// fails the RNG (rnd(2), rnd(4), rnd(8), rnd(16), rnd(39) serially correlated).
const gen = require('../scripts/gen-rg-regex-oracle.cjs');
const RC = require('./rg-regex-census.cjs');
function oracleCensus(cases, corpus) {
  const { rec, moduli } = RC.recordModuli(gen.makeRnd());
  gen.draw(rec);
  return [census('rg-regex oracle patterns', RC.PATTERN_SHAPES, cases.map(RC.facts)),
    census('rg-regex oracle corpus', RC.CORPUS_SHAPES, RC.corpusLines(corpus)),
    rngBias('rg-regex oracle RNG', () => gen.makeRnd(), [...moduli].sort((a, b) => a - b))];
}
test('the oracle generator: the fixture is its draw(), every declared shape is drawn, its RNG is unbiased (census)', (t) => {
  const drawn = gen.draw();
  assert.deepStrictEqual(ORACLE.cases.map((c) => [c[0], c[1]]), drawn.cases.map((c) => [c.pattern, c.ignoreCase ? 1 : 0]),
    'test/fixtures/rg-regex-oracle.json is not scripts/gen-rg-regex-oracle.cjs\'s draw(): regenerate it from native');
  assert.strictEqual(ORACLE.corpus, drawn.corpus.toString('base64'), 'the fixture\'s corpus is not draw()\'s');
  const results = oracleCensus(ORACLE.cases, CORPUS);
  for (const r of results) t.diagnostic(r.summary);
  assertCensus(assert, ...results);
});
test('census control: the grammar draws alone (no lift family) fail the shared-prefix floor', () => {
  const [patterns] = oracleCensus(ORACLE.cases.slice(0, 300), CORPUS);
  assert.strictEqual(patterns.counts['shared branch prefix (RG-RE-ALT-LIFT fires)'], 0);
  assert.match(patterns.findings.join('\n'), /shape "shared branch prefix \(RG-RE-ALT-LIFT fires\)" appeared 0 time/);
});
test('the 5 MB bundle line: distinct token runs, the spans its pinned patterns need, an unbiased RNG (census)', (t) => {
  const results = bundleCensus();
  for (const r of results) t.diagnostic(r.summary);
  assertCensus(assert, ...results);
});

// RG-RE-PREFILTER-SUPERSET (rg-regex-prefilter-superset): ugrep, given the prefilter, proposes
// every line ours (= native) selects, over the same corpus, on this host's ugrep (and on every
// ugrep at or above the floor, by the Task 5b runs). Control: a proposer that proposes nothing,
// which the superset check must catch, with no ugrep involved (review M4).
function hostUgrep() {
  if (process.env.CLODE_UGREP) return process.env.CLODE_UGREP;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, process.platform === 'win32' ? 'ugrep.exe' : 'ugrep');
    if (d && fs.existsSync(p)) return p;
  }
  return null;
}
// The lines (their start offsets) ugrep proposes for `prefilter` over the corpus in `dir`.
function ugrepProposes(ugrep, dir, prefilter) {
  const r = spawnSync(ugrep, ['-Y', '--format=%b%~', '-e', prefilter, '--', 'corpus.txt'], { cwd: dir, encoding: 'utf8' });
  if (r.status >= 2 || r.error) return { failed: r.stderr || String(r.error) };
  const proposed = new Set();
  for (const s of r.stdout.split(/\r?\n/)) {
    if (!s) continue;
    const b = Number(s);
    if (b < CORPUS.length) proposed.add(b === 0 ? 0 : CORPUS.lastIndexOf(0x0a, b - 1) + 1);
  }
  return { proposed };
}
function scanSuperset({ ugrep, cases, propose }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-regex-pre-'));
  try {
    fs.writeFileSync(path.join(dir, 'corpus.txt'), CORPUS);
    const findings = [];
    let checked = 0;
    for (const [pattern, ic] of cases) {
      const o = corpusLines(pattern, !!ic);
      if (o.refused) continue;
      const prefilter = o.t.prefilter;
      const r = (propose || ugrepProposes)(ugrep, dir, prefilter);
      if (r.failed) { findings.push(`${JSON.stringify(pattern)}: ugrep failed on ${JSON.stringify(prefilter)}: ${r.failed}`); continue; }
      const { proposed } = r;
      const missing = o.lines.filter(([ls]) => !proposed.has(ls)).map(([ls]) => ls);
      if (missing.length) findings.push(`${JSON.stringify(pattern)}: prefilter ${JSON.stringify(prefilter)} misses lines at ${missing}`);
      checked++;
    }
    return { findings, examined: checked, note: 'prefilters run' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const UGREP = hostUgrep();
guardTests(defineGuard({
  name: 'rg-regex-prefilter-superset',
  floor: ANSWERED_FLOOR,
  read: () => (UGREP ? { ugrep: UGREP, cases: ORACLE.cases } : { skip: 'no ugrep on this host (CLODE_UGREP or PATH)' }),
  scan: scanSuperset,
  control: supersetControl,
}));
function supersetControl() { return { ugrep: UGREP, cases: [['needle', 0], ['\\w+', 0]], propose: () => ({ proposed: new Set() }) }; }

// The control exercises the superset CHECK itself, on any host (review M4): no ugrep runs, the
// proposer proposes nothing, and the finding is a missed line, not a spawn failure.
test('rg-regex-prefilter-superset\'s control fails on a missed line, with no ugrep at all', () => {
  const r = scanSuperset({ ...supersetControl(), ugrep: '/nonexistent/ugrep' });
  assert.ok(r.findings.length >= 1);
  assert.ok(r.findings.every((f) => /misses lines at/.test(f)), r.findings.join('\n'));
});

// RG-RE-REFUSE-COST (review I2): a search is linear, but its constant is states x line length, and
// rg's find_iter over one line can be quadratic; a minified bundle makes a 200 KB line ordinary.
// So one line's matching has a step budget (lineStepBudget: 64 a byte, plus 2^20), and a line past it refuses by name
// rather than stalling the caller (measured under tjs on this Mac: about 5 million steps a second).
test('RG-RE-REFUSE-COST: a line past the step budget refuses by name; ordinary patterns on the same line do not', () => {
  assert.strictEqual(R.lineStepBudget(200000), 64 * 200001 + 2 ** 20);
  const line = Buffer.from('abcdefgh'.repeat(25000));                 // 200 KB, one line, no newline
  const heavy = R.translateRgRegex('[a-z]{1,64}@', {});              // about 39 million steps (review)
  assert.throws(() => R.verifyLine(line, 0, line.length, heavy), (e) => e.name === 'RgRegexRefusal' && e.rule === 'RG-RE-REFUSE-COST');
  for (const p of ['\\w+', 'abc', '(?i)DEF', 'h\\b', 'a.c|zz', '[a-z]+@?']) {
    const t = R.translateRgRegex(p, {});
    assert.doesNotThrow(() => R.verifyLine(line, 0, line.length, t), p);
  }
});

// A minified bundle's one line (5 MB, seeded code-like tokens) and native's answers over it: test/rg-bundle-line.cjs.
test('RG-RE-REFUSE-COST scales with the line: ordinary patterns on a 5 MB minified line are answered as native (native)', () => {
  const line = bundleLine();
  const end = line.length - 1;
  for (const [pattern, n, digest] of NATIVE_BUNDLE_LINE) {
    const t = R.translateRgRegex(pattern, {});
    const m = R.verifyLine(line, 0, end, t).map((x) => [x.start, x.end]);
    assert.strictEqual(m.length, n, pattern);
    assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 20), digest, pattern);
  }
});

// The same search, run in SLICES (what the async twin does between turns of the event loop), finds
// exactly what one uninterrupted run finds: over every oracle pattern, slices of 37 steps.
test('lineVerifier: a search run in slices finds what one run finds (the oracle, 37-step slices)', () => {
  for (const [pattern, ic] of ORACLE.cases) {
    const t = R.translateRgRegex(pattern, { ignoreCase: !!ic });
    if (t.refuse) continue;
    for (let ls = 0; ls < CORPUS.length;) {
      const le = CORPUS.indexOf(0x0a, ls);
      let whole, sliced;
      try { whole = R.verifyLine(CORPUS, ls, le, t); } catch (e) { whole = e.rule; }
      try {
        const v = R.lineVerifier(CORPUS, ls, le, t);
        let r;
        while ((r = v.run(37)) === null) { /* paused */ }
        sliced = r;
      } catch (e) { sliced = e.rule; }
      assert.deepStrictEqual(sliced, whole, `${JSON.stringify(pattern)} at ${ls}`);
      ls = le + 1;
    }
  }
});

// RG-RE-EARLIEST (grep-native Task 6 review I-4): asked only WHETHER a line matches ({ first: true },
// what -l, -c and the standard printer without -o need), the search stops at the first match state
// it reaches. It selects exactly the lines the full find_iter selects (the full one equals native's
// digest on every oracle pattern: rg-regex-oracle-property), at most one match a line, starting on
// the line, in one run or in slices, and it never refuses where the full search answers.
test('RG-RE-EARLIEST: { first: true } selects exactly the lines the full search selects (the oracle)', () => {
  let lines = 0;
  for (const [pattern, ic] of ORACLE.cases) {
    const t = R.translateRgRegex(pattern, { ignoreCase: !!ic });
    if (t.refuse) continue;
    for (let ls = 0; ls < CORPUS.length;) {
      const le = CORPUS.indexOf(0x0a, ls);
      let whole, first, sliced;
      try { whole = R.verifyLine(CORPUS, ls, le, t); } catch (e) { whole = e.rule; }
      try { first = R.verifyLine(CORPUS, ls, le, t, { first: true }); } catch (e) { first = e.rule; }
      try {
        const v = R.lineVerifier(CORPUS, ls, le, t, { first: true });
        let r;
        while ((r = v.run(37)) === null) { /* paused */ }
        sliced = r;
      } catch (e) { sliced = e.rule; }
      const what = `${JSON.stringify(pattern)} at ${ls}`;
      if (typeof first === 'string') assert.strictEqual(whole, first, `${what}: the earliest search refused where the full one answered`);
      else if (typeof whole !== 'string') {
        assert.strictEqual(first.length, whole.length ? 1 : 0, what);
        if (first.length) assert.ok(first[0].start >= ls && first[0].start <= le, what);
      }
      assert.deepStrictEqual(sliced, first, what);
      ls = le + 1; lines++;
    }
  }
  assert.ok(lines > 10000, `${lines} pattern x line pairs`);
});

test('RG-RE-PREFILTER-SUPERSET: the widening rules, stated', () => {
  const pre = (p, o) => R.translateRgRegex(p, o || {}).prefilter;
  assert.strictEqual(pre('needle'), 'needle');
  assert.strictEqual(pre('\\bneedle\\b'), 'needle');                        // assertions widen to nothing
  assert.strictEqual(pre('^$'), '');                                          // '' proposes every line
  assert.strictEqual(pre('[[:alpha:]]+'), '[A-Za-z]');                         // ASCII letter ranges stay; one copy
  assert.strictEqual(pre('\\w+'), '.');                                        // a Unicode class widens to .
  assert.strictEqual(pre('k', { ignoreCase: true }), '(?:K|k|\\x{212a})');    // rg's folding, spelled out
  assert.strictEqual(pre('a|'), '(?:a)?');                                    // an empty branch: optional
  assert.strictEqual(pre('a{3,5}?'), '(?:a){3,5}');                           // a short count stays; laziness widens
  // THE PIECES RULE: never an unbounded repetition; the best piece every match contains
  assert.strictEqual(pre('.{0,100}needle'), 'needle');
  assert.strictEqual(pre('x.*needle'), 'needle');
  assert.strictEqual(pre('import.*from'), 'import');
  assert.strictEqual(pre('a(?:b|.*c)d'), '(?:b|c)d');
  assert.strictEqual(pre('(foo|bar)+baz'), '(?:foo|bar)baz');
  assert.strictEqual(pre('[a-zA-Z_]\\w*\\('), '\\x28');
  // no counted repetition inside another, and no exact part heavier than PREFILTER_WEIGHT
  assert.strictEqual(pre('(?:[^a]{0,16}b){16}'), '(?:.){0,16}b');
  assert.strictEqual(pre('(?:[^,]{0,16},){16}'), '(?:.){0,16}\\x2c');
  assert.strictEqual(pre('(?:.{0,16}){16}needle'), '(?:.){0,16}needle');  // one copy of the outer count's sub
  assert.strictEqual(pre('.{0,32}needle'), 'needle');
  assert.strictEqual(pre('.{0,16}needle'), '(?:.){0,16}needle');
  assert.strictEqual(pre('a.b'), 'a.b');
  assert.strictEqual(pre('x\\.y'), 'x\\x2ey');                                // punctuation as \xHH
});

// ---- the same answers under tjs ---------------------------------------------------------------
test('rg-regex under tjs answers what it answers under node (the rule table and the oracle)', {
  skip: tjsPath() ? false : 'no tjs engine',
}, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-regex-tjs-'));
  try {
    const jobs = [...NATIVE, ...SYNTAX].map(([, file, pattern, flags]) => ({ buf: FIX[file].toString('base64'), pattern, ic: flags.includes('-i') }))
      .concat(ORACLE.cases.map(([pattern, ic]) => ({ buf: ORACLE.corpus, pattern, ic: !!ic })));
    fs.writeFileSync(path.join(base, 'jobs.json'), JSON.stringify(jobs));
    const prog = path.join(base, 'probe.cjs');
    fs.writeFileSync(prog, `
      const R = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'rg-regex.cjs'))});
      const fs = require('fs');
      const jobs = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(base, 'jobs.json'))}, 'utf8'));
      const out = jobs.map(({ buf, pattern, ic }) => {
        const b = Buffer.from(buf, 'base64');
        const t = R.translateRgRegex(pattern, { ignoreCase: ic });
        if (t.refuse) return 'refused ' + t.rule;
        const lines = [];
        try {
          for (let ls = 0; ls < b.length;) {
            let le = b.indexOf(10, ls); if (le === -1) le = b.length;
            const m = R.verifyLine(b, ls, le, t);
            if (m.length) lines.push([ls, m.map((x) => [x.start, x.end])]);
            ls = le + 1;
          }
        } catch (e) { if (e.name === 'RgRegexRefusal') return 'refused ' + e.rule; throw e; }
        return [t.prefilter, lines];
      });
      fs.writeFileSync(${JSON.stringify(path.join(base, 'out.json'))}, JSON.stringify(out));
    `);
    const res = runLoader(prog, [], { timeout: 300000 });
    assert.strictEqual(res.status, 0, res.stderr.slice(0, 2000));
    const got = JSON.parse(fs.readFileSync(path.join(base, 'out.json'), 'utf8'));
    const want = jobs.map(({ buf, pattern, ic }) => {
      const b = Buffer.from(buf, 'base64');
      const t = R.translateRgRegex(pattern, { ignoreCase: ic });
      if (t.refuse) return 'refused ' + t.rule;
      const lines = [];
      try {
        for (let ls = 0; ls < b.length;) {
          let le = b.indexOf(10, ls); if (le === -1) le = b.length;
          const m = R.verifyLine(b, ls, le, t);
          if (m.length) lines.push([ls, m.map((x) => [x.start, x.end])]);
          ls = le + 1;
        }
      } catch (e) { if (e.name === 'RgRegexRefusal') return 'refused ' + e.rule; throw e; }
      return [t.prefilter, lines];
    });
    assert.strictEqual(got.length, want.length);
    for (let i = 0; i < want.length; i++) assert.deepStrictEqual(got[i], want[i], JSON.stringify(jobs[i].pattern));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
